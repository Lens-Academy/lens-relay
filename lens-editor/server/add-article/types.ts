import type { ArticleImportMode } from "../../shared/article-import-contract";
import type { VideoInput } from "../add-video/video-url";

export type { ArticleImportMode };
export type { ArticleJobStatus } from "../../shared/article-import-contract";

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
  /** Current pipeline stage while processing — lets the status UI distinguish
   *  a slow stage from a stuck job. Articles: "fetching", "rendering",
   *  "quality-check", "uploading-images", "writing", "creating-lens".
   *  YouTube videos: "checking-duplicates", "fetching-transcript",
   *  "preparing", "formatting", "aligning", "writing", "creating-lens". */
  stage?: string;
  error?: string;
  relay_url?: string;
  relay_path?: string;
  /** Persistent troubleshooting report (full report is server-local). */
  report_id?: string;
  report_persistence?: "pending" | "persisted" | "failed";
  report_summary?: {
    programmatic_fixes: number;
    validator_detected_llm_fixes: number;
    llm_detected_llm_fixes: number;
    validator_errors: number;
    validator_warnings: number;
    llm_findings: number;
    validator_fixed_by_llm: number;
    validator_remaining: number;
    validator_introduced: number;
    llm_findings_unrepaired: number;
  };
  retry_of?: string;
  /** What the importer should write. */
  importMode: ArticleImportMode;
  /** Set when the URL is a single YouTube video — classified once at enqueue so
   *  the queue's deadline choice and the pipeline's dispatch never re-parse and
   *  drift apart. Absent for article URLs. */
  video?: VideoInput;
  created_at: string;
  updated_at: string;
}
