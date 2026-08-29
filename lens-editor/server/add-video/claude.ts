import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { claudeSessionPool } from './claude-pool';

// Transcripts longer than this are split into chunks and processed in parallel
const CHUNK_WORD_THRESHOLD = 6_000;
const CHUNK_TARGET_WORDS = 5_000;

/** Build the formatting prompt for Claude */
export function buildPrompt(workDir: string): string {
  return `You are formatting a YouTube video transcript. Your task:

1. Read the file ${workDir}/raw.txt
2. Format it with:
   - Proper punctuation (periods, commas, question marks)
   - Capitalization of sentence starts and proper nouns
   - Paragraph breaks at natural topic boundaries (use blank lines)
3. Fix transcription errors:
   - Homophones: "there" → "their"
   - Similar sounds: "deep earning" → "deep learning"
   - Phonetic mishearings: "new roll" → "neural"
   - Split/merged words: "data set" → "dataset"
   - Names and acronyms: fix obvious misspellings
   - Only fix if a reasonable person would recognize what was meant
4. Write the result to ${workDir}/corrected.txt
5. The output must be PLAIN TEXT only — no markdown formatting, no headers, no bullet points, no bold/italic markers.
6. Do NOT add any content that wasn't in the original transcript.
7. Do NOT remove content unless it is one of: a filler sound (uh, um, er, ah, mm, hmm), a discourse marker ("you know", "sort of", "kind of", "I mean"), a speaker-change marker (>>), or an immediately repeated word ("the the" -> "the"). Keep every other word, including "like".
8. Preserve the meaning exactly.`;
}

/** Build CLI arguments for claude -p */
export function buildClaudeArgs(workDir: string): string[] {
  return [
    '-p',
    buildPrompt(workDir),
    '--allowedTools',
    'Read,Write',
    // No --max-turns / --max-budget-usd: a cleanup pass that stops halfway
    // through a long transcript is worse than one that costs more. The
    // runaway guard is the wall-clock timeout in spawnClaude, which bounds
    // the process regardless of turns or spend.
    '--model',
    'opus',
    '--output-format',
    'json',
  ];
}

