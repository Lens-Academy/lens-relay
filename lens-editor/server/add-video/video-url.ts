/**
 * Pure YouTube URL classification — no I/O, importable from routers and
 * queues without dragging in the transcript fetcher's proxy stack.
 */

export interface VideoInput {
  video_id: string;
  url: string;
}

function fullYouTubeUrl(videoId: string, isShort: boolean): string {
  return isShort
    ? `https://www.youtube.com/shorts/${videoId}`
    : `https://www.youtube.com/watch?v=${videoId}`;
}

/** Parse and return the URL plus its normalized host when it belongs to
 *  YouTube (any subdomain, trailing-dot hosts included); null otherwise. */
function parseYouTubeUrl(raw: string): { url: URL; host: string } | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  const isYt =
    host === "youtu.be" ||
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtube-nocookie.com" ||
    host.endsWith(".youtube-nocookie.com");
  return isYt ? { url: u, host } : null;
}

/** Whether this URL belongs to YouTube at all (regardless of URL shape). */
export function isYouTubeUrl(raw: string): boolean {
  return parseYouTubeUrl(raw) !== null;
}

/**
 * Extract a video id from the common YouTube URL shapes (watch, shorts,
 * embed, youtu.be, live). Returns null for YouTube URLs that don't identify
 * a single video (channel pages, playlists, search).
 */
export function extractVideoInput(raw: string): VideoInput | null {
  const parsed = parseYouTubeUrl(raw);
  if (!parsed) return null;
  const { url: u, host } = parsed;

  const v = u.searchParams.get("v");
  if (v && /^[\w-]{11}$/.test(v)) {
    return { video_id: v, url: fullYouTubeUrl(v, false) };
  }

  if (host === "youtu.be") {
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
