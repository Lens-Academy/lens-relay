import type {
  ArticleImportMode,
  ArticleJobStatus,
} from "../../shared/article-import-contract";
import type { VideoInput } from "../add-video/video-url";

export type { ArticleImportMode };
export type { ArticleJobStatus };

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
    initial_validator_errors: number;
    initial_validator_warnings: number;
    final_validator_errors: number;
    final_validator_warnings: number;
    llm_review_passes: number;
    llm_review_duration_ms: number;
    extra_pass_trigger_codes: Record<string, number>;
    llm_findings: number;
    validator_fixed_by_llm: number;
    validator_remaining: number;
    validator_introduced: number;
    llm_findings_unrepaired: number;
  };
  retry_of?: string;
  /** Set when the article was written without a completed LLM review (the
   *  content filter blocked it, or it never answered PASS/REJECT). The
   *  article carries `review-status: "unreviewed: needs a Claude check"`. */
  review_status?: "unreviewed";
  /** Why the review did not complete. */
  review_note?: string;
  /** When a worker picked the job up (the job deadline runs from here). */
  started_at?: string;
  /** Set on a job that was queued or running when the editor restarted and
   *  was put back in the queue from the saved queue file. */
  requeued_after_restart?: boolean;
  /** How many restarts in a row interrupted this job. */
  restart_requeues?: number;
  /** import_cancel was called while the job ran (kept across a restart). */
  cancel_requested?: boolean;
  /** What the importer should write. */
  importMode: ArticleImportMode;
  /** Set when the URL is a single YouTube video — classified once at enqueue so
   *  the queue's deadline choice and the pipeline's dispatch never re-parse and
   *  drift apart. Absent for article URLs. */
  video?: VideoInput;
  /** YouTube videos only: re-import a video that is already in the library,
   *  replacing its transcript and timings in place, instead of skipping it as
   *  a duplicate. */
  replaceExisting?: boolean;
  created_at: string;
  updated_at: string;
}
