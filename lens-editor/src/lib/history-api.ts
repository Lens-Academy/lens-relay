import { relayHeaders } from './relay-api';
import type { ChangeSummary } from '../../shared/history-diff';
export { authorLabel, diffVersions, type DiffPart } from '../../shared/history-diff';

/** Client of the editor server's /api/history (server/history/routes.ts). Lens Edu files only. */

export interface HistoryVersion { sha: string; ts: number; author: string | null }
export interface HistorySession {
  start: number; end: number;
  authors: string[]; unknown: boolean;
  versions: HistoryVersion[];
  head: string; base: string | null;
  /** What the session changed against the one before it; null if the file was gone at its end. */
  summary: ChangeSummary | null;
}

/** '/Lens Edu/x.md' → 'Lens Edu/x.md'; null for files history does not cover. */
export function historyPath(filePath: string | undefined): string | null {
  return filePath?.startsWith('/Lens Edu/') ? filePath.slice(1) : null;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: relayHeaders() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `History request failed (${res.status})`);
  }
  return res.json();
}

/** The file's editing sessions, and the commit time (ms) of the newest version the server holds. */
export const fetchSessions = (path: string) =>
  getJson<{ sessions: HistorySession[]; asOf: number }>(`/api/history/log?path=${encodeURIComponent(path)}`);

/** The file's text at a version; null if it did not exist then. */
export async function fetchVersion(path: string, sha: string): Promise<string | null> {
  try {
    return (await getJson<{ text: string }>(`/api/history/file?path=${encodeURIComponent(path)}&sha=${sha}`)).text;
  } catch (e) {
    if (e instanceof Error && /No such version/.test(e.message)) return null;
    throw e;
  }
}

/** The two versions a selection compares: a whole session (j null) against the session before
 *  it, or one save inside it against the save before (the oldest save against the session base). */
export function versionPair(s: HistorySession, j: number | null) {
  if (j === null) return { head: s.head, base: s.base, ts: s.end, authors: s.authors };
  const v = s.versions[j];
  return { head: v.sha, base: s.versions[j + 1]?.sha ?? s.base, ts: v.ts, authors: v.author ? [v.author] : [] };
}

/** A row's preview of its first change: "old → new", "+ added", "− removed" or "markup only". */
export function previewText(first: { removed: string; added: string }): string {
  if (!first.removed && !first.added) return 'markup only';   // only suggestion marks changed
  if (first.removed && first.added) return `${first.removed} → ${first.added}`;
  return first.added ? `+ ${first.added}` : `− ${first.removed}`;
}
