import type { ArticleImportMode } from "../../shared/article-import-contract";

export type { ArticleImportMode };
export type ArticleJobStatus = "queued" | "processing" | "done" | "failed";

/** Metadata for an article, accumulated from Jina, HTML meta tags, and Claude */
export interface ArticleMeta {
  title: string;
  author: string[];
  source_url: string;
  published: string; // YYYY-MM-DD, empty if unknown
  description: string; // empty if unknown
}

export interface ArticleJob {
  id: string;
  url: string;
  title?: string;
  status: ArticleJobStatus;
  /** Current pipeline stage while processing ("fetching", "rendering",
   *  "quality-check", "uploading-images", "writing", "creating-lens") — lets
   *  the status UI distinguish a slow stage from a stuck job. */
  stage?: string;
  error?: string;
  relay_url?: string;
  /** What the importer should write. */
  importMode: ArticleImportMode;
  /** Per-job deadline override — video-transcript jobs (Claude formatting of a
   *  long transcript) legitimately outlive the article default. */
  timeout_ms?: number;
  created_at: string;
  updated_at: string;
}
