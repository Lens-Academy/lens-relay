import { spawn } from 'node:child_process';

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
    '--output-format',
    'json',
  ];
}

/** Spawn Claude Code and wait for completion. Returns exit code. */
export function runClaude(
  workDir: string,
  timeoutMs: number = 300_000
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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
      reject(new Error(`Claude timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
