import { ProxyAgent, fetch as proxiedFetch } from "undici";
import type { TranscriptRaw, VideoPayload } from "./types";

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
 *    and `fmt` is not part of its signature — so the transcript itself is
 *    fetched directly (no proxy bandwidth) with `fmt` rewritten to json3.
 *
 * The ANDROID client is used because its caption URLs work without the
 * proof-of-origin token that WEB-client URLs now require.
 */

const PLAYER_URL = "https://www.youtube.com/youtubei/v1/player";
// Trims the ~130KB player response to the ~4KB we use — this is the only
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
const CAPTION_TIMEOUT_MS = 60_000;

export interface VideoInput {
  video_id: string;
  url: string;
}

function fullYouTubeUrl(videoId: string, isShort: boolean): string {
  return isShort
    ? `https://www.youtube.com/shorts/${videoId}`
    : `https://www.youtube.com/watch?v=${videoId}`;
}

const YOUTUBE_HOSTS = /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtube-nocookie\.com)$/;

/** Whether this URL belongs to YouTube at all (regardless of URL shape). */
export function isYouTubeUrl(raw: string): boolean {
  try {
    const host = new URL(raw.trim()).hostname.toLowerCase();
    return host === "youtu.be" || YOUTUBE_HOSTS.test(host);
  } catch {
    return false;
  }
}

/**
 * Extract a video id from the common YouTube URL shapes (watch, shorts,
 * embed, youtu.be, live). Returns null for YouTube URLs that don't identify
 * a single video (channel pages, playlists, search).
 */
export function extractVideoInput(raw: string): VideoInput | null {
  if (!isYouTubeUrl(raw)) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }

  const v = u.searchParams.get("v");
  if (v && /^[\w-]{11}$/.test(v)) {
    return { video_id: v, url: fullYouTubeUrl(v, false) };
  }

  if (u.hostname.toLowerCase() === "youtu.be") {
    const m = u.pathname.match(/^\/([\w-]{11})(?:\/|$)/);
    if (m) return { video_id: m[1], url: fullYouTubeUrl(m[1], false) };
    return null;
  }

  const path = u.pathname.match(/^\/(shorts|embed|live)\/([\w-]{11})(?:\/|$)/);
  if (path) {
    return {
      video_id: path[2],
      url: fullYouTubeUrl(path[2], path[1] === "shorts"),
    };
  }
  return null;
}

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
    cachedProxy = { url, agent: new ProxyAgent(url) };
  }
  return cachedProxy.agent;
}

/** Errors the user can act on (vs transient/unknown ones). */
export class VideoUnavailableError extends Error {}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const signals = [AbortSignal.timeout(ms)];
  if (signal) signals.push(signal);
  return AbortSignal.any(signals);
}

async function mintPlayerResponse(
  videoId: string,
  signal?: AbortSignal,
): Promise<PlayerResponse> {
  const agent = proxyAgent();
  const attempts = agent ? MINT_ATTEMPTS_VIA_PROXY : 1;
  let lastErr: Error = new Error("unreachable");

  for (let attempt = 1; attempt <= attempts; attempt++) {
    signal?.throwIfAborted();
    try {
      const resp = await proxiedFetch(
        `${PLAYER_URL}?prettyPrint=false&fields=${encodeURIComponent(PLAYER_FIELDS)}`,
        {
          method: "POST",
          dispatcher: agent,
          signal: withTimeout(signal, MINT_TIMEOUT_MS),
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
      const data = (await resp.json()) as PlayerResponse;
      const status = data.playabilityStatus?.status;
      if (status === "LOGIN_REQUIRED") {
        // Bot-flagged exit IP — retryable only through a rotating proxy.
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
  throw lastErr;
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
      "This video has no captions on YouTube — nothing to import.",
    );
  }
  const track = pickCaptionTrack(tracks);

  const resp = await fetch(toJson3Url(track.baseUrl), {
    signal: withTimeout(signal, CAPTION_TIMEOUT_MS),
    headers: { "User-Agent": ANDROID_UA },
  });
  if (!resp.ok) {
    throw new Error(`Transcript fetch returned ${resp.status}`);
  }
  const text = await resp.text();
  if (!text) {
    throw new Error("Transcript response was empty");
  }
  const raw = JSON.parse(text) as TranscriptRaw;
  const events = (raw.events || []).filter((e) => e.segs);
  if (events.length === 0) {
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
