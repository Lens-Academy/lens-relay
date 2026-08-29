import * as path from "node:path";
import { checkRelayVideoIds, relayTranscriptFolder } from "../add-video/relay-docs";
import { extractVideoInput } from "../add-video/video-url";
import { fetchYouTubeTranscript } from "../add-video/fetch-transcript";
import { importVideo } from "../add-video/pipeline";

/**
 * Resolve the `__lensvideo:<url>__` markers that extraction emits for video
 * embeds (see adapters/util.ts videoEmbedMarker) into the platform's canonical
 * `::video[[../video_transcripts/…]]` directive:
 *
 *   - a video that already has a transcript document on the relay is linked;
 *   - a YouTube video without one is imported first (transcript document, no
 *     lens) through the add-video pipeline, then linked;
 *   - anything else — a non-YouTube host, an unparseable URL, or a failed
 *     video import — degrades to a plain autolink so the article import is
 *     never held hostage by an auxiliary video, with the outcome recorded for
 *     the report and visible to the LLM reviewer.
 *
 * Substitution is total: every marker is replaced, so the private marker
 * syntax can never leak into a validated draft or the written document. All
 * bodies (both review candidates) are resolved against one shared URL map so
 * a video shared between candidates is imported at most once. Video imports
 * are idempotent from the article's side: an import interrupted mid-way is
 * found by the duplicate check on retry and simply linked.
 */

// Greedy up to the last `__` of the whitespace-bounded token, so URLs whose
// video id itself contains `__` stay intact.
export const VIDEO_MARKER_RE = /__lensvideo:(\S+)__(?!\S)/g;

export interface VideoEmbedResolution {
  url: string;
  outcome: "linked-existing" | "imported" | "external-link" | "import-failed";
  /** Full relay transcript path (e.g. "Lens Edu/video_transcripts/x.md") for
   *  linked-existing/imported outcomes. */
  transcriptPath?: string;
  error?: string;
}

/** Wikilink target for a transcript, relative to the articles folder:
 * "Lens Edu/video_transcripts/x.md" → "../video_transcripts/x". */
export function transcriptWikilinkTarget(transcriptPath: string): string {
  const articleFolder = process.env.RELAY_ARTICLE_FOLDER || "Lens Edu/articles";
  return path.posix
    .relative(articleFolder, transcriptPath)
    .replace(/\.md$/, "");
}

/** Prefer the canonical watch URL over an embed/player URL for plain links. */
function displayUrl(raw: string): string {
  const yt = extractVideoInput(raw);
  if (yt) return yt.url;
  try {
    const u = new URL(raw);
    const vimeo = u.pathname.match(/^\/video\/(\d+)/);
    if (u.hostname === "player.vimeo.com" && vimeo) {
      return `https://vimeo.com/${vimeo[1]}`;
    }
  } catch {
    /* keep the raw URL */
  }
  return raw;
}

export interface ResolveVideoEmbedsOptions {
  /** Prefix for the add-video work directories (one per imported video). */
  jobId: string;
  createdAt: string;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

export interface ResolveVideoEmbedsResult {
  bodies: string[];
  resolutions: VideoEmbedResolution[];
}

export async function resolveVideoEmbeds(
  bodies: string[],
  opts: ResolveVideoEmbedsOptions,
): Promise<ResolveVideoEmbedsResult> {
  const { jobId, createdAt, signal, log = () => {} } = opts;

  const urls: string[] = [];
  for (const body of bodies) {
    for (const m of body.matchAll(VIDEO_MARKER_RE)) {
      if (!urls.includes(m[1])) urls.push(m[1]);
    }
  }
  if (urls.length === 0) return { bodies, resolutions: [] };

  const videoByUrl = new Map(urls.map((u) => [u, extractVideoInput(u)]));
  const videoIds = [...new Set(
    [...videoByUrl.values()].filter((v) => v !== null).map((v) => v!.video_id),
  )];

  // Existing transcripts. A failed check degrades to "none found": importing
  // an apparent duplicate converges on the same upserted document.
  let existing: Record<string, string | null> = {};
  if (videoIds.length > 0) {
    try {
      existing = await checkRelayVideoIds(videoIds, signal);
    } catch (err) {
      signal?.throwIfAborted();
      log(`video dedup check failed, importing without it: ${err}`);
    }
  }

  const topFolder = relayTranscriptFolder().split("/")[0];
  const resolutions: VideoEmbedResolution[] = [];
  const replacementByUrl = new Map<string, string>();
  const importedById = new Map<string, Promise<string>>();

  await Promise.all(
    urls.map(async (url) => {
      const video = videoByUrl.get(url) ?? null;
      if (!video) {
        resolutions.push({ url, outcome: "external-link" });
        replacementByUrl.set(url, `<${displayUrl(url)}>`);
        return;
      }
      const existingPath = existing[video.video_id];
      if (existingPath) {
        const transcriptPath = (topFolder + existingPath).replace(/^\/+/, "");
        resolutions.push({ url, outcome: "linked-existing", transcriptPath });
        replacementByUrl.set(
          url,
          `::video[[${transcriptWikilinkTarget(transcriptPath)}]]`,
        );
        return;
      }
      try {
        // Two URLs for the same video share one import.
        let pending = importedById.get(video.video_id);
        if (!pending) {
          pending = (async () => {
            const payload = await fetchYouTubeTranscript(video, signal);
            const { mdPath } = await importVideo(
              `${jobId}-video-${video.video_id}`,
              payload,
              createdAt,
              { createLens: false, signal },
            );
            return mdPath;
          })();
          importedById.set(video.video_id, pending);
        }
        const transcriptPath = await pending;
        resolutions.push({ url, outcome: "imported", transcriptPath });
        replacementByUrl.set(
          url,
          `::video[[${transcriptWikilinkTarget(transcriptPath)}]]`,
        );
      } catch (err) {
        signal?.throwIfAborted();
        const message = err instanceof Error ? err.message : String(err);
        log(`video import failed for ${video.url}, linking instead: ${message}`);
        resolutions.push({ url, outcome: "import-failed", error: message });
        replacementByUrl.set(url, `<${displayUrl(url)}>`);
      }
    }),
  );

  const resolved = bodies.map((body) =>
    body.replace(VIDEO_MARKER_RE, (_whole, url: string) => {
      // Total substitution: an unmapped marker (impossible in normal flow)
      // still degrades to a plain link rather than leaking marker syntax.
      return replacementByUrl.get(url) ?? `<${displayUrl(url)}>`;
    }),
  );
  return { bodies: resolved, resolutions };
}
