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

/**
 * What the editor knows of a source kind: its name, and whether a person
 * with the file open can go and edit the source ("Edit it in Google Docs").
 * Nobody at Lens edits iliad-intensive.org, so that file only links to it.
 */
const SOURCES: Record<string, { label: string; editable: boolean }> = {
  "google-doc": { label: "Google Docs", editable: true },
  iliad: { label: "iliad-intensive.org", editable: false },
};

/** Human name of a source kind ("Google Docs"), or the kind itself. */
export function syncSourceLabel(source: string): string {
  return SOURCES[source]?.label ?? source;
}

/** Whether the file's reader can edit the source instead. An unknown kind is taken as editable. */
export function syncSourceEditable(source: string): boolean {
  return SOURCES[source]?.editable ?? true;
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
