import { diffWordsWithSpace } from 'diff';
import { relayHeaders } from './relay-api';

/** Client of the editor server's /api/history (server/history/routes.ts). Lens Edu files only. */

export interface HistoryVersion { sha: string; ts: number; author: string | null }
export interface HistorySession {
  start: number; end: number;
  authors: string[]; unknown: boolean;
  versions: HistoryVersion[];
  head: string; base: string | null;
}
export type DiffPart = { kind: 'same' | 'added' | 'removed'; text: string };

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

export const fetchSessions = (path: string) =>
  getJson<{ sessions: HistorySession[] }>(`/api/history/log?path=${encodeURIComponent(path)}`).then(r => r.sessions);

/** The file's text at a version; null if it did not exist then. */
export async function fetchVersion(path: string, sha: string): Promise<string | null> {
  try {
    return (await getJson<{ text: string }>(`/api/history/file?path=${encodeURIComponent(path)}&sha=${sha}`)).text;
  } catch (e) {
    if (e instanceof Error && /did not exist/.test(e.message)) return null;
    throw e;
  }
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Word-level changes from `base` (null: the file's first version) to `text`. */
export function diffVersions(base: string | null, text: string) {
  const parts: DiffPart[] = base === null
    ? [{ kind: 'added', text }]
    : diffWordsWithSpace(base, text).map(p => ({ kind: p.added ? 'added' : p.removed ? 'removed' : 'same', text: p.value }));
  const count = (k: DiffPart['kind']) => parts.filter(p => p.kind === k).reduce((n, p) => n + words(p.text), 0);
  return { parts, added: count('added'), removed: count('removed') };
}
