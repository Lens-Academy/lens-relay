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
import { verifyCorrection } from "./verify";
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
  let docWritten = false;

  try {
    console.log(`[add-video] Processing "${payload.title}" (${payload.video_id})`);
    // 1. Create work directory and write the plain-text transcript
    setStage("preparing");
    await fs.mkdir(workDir, { recursive: true });
    const plainText = toPlainText(payload.transcript_raw);
    await fs.writeFile(path.join(workDir, "raw.txt"), plainText);

    // Flatten multi-word entries (sentence-level) into individual words: these
    // carry the real caption timings and back both the phase-1 sidecar and the
    // phase-2 alignment.
    const originalWords = flattenToWords(extractWords(payload.transcript_raw));
    const wordCount = plainText.split(/\s+/).length;

    // 2. PHASE 1 -- publish the transcript immediately.
    //    The text YouTube returns is already the real transcript, so there is
    //    no reason to make readers wait behind an LLM pass: the doc, its
    //    timestamps and its lens all land now, and the cleanup pass (if any)
    //    edits them in place afterwards.
    setStage("publishing");
    const publishedContent = generateMarkdown({
      title: payload.title,
      channel: payload.channel,
      url: payload.url,
      body: plainText.trim(),
    });
    await Promise.all([
      createRelayDoc(mdPath, publishedContent, signal),
      createRelayDoc(
        jsonPath,
        JSON.stringify(generateTimestampsJson(originalWords), null, 2),
        signal,
      ),
    ]);
    // The transcript on disk is now complete and faithful; nothing after this
    // point may replace it with a failure doc.
    docWritten = true;

    // 3. Auto-create a lens wrapping the transcript (Asana 1215689584721257).
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

    // 4. Human-written caption tracks already carry punctuation, casing and
    //    correct spelling, so the cleanup pass has nothing to fix -- measured
    //    on real videos it returned the input essentially unchanged. Skip it:
    //    the import is done, at a fraction of the latency and cost.
    if (payload.transcript_type === "sentence_level") {
      console.log(
        `[add-video] Human captions for "${payload.title}" — published as-is, skipping cleanup`,
      );
      return;
    }

    // 5. PHASE 2 -- clean up the auto-generated transcript in the background.
    //    Everything from here is best-effort: the reader already has a
    //    faithful transcript, so a failed or untrustworthy cleanup leaves the
    //    published one alone instead of failing the import.
    setStage("polishing");
    console.log(`[add-video] Running Claude on ${wordCount} words...`);
    try {
      const result = await runClaude(workDir, TIMEOUT_MS, signal);
      if (result.exitCode !== 0) {
        throw new Error(
          `Claude exited with code ${result.exitCode}: ${result.stderr.slice(0, 500)}`,
        );
      }
      console.log(`[add-video] Claude finished (exit ${result.exitCode})`);

      const correctedText = await fs.readFile(
        path.join(workDir, "corrected.txt"),
        "utf-8",
      );
      const correctedWords = correctedText.trim().split(/\s+/);

      // Enforce what the prompt only asks for. A cleanup that paraphrases,
      // hallucinates or silently loses a chunk is worse than no cleanup.
      const verdict = verifyCorrection(plainText.trim().split(/\s+/), correctedWords);
      if (!verdict.ok) {
        console.warn(
          `[add-video] Cleanup rejected for "${payload.title}": ${verdict.reason} — keeping the published transcript`,
        );
        onStage?.("polish-rejected");
        return;
      }

      setStage("aligning");
      const aligned = alignWords(originalWords, correctedWords);
      const finalMd = generateMarkdown({
        title: payload.title,
        channel: payload.channel,
        url: payload.url,
        body: correctedText.trim(),
      });

      setStage("writing");
      await Promise.all([
        updateRelayDoc(mdPath, publishedContent, finalMd, signal),
        updateRelayDoc(
          jsonPath,
          "",
          JSON.stringify(generateTimestampsJson(aligned), null, 2),
          signal,
        ),
      ]);
    } catch (polishErr) {
      // A cancelled job must still count as cancelled.
      if (signal?.aborted) throw polishErr;
      console.warn(
        `[add-video] Cleanup failed for "${payload.title}" (transcript published): ${polishErr}`,
      );
      onStage?.("polish-failed");
    }
    // No catch: either the transcript was published (and must be left intact)
    // or no doc was ever written, in which case the old "processing failed"
    // placeholder would only be junk blocking a clean resubmit.
  } finally {
    // Clean up work directory
    await fs.rm(workDir, { recursive: true }).catch(() => {});
  }
}
