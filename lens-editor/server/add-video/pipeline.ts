import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Job, VideoPayload } from "./types";
import { extractWords, toPlainText, flattenToWords } from "./transcript";
import { alignWords } from "./alignment";
import {
  generateMarkdown,
  generateTimestampsJson,
  generateFilenameBase,
} from "./export";
import { runClaude } from "./claude";
import { createRelayDoc, updateRelayDoc } from "./relay-docs";
import { maybeCreateLens } from "../lens-doc";

const WORK_BASE = "/tmp/transcripts";
const RELAY_FOLDER =
  process.env.RELAY_TRANSCRIPT_FOLDER || "Lens Edu/video_transcripts";
const TIMEOUT_MS = 1_200_000; // 20 minutes

/**
 * Estimate processing time in minutes based on word count.
 * Based on real-world data: 7K words ≈ 10 min with Sonnet.
 * Chunked transcripts (>10K words) process in parallel (max 3 concurrent).
 */
function estimateProcessingTime(wordCount: number): number {
  const WORDS_PER_MINUTE = 700; // ~7K words in 10 min
  const CHUNK_SIZE = 5_000;
  const MAX_CONCURRENT = 3;

  if (wordCount <= 10_000) {
    return Math.max(1, Math.ceil(wordCount / WORDS_PER_MINUTE));
  }
  const numChunks = Math.ceil(wordCount / CHUNK_SIZE);
  const numBatches = Math.ceil(numChunks / MAX_CONCURRENT);
  const timePerChunk = Math.ceil(CHUNK_SIZE / WORDS_PER_MINUTE);
  return numBatches * timePerChunk;
}

export interface VideoImportOptions {
  /** Also auto-create a lens wrapping the transcript (default true). */
  createLens?: boolean;
  /** Checked at stage boundaries so a cancelled job actually stops. */
  signal?: AbortSignal;
  /** Stage reporting for status UIs (article-queue jobs show job.stage). */
  onStage?: (stage: string) => void;
}

/** Editor URL a transcript at this relay path opens under. */
export function transcriptRelayUrl(mdPath: string): string {
  const editorBase =
    process.env.EDITOR_BASE_URL || "https://editor.lensacademy.org";
  return `${editorBase}/open/${encodeURI(mdPath)}`;
}

/**
 * Core video import: raw transcript payload → formatted transcript +
 * timestamps + (optionally) a lens in the relay. Used by both the bookmarklet
 * queue (processVideo below) and YouTube-URL jobs from the article importer.
 */
export async function importVideo(
  jobId: string,
  payload: VideoPayload,
  createdAt: string,
  opts: VideoImportOptions = {},
): Promise<{ mdPath: string; relayUrl: string }> {
  const { createLens = true, signal, onStage } = opts;
  const setStage = (stage: string) => {
    signal?.throwIfAborted();
    onStage?.(stage);
  };
  const workDir = path.join(WORK_BASE, jobId);
  const filenameBase = generateFilenameBase(payload.channel, payload.title);
  const mdPath = `${RELAY_FOLDER}/${filenameBase}.md`;
  const jsonPath = `${RELAY_FOLDER}/${filenameBase}.timestamps.json`;
  const relayUrl = transcriptRelayUrl(mdPath);
  let placeholderWritten = false;

  try {
    console.log(`[add-video] Processing "${payload.title}" (${payload.video_id})`);
    // 1. Create work directory and write raw files
    setStage("preparing");
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(
      path.join(workDir, "raw.json"),
      JSON.stringify(payload.transcript_raw, null, 2),
    );
    const plainText = toPlainText(payload.transcript_raw);
    await fs.writeFile(path.join(workDir, "raw.txt"), plainText);

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
      `Queued at: ${new Date(createdAt).toLocaleString()}`,
    ].join("\n");
    const placeholderContent = generateMarkdown({
      title: payload.title,
      channel: payload.channel,
      url: payload.url,
      body: placeholderBody,
    });
    await createRelayDoc(mdPath, placeholderContent, signal);
    placeholderWritten = true;

    // 3. Run Claude for formatting
    setStage("formatting");
    console.log(`[add-video] Running Claude on ${wordCount} words...`);
    const result = await runClaude(workDir, TIMEOUT_MS);
    if (result.exitCode !== 0) {
      throw new Error(
        `Claude exited with code ${result.exitCode}: ${result.stderr.slice(0, 500)}`,
      );
    }

    console.log(`[add-video] Claude finished (exit ${result.exitCode})`);
    // 4. Read corrected text
    setStage("aligning");
    const correctedText = await fs.readFile(
      path.join(workDir, "corrected.txt"),
      "utf-8",
    );

    // 5. Align timestamps
    // Flatten multi-word entries (sentence-level) into individual words for alignment
    const originalWords = flattenToWords(
      extractWords(payload.transcript_raw),
    );
    const correctedWords = correctedText.trim().split(/\s+/);
    const aligned = alignWords(originalWords, correctedWords);

    // 6. Generate final content
    const finalMd = generateMarkdown({
      title: payload.title,
      channel: payload.channel,
      url: payload.url,
      body: correctedText.trim(),
    });
    const timestamps = generateTimestampsJson(aligned);

    // 7. Update placeholder with final markdown
    setStage("writing");
    await updateRelayDoc(mdPath, placeholderContent, finalMd);

    // 8. Create timestamps JSON in Relay
    await createRelayDoc(jsonPath, JSON.stringify(timestamps, null, 2), signal);

    // 9. Auto-create a lens wrapping the transcript (Asana 1215689584721257).
    //    Opt out with createLens=false; a lens failure must not fail the import.
    if (createLens) {
      setStage("creating-lens");
      try {
        const lensPath = await maybeCreateLens({
          docPath: mdPath,
          title: payload.title,
          segment: "Video",
        });
        console.log(
          lensPath
            ? `[add-video] Created lens ${lensPath}`
            : `[add-video] Lens already exists for ${mdPath}, skipped`,
        );
      } catch (lensErr) {
        console.warn(
          `[add-video] Lens creation failed (transcript saved): ${lensErr}`,
        );
      }
    }
    return { mdPath, relayUrl };
  } catch (err) {
    // Update placeholder to show failure — but never leave a failure doc for
    // a job that wrote nothing (a pre-placeholder failure has no reader).
    if (placeholderWritten) {
      const failedContent = generateMarkdown({
        title: payload.title,
        channel: payload.channel,
        url: payload.url,
        body: `*Transcript processing failed.* You can resubmit this video.\n\nFailed at: ${new Date().toISOString()}`,
      });
      await updateRelayDoc(mdPath, "", failedContent).catch(() => {});
    }
    throw err;
  } finally {
    // Clean up work directory
    await fs.rm(workDir, { recursive: true }).catch(() => {});
  }
}

export async function processVideo(
  job: Job & { payload: VideoPayload },
): Promise<void> {
  // Set relay_url up front so the queue can report it while processing.
  const filenameBase = generateFilenameBase(job.channel, job.title);
  job.relay_url = transcriptRelayUrl(`${RELAY_FOLDER}/${filenameBase}.md`);
  await importVideo(job.id, job.payload, job.created_at, {
    createLens: job.createLens !== false,
  });
}
