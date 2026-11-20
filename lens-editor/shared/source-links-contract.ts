import type { ArticleJobStatus } from "./article-import-contract";

/**
 * The import-and-link API, shared by the editor's offer bar and the server.
 * docs/plans/2026-11-02-import-and-link-sources.md explains the flow.
 */

export type SourceKind = "article" | "video";

/** Where a source stands. `stub` has a page in the library with no text yet,
 *  so importing fills it. */
export type SourceLinkState = "new" | "library" | "stub" | "queued" | "importing" | "failed";

export interface SourceLinkStatus {
  /** As sent in the request, so a row maps straight back to the text. */
  url: string;
  /** The same for every spelling of one source (utm tags, youtu.be or watch),
   *  so a page linking to it twice shows one source. */
  key: string;
  kind: SourceKind;
  state: SourceLinkState;
  /** Full relay path of the library copy, e.g. "Lens Edu/articles/x.md". */
  path?: string;
  title?: string;
  job_id?: string;
  queue_position?: number;
  eta_minutes?: number;
  /** Why the import failed. */
  error?: string;
  /** What became of the asking page's link-back, once its job has ended. */
  link_state?: LinkBackState;
}

export interface SourceLinksCheckRequest {
  urls: string[];
  /** The page asking, as a full relay path. With it, a running or failed job
   *  counts only if it has a link-back to this page: someone else's import is
   *  not this page's news, and accepting here just joins it. */
  path?: string;
}

export interface SourceLinksCheckResponse {
  /** False while the library index is loading: `new` is then unconfirmed, and
   *  the client should ask again rather than offer. */
  ready: boolean;
  /** Sources only: a URL that isn't one is left out. */
  links: SourceLinkStatus[];
  queue: { workers: number; avg_job_minutes: number; queued: number; processing: number };
}

/** Sent with `POST /api/add-article` to swap the links once a source is ready. */
export interface LinkBackRequest {
  /** Full relay path of the page holding the links, e.g. "Lens/Notes/a.md". */
  path: string;
  /** Provenance key: "human:<name>", or the MCP session's "ai:<model>:<name>". */
  actor: string;
  /** Name shown on a pending suggestion. */
  author: string;
  /** Follow the human-text edit policy. The server forces this for `ai:` actors. */
  protectHuman?: boolean;
}

/** What became of a link-back. */
export type LinkBackState =
  /** The job is still running or the swap has not happened yet. */
  | "waiting"
  | "linked"
  /** Pending CriticMarkup suggestions, for an agent's swap of human text. */
  | "suggested"
  /** Nothing to swap: the link had already gone from the page. */
  | "not_found"
  | "failed";

export interface JobLinkBack {
  doc_id: string;
  doc_path: string;
  actor: string;
  author: string;
  protect_human: boolean;
  /** Every spelling to replace. */
  urls: string[];
  state: LinkBackState;
  error?: string;
  attempts?: number;
}

/** A row of `POST /api/add-article`. The last three need `linkBack`. */
export type ImportResultStatus =
  | "queued"
  | "invalid"
  | "already_queued"
  | "linked"
  | "suggested"
  | "link_failed";

export interface ImportResultRow {
  url: string;
  status: ImportResultStatus;
  id?: string;
  error?: string;
  queue_position?: number;
  eta_minutes?: number;
  path?: string;
  title?: string;
}

export type { ArticleJobStatus };