/** Spawn Claude Code and wait for completion. Acquires a session from the global pool. */
export async function spawnClaude(
  workDir: string,
  timeoutMs: number,
  argsOverride?: string[],
  signal?: AbortSignal,
  envOverride?: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  await claudeSessionPool.acquire(undefined, signal);
  // Cancellation while queued is final: do not turn a newly available slot
  // into a Claude process after the owning job has already failed.
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const args = argsOverride ?? buildClaudeArgs(workDir);
    const env = { ...process.env, ...envOverride };
    // The Claude CLI requires a supported SHELL. Docker's non-interactive
    // runtime does not set one, and Alpine's BusyBox shell is insufficient.
    if (process.platform !== 'win32' && !env.SHELL) env.SHELL = '/bin/bash';
    const spawnClaudeProc = () =>
      spawn('claude', args, {
        cwd: workDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        // A Claude CLI turn may spawn helpers. Give it a process group so a
        // cancelled article job cannot leave descendants running.
        detached: process.platform !== 'win32',
      });
    let proc: ReturnType<typeof spawnClaudeProc>;
    try {
      proc = spawnClaudeProc();
    } catch (err) {
      // A synchronous spawn failure must still release the slot — this was a
      // permanent-leak path (each leak silently shrinks the pool cap).
      claudeSessionPool.release();
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let stdout = '';
    let stderr = '';
    // Guard against double-settle: a timeout SIGTERM still fires 'close' later,
    // which would otherwise release the pool slot twice (corrupting the cap).
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      claudeSessionPool.release();
      fn();
    };

    const terminateGroup = () => {
      if (process.platform !== 'win32' && proc.pid) {
        try { process.kill(-proc.pid, 'SIGTERM'); } catch { proc.kill('SIGTERM'); }
        setTimeout(() => {
          try { process.kill(-proc.pid!, 'SIGKILL'); } catch { /* already exited */ }
        }, 5_000).unref();
      } else {
        proc.kill('SIGTERM');
      }
    };

    const onAbort = () => {
      terminateGroup();
      finish(() => reject(signal?.reason ?? new Error('Claude review aborted')));
    };
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      terminateGroup();
      finish(() => reject(new Error(`Claude timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    proc.on('close', (code) => {
      finish(() => resolve({ exitCode: code ?? 1, stdout, stderr }));
    });

    proc.on('error', (err) => {
      finish(() => reject(err));
    });
  });
}

/**
 * Split text into chunks at paragraph boundaries, targeting ~CHUNK_TARGET_WORDS per chunk.
 */
export function splitIntoChunks(text: string): string[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current: string[] = [];
  let currentWords = 0;

  for (const para of paragraphs) {
    const paraWords = para.split(/\s+/).length;
    if (currentWords + paraWords > CHUNK_TARGET_WORDS && current.length > 0) {
      chunks.push(current.join('\n\n'));
      current = [];
      currentWords = 0;
    }
    current.push(para);
    currentWords += paraWords;
  }
  if (current.length > 0) {
    chunks.push(current.join('\n\n'));
  }

  return chunks;
}

/**
 * Run Claude on the transcript. For short transcripts, runs a single process.
 * For long transcripts (>10K words), splits into chunks and runs in parallel.
 */
export async function runClaude(
  workDir: string,
  timeoutMs: number = 900_000,
  signal?: AbortSignal
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const rawText = await fs.readFile(path.join(workDir, 'raw.txt'), 'utf-8');
  const wordCount = rawText.split(/\s+/).length;

  if (wordCount <= CHUNK_WORD_THRESHOLD) {
    // Short transcript: single Claude call
    return spawnClaude(workDir, timeoutMs, undefined, signal);
  }

  // Long transcript: split into chunks, process in parallel
  const chunks = splitIntoChunks(rawText);
  const chunkDirs: string[] = [];

  // Create chunk work directories
  for (let i = 0; i < chunks.length; i++) {
    const chunkDir = path.join(workDir, `chunk-${i}`);
    await fs.mkdir(chunkDir, { recursive: true });
    await fs.writeFile(path.join(chunkDir, 'raw.txt'), chunks[i]);
    chunkDirs.push(chunkDir);
  }

  // Process all chunks concurrently — the global session pool (max 3)
  // limits how many Claude processes run at once. FIFO ordering.
  //
  // Chunks past the first pool wave sit in the acquire queue. If an early
  // chunk fails (or the job is cancelled), abort the rest so still-queued
  // waiters leave immediately and running siblings are SIGTERM'd, instead of
  // holding pool slots for up to timeoutMs while their result is already moot.
  const chunkAbort = new AbortController();
  const onOuterAbort = () => chunkAbort.abort(signal!.reason);
  if (signal) {
    if (signal.aborted) chunkAbort.abort(signal.reason);
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  let results: Array<{ exitCode: number; stdout: string; stderr: string }>;
  try {
    results = await Promise.all(
      chunkDirs.map((dir) =>
        spawnClaude(dir, timeoutMs, undefined, chunkAbort.signal).then((r) => {
          // Carry the real failure into the abort reason, so a sibling's
          // rejection (which is what Promise.all surfaces) still names the
          // actual Claude error rather than a generic "aborted".
          if (r.exitCode !== 0) {
            chunkAbort.abort(
              new Error(
                `Transcript chunk failed (exit ${r.exitCode}): ${r.stderr.slice(0, 300)}`
              )
            );
          }
          return r;
        })
      )
    );
  } finally {
    signal?.removeEventListener('abort', onOuterAbort);
  }

  const failed = results.find((r) => r.exitCode !== 0);
  if (failed) return failed;

  // Concatenate corrected chunks in order
  const correctedParts: string[] = [];
  for (const dir of chunkDirs) {
    const corrected = await fs.readFile(
      path.join(dir, 'corrected.txt'),
      'utf-8'
    );
    correctedParts.push(corrected.trim());
  }

  await fs.writeFile(
    path.join(workDir, 'corrected.txt'),
    correctedParts.join('\n\n')
  );

  return { exitCode: 0, stdout: '', stderr: '' };
}
