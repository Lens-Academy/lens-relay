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
const RELAY_FOLDER = process.env.RELAY_TRANSCRIPT_FOLDER || 'Lens Edu/video_transcripts';
const TIMEOUT_MS = 900_000; // 15 minutes (a 7K word transcript takes ~10 min)

/**
 * Estimate processing time in minutes based on word count.
 * Based on real-world data: 7K words ≈ 10 min with Sonnet.
 * Chunked transcripts (>10K words) process chunks sequentially
 * (for fair session sharing), so time scales linearly with chunks.
 */
function estimateProcessingTime(wordCount: number): number {
  const WORDS_PER_MINUTE = 700; // ~7K words in 10 min
  return Math.max(1, Math.ceil(wordCount / WORDS_PER_MINUTE));
}

export async function processVideo(
  job: Job & { payload: VideoPayload }
): Promise<void> {
  const workDir = path.join(WORK_BASE, job.id);
  const filenameBase = generateFilenameBase(job.channel, job.title, job.video_id);
  const mdPath = `${RELAY_FOLDER}/${filenameBase}.md`;
  const jsonPath = `${RELAY_FOLDER}/${filenameBase}.timestamps.json`;

  // Set relay_url to a resolvable editor URL
  const editorBase = process.env.EDITOR_BASE_URL || 'https://editor.lensacademy.org';
  job.relay_url = `${editorBase}/open/${encodeURI(mdPath)}`;

  try {
    // 1. Create work directory and write raw files
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(
      path.join(workDir, 'raw.json'),
      JSON.stringify(job.payload.transcript_raw, null, 2)
    );
    const plainText = toPlainText(job.payload.transcript_raw);
    await fs.writeFile(path.join(workDir, 'raw.txt'), plainText);

    // 2. Create placeholder doc in Relay with time estimate
    const wordCount = plainText.split(/\s+/).length;
    const estimateMin = estimateProcessingTime(wordCount);
    const placeholderBody = [
      `*This transcript is being processed.*`,
      ``,
      `**${wordCount.toLocaleString()} words** — estimated processing time: **~${estimateMin} minutes**.`,
      ``,
      `If you submitted multiple videos, they share a pool of 3 concurrent sessions and will be processed as capacity allows.`,
      ``,
      `Queued at: ${new Date(job.created_at).toLocaleString()}`,
    ].join('\n');
    const placeholderContent = generateMarkdown({
      title: job.title,
      channel: job.channel,
      url: job.url,
      video_id: job.video_id,
      body: placeholderBody,
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

    // 8. Create timestamps JSON in Relay
    await createRelayDoc(jsonPath, JSON.stringify(timestamps, null, 2));
  } catch (err) {
    // Update placeholder to show failure
    const failedContent = generateMarkdown({
      title: job.title,
      channel: job.channel,
      url: job.url,
      video_id: job.video_id,
      body: `*Transcript processing failed.* You can resubmit this video from the Add Video page.\n\nFailed at: ${new Date().toISOString()}`,
    });
    await updateRelayDoc(mdPath, '', failedContent).catch(() => {});
    throw err;
  } finally {
    // 9. Clean up work directory
    await fs.rm(workDir, { recursive: true }).catch(() => {});
  }
}
