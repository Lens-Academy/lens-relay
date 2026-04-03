import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Job, VideoPayload } from './types';
import { extractWords, toPlainText, flattenToWords } from './transcript';
import { alignWords } from './alignment';
import {
  generateMarkdown,
  generateTimestampsJson,
  generateFilenameBase,
} from './export';
import { runClaude } from './claude';
import { createRelayDoc, updateRelayDoc } from './relay-docs';

const WORK_BASE = '/tmp/transcripts';
const RELAY_FOLDER = 'Lens Edu/video_transcripts';
const TIMEOUT_MS = 300_000; // 5 minutes
// Timestamps saved locally (relay MCP create tool only accepts .md files)
const TIMESTAMPS_DIR = '/tmp/transcripts/timestamps';

export async function processVideo(
  job: Job & { payload: VideoPayload }
): Promise<void> {
  const workDir = path.join(WORK_BASE, job.id);
  const filenameBase = generateFilenameBase(job.channel, job.title, job.video_id);
  const mdPath = `${RELAY_FOLDER}/${filenameBase}.md`;

  // Set relay_url immediately so it's available in the queued response
  job.relay_url = mdPath;

  try {
    // 1. Create work directory and write raw files
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(
      path.join(workDir, 'raw.json'),
      JSON.stringify(job.payload.transcript_raw, null, 2)
    );
    const plainText = toPlainText(job.payload.transcript_raw);
    await fs.writeFile(path.join(workDir, 'raw.txt'), plainText);

    // 2. Create placeholder doc in Relay
    const placeholderContent = generateMarkdown({
      title: job.title,
      channel: job.channel,
      url: job.url,
      video_id: job.video_id,
      body: `*This transcript is being processed. Please check back shortly.*\n\nQueued at: ${job.created_at}`,
    });
    await createRelayDoc(mdPath, placeholderContent);

    // 3. Run Claude for formatting
    const result = await runClaude(workDir, TIMEOUT_MS);
    if (result.exitCode !== 0) {
      throw new Error(
        `Claude exited with code ${result.exitCode}: ${result.stderr.slice(0, 500)}`
      );
    }

    // 4. Read corrected text
    const correctedText = await fs.readFile(
      path.join(workDir, 'corrected.txt'),
      'utf-8'
    );

    // 5. Align timestamps
    // Flatten multi-word entries (sentence-level) into individual words for alignment
    const originalWords = flattenToWords(
      extractWords(job.payload.transcript_raw)
    );
    const correctedWords = correctedText.trim().split(/\s+/);
    const aligned = alignWords(originalWords, correctedWords);

    // 6. Generate final content
    const finalMd = generateMarkdown({
      title: job.title,
      channel: job.channel,
      url: job.url,
      video_id: job.video_id,
      body: correctedText.trim(),
    });
    const timestamps = generateTimestampsJson(aligned);

    // 7. Update placeholder with final markdown
    await updateRelayDoc(mdPath, placeholderContent, finalMd);

    // 8. Save timestamps locally (relay create tool only accepts .md)
    await fs.mkdir(TIMESTAMPS_DIR, { recursive: true });
    await fs.writeFile(
      path.join(TIMESTAMPS_DIR, `${filenameBase}.timestamps.json`),
      JSON.stringify(timestamps, null, 2)
    );
  } finally {
    // 9. Clean up work directory (but not timestamps)
    await fs.rm(workDir, { recursive: true }).catch(() => {});
  }
}
