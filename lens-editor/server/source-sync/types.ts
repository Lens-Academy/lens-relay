/**
 * Source sync: keep a Relay file a read-only copy of content edited
 * elsewhere (a Google Doc today). One-way only -- the source is the truth,
 * and the Relay copy is overwritten whenever the two differ.
 */

/** One source kept in sync with one Relay file. */
export interface SyncBinding {
  /** The source as a person would paste it, e.g. a Google Docs link. */
  source: string;
  /** Relay path written to: "<Top folder>/<sub/path>.md". */
  target: string;
  /** Article frontmatter the source cannot supply (a Doc has no author list). */
  author: string[];
  title?: string;
  /** YYYY-MM-DD; defaults to the date the file was first written. */
  published?: string;
  /** The article's `source_url`; defaults to the source link. */
  sourceUrl?: string;
}

/** What an adapter reads from its source, before it becomes a Lens article. */
export interface SourceContent {
  /** Where people edit the source. */
  editUrl: string;
  title: string | null;
  description: string | null;
  /** Article body markdown. */
  body: string;
  /** Things in the source that could not be carried over faithfully. */
  warnings: string[];
}

/** Host image bytes beside the target; resolves to the URL to embed, rejects with the reason. */
export type HostImage = (bytes: Uint8Array) => Promise<string>;

/**
 * An image that can never be hosted (not png/jpeg/gif/webp, or over the size
 * limit): reported, and the article is written without it. Any other image
 * failure is taken as passing, and the run leaves the file as it was.
 */
export class PermanentImageError extends Error {}

/** Reads one kind of source (identified by its link) into markdown. */
export interface SourceAdapter {
  /** Recorded in the synced file's marker, e.g. "google-doc". */
  readonly kind: string;
  matches(url: string): boolean;
  pull(binding: SyncBinding, hostImage: HostImage): Promise<SourceContent>;
}

/** Where synced files are read from and written to (the Relay, in production). */
export interface SyncFiles {
  /** Current content of a file, or null when it does not exist. */
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  /** Host image bytes next to `targetPath`; resolves to the URL to embed. */
  hostImage(targetPath: string, bytes: Uint8Array): Promise<string>;
}
