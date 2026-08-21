import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { VideoPayload } from "./types";
import { extractWords, toPlainText, flattenToWords } from "./transcript";
import { alignWords } from "./alignment";
import {
  generateMarkdown,
  generateTimestampsJson,
  generateFilenameBase,
} from "./export";
import { runClaude } from "./claude";
import {
  createRelayDoc,
  updateRelayDoc,
  relayTranscriptFolder,
  editorOpenUrl,
} from "./relay-docs";
import { maybeCreateLens } from "../lens-doc";

const WORK_BASE = "/tmp/transcripts";
const TIMEOUT_MS = 1_200_000; // 20 minutes
// Deadline for a whole video-import job (article queue): Claude's own 20-min
// ceiling above, plus the 8-min Claude-pool acquire timeout, plus margin for
// fetch + relay writes. Derived here so a TIMEOUT_MS change moves it too.
export const VIDEO_JOB_TIMEOUT_MS = TIMEOUT_MS + 15 * 60_000;

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
  /** Fired as soon as the transcript's editor URL is derived, before any
   *  writes -- the single source of the filename convention, so callers can
   *  surface a link without re-deriving the path. */
  onRelayUrl?: (relayUrl: string) => void;
}

/**
 * Core video import: raw transcript payload → formatted transcript +
 * timestamps + (optionally) a lens in the relay. Driven by the article
 * importer's YouTube-URL jobs (add-article/pipeline).
 */
export async function importVideo(
  jobId: string,
  payload: VideoPayload,
  createdAt: string,
  opts: VideoImportOptions = {},
): Promise<void> {
  const { createLens = true, signal, onStage, onRelayUrl } = opts;
  const setStage = (stage: string) => {
    signal?.throwIfAborted();
    onStage?.(stage);
  };
  const workDir = path.join(WORK_BASE, jobId);
  const relayFolder = relayTranscriptFolder();
  const filenameBase = generateFilenameBase(payload.channel, payload.title);
  const mdPath = `${relayFolder}/${filenameBase}.md`;
  const jsonPath = `${relayFolder}/${filenameBase}.timestamps.json`;
  onRelayUrl?.(editorOpenUrl(mdPath));
  let placeholderWritten = false;
  let finalWritten = false;

  try {
    console.log(`[add-video] Processing "${payload.title}" (${payload.video_id})`);
    // 1. Create work directory and write the plain-text transcript
    setStage("preparing");
    await fs.mkdir(workDir, { recursive: true });
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
    const result = await runClaude(workDir, TIMEOUT_MS, signal);
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

    // 7. Replace the placeholder with the final markdown and create the
    //    timestamps JSON -- independent paths, written concurrently
    setStage("writing");
    await Promise.all([
      updateRelayDoc(mdPath, placeholderContent, finalMd, signal),
      createRelayDoc(jsonPath, JSON.stringify(timestamps, null, 2), signal),
    ]);
    finalWritten = true;

    // 9. Auto-create a lens wrapping the transcript (Asana 1215689584721257).
    //    Opt out with createLens=false; a lens failure must not fail the import.
    //    Deliberately NOT an abort point: the transcript is complete, and a
    //    cancel arriving here must not route into the failure path.
    if (createLens) {
      onStage?.("creating-lens");
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
  } catch (err) {
    // Update placeholder to show failure -- but never leave a failure doc for
    // a job that wrote nothing (a pre-placeholder failure has no reader), and
    // NEVER overwrite a fully written transcript (e.g. a cancel that lands
    // during lens creation).
    if (placeholderWritten && !finalWritten) {
      const failedContent = generateMarkdown({
        title: payload.title,
        channel: payload.channel,
        // youtu.be form on purpose: the relay's video-id dedup scan matches
        // "watch?v=<id>" / "/shorts/<id>" in doc heads, and a failure doc
        // that matched would block every resubmission of this video until a
        // human deleted the doc. youtu.be links stay clickable but invisible
        // to that scan, so retrying just overwrites the failure doc.
        url: `https://youtu.be/${payload.video_id}`,
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
