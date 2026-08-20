/**
 * Pure YouTube URL classification — no I/O, importable from routers and
 * queues without dragging in the transcript fetcher's proxy stack.
 *
 * The browser bookmarklet (public/add-video-bookmarklet.js) carries its own
 * ES5 copy of this parsing; if URL shapes change, update both.
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

const YOUTUBE_HOSTS =
  /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtube-nocookie\.com)$/;

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
