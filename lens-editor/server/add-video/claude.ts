import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { claudeSessionPool } from './queue';

// Transcripts longer than this are split into chunks and processed in parallel
const CHUNK_WORD_THRESHOLD = 6_000;
const CHUNK_TARGET_WORDS = 5_000;

// Runaway-cost guard only — sized to the chunk limits above. Measured
// 2026-08-09: a 4.4K-word single-chunk video cost $1.21 with prompt caching
// (sonnet-5, thinking-heavy), so the old $2.00 cap left almost no headroom
// for chunks near CHUNK_WORD_THRESHOLD or cache-miss runs.
const MAX_BUDGET_USD = '4.00';

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
7. Do NOT remove content unless it's a filler word (uh, um, like, you know).
8. Preserve the meaning exactly.`;
}

/** Build CLI arguments for claude -p */
export function buildClaudeArgs(workDir: string): string[] {
  return [
    '-p',
    buildPrompt(workDir),
    '--allowedTools',
    'Read,Write',
    '--max-turns',
    '30',
    '--max-budget-usd',
    MAX_BUDGET_USD,
    '--model',
    'sonnet',
    '--output-format',
    'json',
  ];
}

/** Single-line clip for error/log messages. */
export const clip = (s: string, n = 300): string =>
  s.replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Summarize a Claude run for error messages and logs. With
 * --output-format json the useful error detail is the result JSON on stdout
 * (subtype, is_error, result text) — stderr is usually empty, which
 * previously made failures undiagnosable ("Claude exited with code 1: ").
 */
export function summarizeClaudeOutcome(result: {
  stdout: string;
  stderr: string;
}): string {
  const stdout = result.stdout.trim();
  if (stdout.startsWith('{')) {
    try {
      const parsed = JSON.parse(stdout) as {
        subtype?: string;
        is_error?: boolean;
        result?: string;
        total_cost_usd?: number;
        num_turns?: number;
      };
      const parts: string[] = [];
      if (parsed.subtype) parts.push(`subtype=${parsed.subtype}`);
      if (parsed.is_error !== undefined) parts.push(`is_error=${parsed.is_error}`);
      if (parsed.total_cost_usd !== undefined)
        parts.push(`cost=$${parsed.total_cost_usd.toFixed(2)}`);
      if (parsed.num_turns !== undefined) parts.push(`turns=${parsed.num_turns}`);
      if (parsed.result) parts.push(`result: ${clip(parsed.result)}`);
      if (parts.length > 0) return parts.join(' ');
    } catch {
      // fall through to raw tails
    }
  }
  const tails: string[] = [];
  if (result.stderr.trim()) tails.push(`stderr: ${clip(result.stderr)}`);
  if (stdout) tails.push(`stdout: ${clip(stdout)}`);
  return tails.join(' ') || 'no output on stdout or stderr';
}

/** Spawn Claude Code and wait for completion. Acquires a session from the global pool. */
export async function spawnClaude(
  workDir: string,
  timeoutMs: number,
  argsOverride?: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  await claudeSessionPool.acquire();
  return new Promise((resolve, reject) => {
    const args = argsOverride ?? buildClaudeArgs(workDir);
    const spawnClaudeProc = () =>
      spawn('claude', args, {
        cwd: workDir,
        stdio: ['ignore', 'pipe', 'pipe'],
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
      claudeSessionPool.release();
      fn();
    };

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      finish(() => reject(new Error(`Claude timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    proc.on('close', (code) => {
      finish(() => {
        // Log failures here so every spawnClaude consumer (add-video and
        // add-article) gets the stdout JSON detail in the server logs.
        if (code !== 0) {
          console.warn(
            `[claude] exited ${code}: ${summarizeClaudeOutcome({ stdout, stderr })}`
          );
        }
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
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
  timeoutMs: number = 900_000
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const rawText = await fs.readFile(path.join(workDir, 'raw.txt'), 'utf-8');
  const wordCount = rawText.split(/\s+/).length;

  if (wordCount <= CHUNK_WORD_THRESHOLD) {
    // Short transcript: single Claude call
    return spawnClaude(workDir, timeoutMs);
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
  const results = await Promise.all(
    chunkDirs.map((dir) => spawnClaude(dir, timeoutMs))
  );

  const failed = results.find((r) => r.exitCode !== 0);
  if (failed) return failed;

  // Concatenate corrected chunks in order. A chunk that exited 0 without
  // writing its file (e.g. the model answered in chat text instead of using
  // Write) must surface that chunk's final message, not a bare ENOENT.
  const correctedParts: string[] = [];
  for (let i = 0; i < chunkDirs.length; i++) {
    let corrected: string;
    try {
      corrected = await fs.readFile(
        path.join(chunkDirs[i], 'corrected.txt'),
        'utf-8'
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          `Chunk ${i + 1}/${chunkDirs.length} exited 0 but wrote no corrected.txt — ${summarizeClaudeOutcome(results[i])}`
        );
      }
      throw err;
    }
    correctedParts.push(corrected.trim());
  }

  await fs.writeFile(
    path.join(workDir, 'corrected.txt'),
    correctedParts.join('\n\n')
  );

  // Synthesize a summary envelope so the caller's success log carries the
  // chunk count instead of "no output on stdout or stderr".
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      subtype: 'success',
      result: `${chunkDirs.length} chunks processed`,
    }),
    stderr: '',
  };
}
