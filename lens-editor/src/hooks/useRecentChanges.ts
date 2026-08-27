import { useState, useEffect, useCallback, useRef } from 'react';

/** One direct AI edit, as recorded in the doc's `activity_v0` map and served
 *  by `GET /recent-changes` (crates/y-sweet-core/src/activity.rs). */
export interface ActivityEvent {
  id: string;
  ts: number;
  actor: string;
  author: string;
  mode: 'direct' | string;
  kind: 'insert' | 'delete' | 'replace';
  old: string;
  new: string;
  old_truncated: boolean;
  new_truncated: boolean;
  ctx_before: string;
  ctx_after: string;
  /** Accepted-view UTF-8 byte offset at event time (for `?pos=` navigation). */
  pos: number;
  client: number;
  clock_from: number;
  clock_to: number;
  /** base64 of an encoded Y.RelativePosition, or null. */
  anchor: string | null;
}

export interface ExcerptSegment {
  kind: 'text' | 'insert' | 'delete';
  text: string;
  event_id?: string;
  /** `text` was cut by the server (very long insert/removal). */
  truncated?: boolean;
}

/** A window of the current document text around a cluster of nearby
 *  changes, with surviving inserts and removed text marked in place. */
export interface Excerpt {
  /** Accepted-view UTF-8 byte offset of the excerpt start (for `?pos=`). */
  pos: number;
  line: number;
  skipped_before: number;
  skipped_after: number;
  segments: ExcerptSegment[];
}

export interface FileActivity {
  path: string;
  doc_id: string;
  folder_id: string;
  events: ActivityEvent[];
  excerpts: Excerpt[];
}

export interface RecentChangesResponse {
  files: Omit<FileActivity, 'folder_id'>[];
  since_ms: number;
  /** The server's event limit was hit; oldest events were dropped. */
  truncated?: boolean;
}

const FETCH_TIMEOUT_MS = 30_000;

/** Fetch recent direct AI edits for the given folders (one request per
 *  folder, in parallel), like `useSuggestions`. */
export function useRecentChanges(folderIds: string[], sinceMs?: number) {
  const [data, setData] = useState<FileActivity[]>([]);
  /** Epoch ms when `data` was fetched — a stable "now" for time filters. */
  const [fetchedAt, setFetchedAt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Some folder hit the server's event limit. */
  const [truncated, setTruncated] = useState(false);
  // In-flight request; a newer refresh (or unmount) aborts it so a slow
  // older response can't overwrite newer data.
  const inflight = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    setLoading(true);
    setError(null);
    const headers: Record<string, string> = {};
    let token: string | null = null;
    try {
      token = localStorage.getItem('lens-share-token');
    } catch {
      // storage unavailable (private mode / blocked): unauthenticated fetch
    }
    if (token) headers['X-Share-Token'] = token;

    const results = await Promise.all(
      folderIds.map(async (folderId): Promise<{ files: FileActivity[]; truncated: boolean } | null> => {
        try {
          const params = new URLSearchParams({ folder_id: folderId });
          if (sinceMs !== undefined) params.set('since_ms', String(Math.max(0, Math.floor(sinceMs))));
          const res = await fetch(`/api/relay/recent-changes?${params.toString()}`, {
            headers,
            signal: controller.signal,
          });
          if (!res.ok) return null;
          const json: RecentChangesResponse = await res.json();
          return {
            files: json.files.map(f => ({ ...f, excerpts: f.excerpts ?? [], folder_id: folderId })),
            truncated: json.truncated === true,
          };
        } catch {
          return null;
        }
      }),
    );
    clearTimeout(timeout);
    if (controller.signal.aborted) return;

    const ok = results.filter((r): r is NonNullable<typeof r> => r !== null);
    const allFiles = ok.flatMap(r => r.files);
    const failed = results.length - ok.length;
    setData(allFiles);
    setTruncated(ok.some(r => r.truncated));
    setFetchedAt(Date.now());
    setError(
      failed > 0 && allFiles.length === 0
        ? `Failed to fetch recent changes for ${failed} folder${failed !== 1 ? 's' : ''}`
        : null,
    );
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderIds.join(','), sinceMs]);

  useEffect(() => {
    refresh();
    return () => inflight.current?.abort();
  }, [refresh]);

  return { data, fetchedAt, loading, error, truncated, refresh };
}
