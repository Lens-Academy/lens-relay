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
  error?: string;
  relay_url?: string;
  /** Also auto-create a lens wrapping the imported article (default true). */
  createLens?: boolean;
  created_at: string;
  updated_at: string;
}
