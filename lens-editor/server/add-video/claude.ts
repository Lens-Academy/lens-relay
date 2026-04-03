import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { claudeSessionPool } from './queue';

// Transcripts longer than this are split into chunks and processed in parallel
const CHUNK_WORD_THRESHOLD = 10_000;
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
    '2.00',
    '--model',
    'sonnet',
    '--output-format',
    'json',
  ];
}

/** Spawn Claude Code and wait for completion. Acquires a session from the global pool. */
export async function spawnClaude(
  workDir: string,
  timeoutMs: number
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  await claudeSessionPool.acquire();
  return new Promise((resolve, reject) => {
    const args = buildClaudeArgs(workDir);
    const proc = spawn('claude', args, {
      cwd: workDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      claudeSessionPool.release();
      reject(new Error(`Claude timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      claudeSessionPool.release();
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      claudeSessionPool.release();
      reject(err);
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

  // Process all chunks concurrently — the global session pool limits
  // how many Claude processes run at once (max 3 across all videos)
  const results = await Promise.all(
    chunkDirs.map((dir) => spawnClaude(dir, timeoutMs))
  );

  // Check for failures
  const failed = results.find((r) => r.exitCode !== 0);
  if (failed) {
    return failed;
  }

  // Concatenate corrected chunks
  const correctedParts: string[] = [];
  for (const dir of chunkDirs) {
    const corrected = await fs.readFile(
      path.join(dir, 'corrected.txt'),
      'utf-8'
    );
    correctedParts.push(corrected.trim());
  }

  // Write concatenated result
  await fs.writeFile(
    path.join(workDir, 'corrected.txt'),
    correctedParts.join('\n\n')
  );

  return { exitCode: 0, stdout: '', stderr: '' };
}
