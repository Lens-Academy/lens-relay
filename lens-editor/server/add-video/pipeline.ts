import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TimestampedWord, VideoPayload } from "./types";
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
  upsertRelayDocReturningId,
  readRelayDocText,
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
): Promise<{ mdPath: string }> {
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

  try {
    console.log(
      `[add-video] Processing "${payload.title}" (${payload.video_id})`,
    );
    // 1. Create work directory and write the plain-text transcript
    setStage("preparing");
    await fs.mkdir(workDir, { recursive: true });
    const plainText = toPlainText(payload.transcript_raw);
    await fs.writeFile(path.join(workDir, "raw.txt"), plainText);

    // Flatten multi-word entries (sentence-level) into individual words: these
    // carry the real caption timings and back both the phase-1 sidecar and the
    // phase-2 alignment.
    const originalWords = flattenToWords(extractWords(payload.transcript_raw));
    const publishedWords = plainText.trim().split(/\s+/);

    // 2. PHASE 1 -- publish the transcript immediately.
    //    The text YouTube returns is already the real transcript, so there is
    //    no reason to make readers wait behind an LLM pass: the document and
    //    its lens land now, and the cleanup pass (if any) edits them
    //    afterwards.
    setStage("publishing");
    // A video without captions still gets its document and lens: those are
    // what let it be referenced from course content, and neither depends on
    // having a transcript.
    const hasTranscript = originalWords.length > 0;
    const publishedContent = generateMarkdown({
      title: payload.title,
      channel: payload.channel,
      url: payload.url,
      body: hasTranscript
        ? plainText.trim()
        : "*This video has no captions on YouTube, so no transcript could be imported.*",
    });
    const publishedDocId = await upsertRelayDocReturningId(
      mdPath,
      publishedContent,
      signal,
    );
    // The transcript in the relay is now complete and faithful. Everything
    // below is refinement: no later step may replace or invalidate it.

    // The timestamps sidecar is written exactly ONCE, at the very end, with
    // whatever wording the document finally holds. The relay stores .json
    // paths as blobs and blobs cannot be replaced -- a second POST /doc/upsert
    // answers 409 -- so writing it here as well as after the cleanup left the
    // sidecar describing the pre-cleanup wording while the document held the
    // cleaned text. That is exactly the desync the alignment step exists to
    // prevent, and it reached production before this was caught.
    const writeTimestamps = async (
      words: TimestampedWord[],
      sig?: AbortSignal,
    ): Promise<void> => {
      await createRelayDoc(
        jsonPath,
        JSON.stringify(generateTimestampsJson(words), null, 2),
        sig,
      );
    };

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

    // 4. PHASE 2 -- clean up the auto-generated transcript. The job stays
    //    alive for this (it still holds its queue slot), but readers do not:
    //    the document above is already usable. Everything here is best-effort,
    //    so a failed or untrustworthy cleanup leaves the published transcript
    //    alone instead of failing the import.
    //
    //    Resolves to the re-aligned words when the cleanup actually replaced
    //    the document, and to null whenever the published transcript stands --
    //    which is what keeps the sidecar and the document describing the same
    //    text.
    const polish = async (): Promise<TimestampedWord[] | null> => {
      setStage("polishing");
      console.log(
        `[add-video] Running Claude on ${publishedWords.length} words...`,
      );
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
      const verdict = verifyCorrection(publishedWords, correctedWords);
      if (!verdict.ok) {
        console.warn(
          `[add-video] Cleanup rejected for "${payload.title}": ${verdict.reason} — keeping the published transcript`,
        );
        onStage?.("polish-rejected");
        return null;
      }

      setStage("aligning");
      const aligned = alignWords(originalWords, correctedWords);
      const finalMd = generateMarkdown({
        title: payload.title,
        channel: payload.channel,
        url: payload.url,
        body: correctedText.trim(),
      });

      // Readers can open and edit the transcript while the cleanup runs, and
      // a relay write replaces the whole document -- so only apply the cleanup
      // if the document is still exactly what we published.
      // One retry: a transient relay hiccup must not quietly downgrade this
      // guard into "overwrite and hope".
      let current: string | null = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          current = await readRelayDocText(publishedDocId, signal);
          break;
        } catch (readErr) {
          signal?.throwIfAborted();
          console.warn(
            `[add-video] Re-read attempt ${attempt}/2 for "${payload.title}" failed: ${readErr}`,
          );
        }
      }
      // Note: this is a check, not a compare-and-swap -- the relay upsert
      // replaces the whole document, so an edit landing between this read and
      // the write below is still lost. That window is seconds rather than the
      // minutes the cleanup itself takes.
      if (current !== null && current.trim() !== publishedContent.trim()) {
        console.warn(
          `[add-video] "${payload.title}" was edited while the cleanup ran — keeping the edited document`,
        );
        onStage?.("polish-skipped-doc-edited");
        return null;
      }

      setStage("writing");
      await updateRelayDoc(mdPath, publishedContent, finalMd, signal);
      // Only past this point do the aligned timings describe what the
      // document actually says.
      return aligned;
    };

    let timestampWords = originalWords;
    // 5. Human-written caption tracks already carry punctuation, casing and
    //    correct spelling, so the cleanup pass has nothing to fix -- measured
    //    on real videos it returned the input essentially unchanged. Skip it:
    //    the import is done, at a fraction of the latency and cost. A video
    //    with no captions has nothing to clean up either.
    if (hasTranscript && payload.transcript_type === "word_level") {
      try {
        timestampWords = (await polish()) ?? originalWords;
      } catch (polishErr) {
        if (signal?.aborted) {
          // A cancelled job still leaves the published document behind, and
          // the sidecar can only ever be written once -- so write the original
          // timings now rather than stranding that document without any. The
          // signal is deliberately not passed: it is already aborted.
          await writeTimestamps(originalWords).catch((err) =>
            // Nothing left to retry with: the document exists, so a resubmit
            // is deduped away, and this was the sidecar's only chance.
            console.error(
              `[add-video] "${payload.title}" was cancelled and its timestamps could not be written; the document has no word timings: ${err}`,
            ),
          );
          throw polishErr;
        }
        console.warn(
          `[add-video] Cleanup failed for "${payload.title}" (transcript published): ${polishErr}`,
        );
        onStage?.("polish-failed");
      }
    } else {
      console.log(
        `[add-video] "${payload.title}": ${
          hasTranscript ? "human captions" : "no captions"
        } — published as-is, skipping cleanup`,
      );
    }

    // 6. The single sidecar write. Skipped entirely when there are no captions,
    //    rather than writing an empty array.
    if (hasTranscript) {
      await writeTimestamps(timestampWords, signal);
    }
    // No catch: either the transcript was published (and must be left intact)
    // or no doc was ever written, in which case the old "processing failed"
    // placeholder would only be junk blocking a clean resubmit.
    return { mdPath };
  } finally {
    // Clean up work directory
    await fs.rm(workDir, { recursive: true }).catch(() => {});
  }
}
