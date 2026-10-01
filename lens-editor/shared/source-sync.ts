/**
 * The frontmatter marker a synced file carries. The server's source sync
 * writes it; the editor reads it to warn that edits will be overwritten.
 *
 *   synced_from:
 *     source: google-doc
 *     url: https://docs.google.com/document/d/<id>/edit?tab=t.0
 */

export const SYNC_MARKER_KEY = "synced_from";

export interface SyncMarker {
  /** Adapter kind, e.g. "google-doc". */
  source: string;
  /** Where the content is edited, as a person would open it. */
  url: string;
}

const SOURCE_LABELS: Record<string, string> = {
  "google-doc": "Google Docs",
};

/** Human name of a source kind ("Google Docs"), or the kind itself. */
export function syncSourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

/** The sync marker in parsed frontmatter, or null when the file is not synced. */
export function readSyncMarker(
  frontmatter: Record<string, unknown> | null | undefined,
): SyncMarker | null {
  const raw = frontmatter?.[SYNC_MARKER_KEY];
  if (!raw || typeof raw !== "object") return null;
  const { source, url } = raw as Record<string, unknown>;
  if (typeof source !== "string" || typeof url !== "string") return null;
  return { source, url };
}
