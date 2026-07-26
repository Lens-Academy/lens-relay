export type ArticleJobStatus = "queued" | "processing" | "done" | "failed";
export type ArticleImportMode = "stub" | "article" | "article-and-lens";

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
  /** What the importer should write. Defaults to a full article plus lens. */
  importMode?: ArticleImportMode;
  created_at: string;
  updated_at: string;
}
