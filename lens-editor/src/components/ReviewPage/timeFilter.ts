/**
 * Time-window filter shared by the Review (pending suggestions) and Recent
 * changes pages: quick presets, a dual-thumb "ago" slider on a cubic curve,
 * and helpers to turn a TimeRange into absolute bounds.
 */

// --- Time slider utilities ---
// Cubic power curve: slider position 0..1000 maps to 0ms..30 days ago.
// Cubic gives fine control for recent times, coarser for distant past.
export const SLIDER_MAX = 1000;
export const MAX_AGO_MS = 30 * 86400_000; // 30 days
const SLIDER_POWER = 3;

// Position SLIDER_MAX is reserved for the "all time" sentinel (rendered at the
// slider's left edge, since the UI plots SLIDER_MAX - pos), so the finite range
// spans 0..SLIDER_MAX-1 and the two functions are exact inverses over it.
const SLIDER_FINITE_MAX = SLIDER_MAX - 1;

export function sliderToMs(pos: number, maxAgoMs = MAX_AGO_MS): number {
  if (pos <= 0) return 0;
  if (pos >= SLIDER_MAX) return Infinity; // sentinel: all time
  return Math.round(maxAgoMs * Math.pow(pos / SLIDER_FINITE_MAX, SLIDER_POWER));
}

export function msToSlider(ms: number, maxAgoMs = MAX_AGO_MS): number {
  if (ms <= 0) return 0;
  if (!isFinite(ms)) return SLIDER_MAX; // sentinel: all time
  return Math.round(SLIDER_FINITE_MAX * Math.pow(Math.min(ms, maxAgoMs) / maxAgoMs, 1 / SLIDER_POWER));
}

export function formatAgo(ms: number): string {
  if (!isFinite(ms)) return 'all time';
  if (ms <= 0) return 'now';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'now';
  if (minutes === 1) return '1 min ago';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(ms / 3600_000);
  if (hours === 1) return '1 hour ago';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(ms / 86400_000);
  if (days === 1) return '1 day ago';
  return `${days}d ago`;
}

export function isFullRange(fromAgo: number, toAgo: number): boolean {
  return !isFinite(fromAgo) && toAgo <= 0;
}

export interface TimeRange {
  mode: 'all' | 'range' | 'custom';
  // For 'range' mode: ms ago from now (0 = now)
  fromAgo: number;  // the older end (larger number)
  toAgo: number;    // the newer end (smaller number)
  // For 'custom' mode: ISO datetime-local strings
  customFrom: string;
  customTo: string;
}

export const TIME_QUICK_PRESETS = [
  { label: 'All', fromAgo: Infinity, toAgo: 0, mode: 'all' as const },
  { label: '1h', fromAgo: 3600_000, toAgo: 0, mode: 'range' as const },
  { label: '24h', fromAgo: 86400_000, toAgo: 0, mode: 'range' as const },
  { label: '7d', fromAgo: 604800_000, toAgo: 0, mode: 'range' as const },
];


/** Absolute [from, to] epoch-ms bounds for a TimeRange at `now`. */
export function timeBounds(timeRange: TimeRange, now: number): [number, number] {
  if (timeRange.mode === 'custom') {
    return [
      timeRange.customFrom ? new Date(timeRange.customFrom).getTime() : 0,
      timeRange.customTo ? new Date(timeRange.customTo).getTime() : Infinity,
    ];
  }
  if (timeRange.mode === 'range') {
    return [now - timeRange.fromAgo, now - timeRange.toAgo];
  }
  return [0, Infinity];
}
