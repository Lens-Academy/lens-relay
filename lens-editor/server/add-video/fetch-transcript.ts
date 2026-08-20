import { ProxyAgent } from "undici";
import type { TranscriptRaw, VideoPayload } from "./types";
import { fetchBytesWithTimeout, bytesToText } from "../fetch-timeout";
import type { VideoInput } from "./video-url";

/**
 * Server-side YouTube transcript fetch.
 *
 * YouTube hard-blocks datacenter IPs ("Sign in to confirm you're not a bot")
 * on every player-API surface, which is why the original importer captured
 * transcripts in the user's browser via a bookmarklet. Two measured facts
 * (2026-08-20) make a server-side fetch possible anyway:
 *
 *  - Only the caption-URL MINT (one ~4KB innertube /player POST, ANDROID
 *    client, `fields`-trimmed) needs a clean IP. It is routed through
 *    YT_PROXY_URL (a rotating residential proxy) when set.
 *  - The minted timedtext URL is signed but NOT IP-locked (`ip=0.0.0.0`),
 *    and `fmt` is not part of its signature -- so the transcript itself is
 *    fetched directly (no proxy bandwidth) with `fmt` rewritten to json3.
 *
 * The ANDROID client is used because its caption URLs work without the
 * proof-of-origin token that WEB-client URLs now require.
 */

const PLAYER_URL = "https://www.youtube.com/youtubei/v1/player";
// Trims the ~130KB player response to the ~4KB we use -- this is the only
// payload that crosses the (metered) proxy.
const PLAYER_FIELDS =
  "playabilityStatus(status,reason)," +
  "videoDetails(videoId,title,author)," +
  "captions.playerCaptionsTracklistRenderer.captionTracks(baseUrl,languageCode,kind)";
const ANDROID_CONTEXT = {
  client: {
    clientName: "ANDROID",
    clientVersion: "20.10.38",
    androidSdkVersion: 30,
    hl: "en",
  },
};
const ANDROID_UA =
  "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip";
// A rotating proxy exits from a different IP each request, so a bot-flagged
// exit is retried; without a proxy a retry would leave the same IP and fail
// identically, so we don't bother.
const MINT_ATTEMPTS_VIA_PROXY = 3;
const MINT_TIMEOUT_MS = 30_000;
const MINT_MAX_BYTES = 2 * 1024 * 1024;
const CAPTION_TIMEOUT_MS = 60_000;
// json3 for a multi-hour word-level track is a few MB; anything past this is
// not a transcript.
const CAPTION_MAX_BYTES = 40 * 1024 * 1024;

interface PlayerResponse {
  playabilityStatus?: { status?: string; reason?: string };
  videoDetails?: { videoId?: string; title?: string; author?: string };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: Array<{
        baseUrl: string;
        languageCode?: string;
        kind?: string;
      }>;
    };
  };
}

let cachedProxy: { url: string; agent: ProxyAgent } | null = null;

function proxyAgent(): ProxyAgent | undefined {
  const url = process.env.YT_PROXY_URL?.trim();
  if (!url) return undefined;
  if (cachedProxy?.url !== url) {
    void cachedProxy?.agent.close();
    cachedProxy = { url, agent: new ProxyAgent(url) };
  }
  return cachedProxy.agent;
}

/** Non-retryable: the video itself can't be imported (private, no captions…). */
class VideoUnavailableError extends Error {}

async function mintPlayerResponse(
  videoId: string,
  signal?: AbortSignal,
): Promise<PlayerResponse> {
  const agent = proxyAgent();
  const attempts = agent ? MINT_ATTEMPTS_VIA_PROXY : 1;
  let lastErr: Error | undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    signal?.throwIfAborted();
    try {
      const resp = await fetchBytesWithTimeout(
        `${PLAYER_URL}?prettyPrint=false&fields=${encodeURIComponent(PLAYER_FIELDS)}`,
        {
          method: "POST",
          timeoutMs: MINT_TIMEOUT_MS,
          maxBytes: MINT_MAX_BYTES,
          signal,
          dispatcher: agent,
          headers: {
            "Content-Type": "application/json",
            "User-Agent": ANDROID_UA,
          },
          body: JSON.stringify({ videoId, context: ANDROID_CONTEXT }),
        },
      );
      if (!resp.ok) {
        throw new Error(`YouTube player API returned ${resp.status}`);
      }
      const data = JSON.parse(bytesToText(resp.bytes)) as PlayerResponse;
      const status = data.playabilityStatus?.status;
      if (status === "LOGIN_REQUIRED") {
        // Bot-flagged exit IP -- retryable only through a rotating proxy.
        throw new Error(
          `YouTube bot-check rejected the request (exit IP flagged${agent ? "" : "; YT_PROXY_URL is not set"})`,
        );
      }
      if (status && status !== "OK") {
        const reason = data.playabilityStatus?.reason;
        throw new VideoUnavailableError(
          `Video is ${status}${reason ? ` (${reason})` : ""}`,
        );
      }
      return data;
    } catch (err) {
      if (err instanceof VideoUnavailableError) throw err;
      signal?.throwIfAborted();
      lastErr = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `[fetch-transcript] mint attempt ${attempt}/${attempts} for ${videoId} failed: ${lastErr.message}`,
      );
    }
  }
  throw lastErr ?? new Error("YouTube player request failed");
}

/** Rewrite the minted track URL to return json3 (fmt is not signature-protected). */
export function toJson3Url(baseUrl: string): string {
  const u = new URL(baseUrl);
  u.searchParams.set("fmt", "json3");
  return u.href;
}

/** Prefer English (exact, then regional variant), else the first track. */
export function pickCaptionTrack<T extends { languageCode?: string }>(
  tracks: T[],
): T {
  return (
    tracks.find((t) => t.languageCode === "en") ??
    tracks.find((t) => t.languageCode?.startsWith("en")) ??
    tracks[0]
  );
}

/**
 * Fetch a video's transcript and metadata from a bare YouTube URL, producing
 * the same payload shape the bookmarklet used to POST.
 */
export async function fetchYouTubeTranscript(
  input: VideoInput,
  signal?: AbortSignal,
): Promise<VideoPayload> {
  const player = await mintPlayerResponse(input.video_id, signal);

  const tracks =
    player.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || tracks.length === 0) {
    throw new VideoUnavailableError(
      "This video has no captions on YouTube, so there is nothing to import.",
    );
  }
  const track = pickCaptionTrack(tracks);

  const resp = await fetchBytesWithTimeout(toJson3Url(track.baseUrl), {
    timeoutMs: CAPTION_TIMEOUT_MS,
    maxBytes: CAPTION_MAX_BYTES,
    signal,
    headers: { "User-Agent": ANDROID_UA },
  });
  if (!resp.ok) {
    throw new Error(`Transcript fetch returned ${resp.status}`);
  }
  const text = bytesToText(resp.bytes);
  if (!text) {
    throw new Error("Transcript response was empty");
  }
  const raw = JSON.parse(text) as TranscriptRaw;
  if (!raw.events?.some((e) => e.segs)) {
    throw new Error("Transcript returned no word data");
  }

  return {
    video_id: input.video_id,
    title: player.videoDetails?.title || "Unknown",
    channel: player.videoDetails?.author || "Unknown",
    url: input.url,
    transcript_type: track.kind === "asr" ? "word_level" : "sentence_level",
    transcript_raw: raw,
  };
}
