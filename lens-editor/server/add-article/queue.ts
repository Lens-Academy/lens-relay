import { randomUUID } from "node:crypto";
import type { ArticleImportMode, ArticleJob } from "./types";
import { extractVideoInput } from "../add-video/video-url";
import { VIDEO_JOB_TIMEOUT_MS } from "../add-video/pipeline";
import { evictFinishedJobs, FINISHED_JOB_TTL_MS } from "../queue-utils";
import {
  createArticleReviewReporter,
  createMemoryArticleReviewReporter,
  type ArticleReviewReporter,
} from "./review-report";

// Hard ceiling on a single import job. Individual stages carry their own
// timeouts (fetch 30s, render 60s, Claude QC 7min, relay calls 30–60s), but a
// stage that misbehaves — or a gap between stages — must never strand a job in
// "processing" forever (three did, for 2h+, in production). The race below
// settles the job even if the underlying promise never does.
const DEFAULT_JOB_TIMEOUT_MS = 25 * 60_000;

function jobTimeoutMs(job: ArticleJob): number {
  // YouTube-video jobs run Claude over a whole transcript and legitimately
  // outlive the article deadline. Uses the classification stored at enqueue.
  if (job.video) return VIDEO_JOB_TIMEOUT_MS;
  const v = Number(process.env.ARTICLE_JOB_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_JOB_TIMEOUT_MS;
}

interface QueueOptions {
  processJob: (job: ArticleJob, signal: AbortSignal, reporter: ArticleReviewReporter) => Promise<void>;
  reporterFactory?: (job: ArticleJob) => Promise<ArticleReviewReporter>;
}

/**
 * In-memory job queue for article imports. Unlike the add-video queue,
 * the relay path (and thus relay_url) is unknown at enqueue time — it
 * derives from the article title, which we only learn after extraction.
 * The pipeline fills job.relay_url and job.title during processing.
 */
export class ArticleJobQueue {
  private jobs: Map<string, ArticleJob> = new Map();
  private pending: string[] = [];
  private controllers: Map<string, AbortController> = new Map();
  private processJob: QueueOptions["processJob"];
  private reporterFactory: NonNullable<QueueOptions["reporterFactory"]>;

  constructor(options: QueueOptions) {
    this.processJob = options.processJob;
    this.reporterFactory = options.reporterFactory ?? (process.env.NODE_ENV === "test"
      ? async (job) => createMemoryArticleReviewReporter(job)
      : createArticleReviewReporter);
  }

  add(url: string, importMode: ArticleImportMode, retryOf?: string): ArticleJob {
    evictFinishedJobs(this.jobs, FINISHED_JOB_TTL_MS);
    const id = randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    const job: ArticleJob = {
      id,
      url,
      status: "queued",
      importMode,
      // Classify once here — every later consumer (deadline choice, pipeline
      // dispatch) reads job.video instead of re-parsing the URL.
      video: extractVideoInput(url) ?? undefined,
      report_persistence: "pending",
      retry_of: retryOf,
      created_at: now,
      updated_at: now,
    };
    this.jobs.set(id, job);
    this.pending.push(id);
    // Defer drain to the next microtask so callers always receive the job
    // with 'queued' status before any processing begins.
    void Promise.resolve().then(() => this.drain());
    return job;
  }

  get(id: string): ArticleJob | undefined {
    return this.jobs.get(id);
  }

  /** An unfinished job for this URL, if any — used to reject double submits.
   *  Matching is by normalized URL when a normalizer is provided by the caller. */
  findActive(
    url: string,
    normalize: (u: string) => string = (u) => u,
  ): ArticleJob | undefined {
    const key = normalize(url);
    for (const job of this.jobs.values()) {
      if (
        normalize(job.url) === key &&
        (job.status === "queued" || job.status === "processing")
      ) {
        return job;
      }
    }
    return undefined;
  }

  status(): ArticleJob[] {
    return Array.from(this.jobs.values());
  }

  /**
   * Cancel a queued or processing job. Aborts the job's signal (in-flight
   * fetches reject; the deadline race settles the job) and marks it failed.
   * Returns false when the job doesn't exist or is already finished.
   */
  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || (job.status !== "queued" && job.status !== "processing")) {
      return false;
    }
    const pendingIdx = this.pending.indexOf(id);
    if (pendingIdx !== -1) this.pending.splice(pendingIdx, 1);
    this.controllers.get(id)?.abort(new Error("Cancelled by user"));
    // A queued job has no controller yet — settle it directly.
    if (job.status === "queued") {
      job.status = "failed";
      job.error = "Cancelled by user";
      job.stage = undefined;
      job.updated_at = new Date().toISOString();
      void this.reporterFactory(job).then(async (reporter) => {
        job.report_id = reporter.id;
        await reporter.finish("failed", { error: job.error });
        job.report_summary = reporter.summary();
        job.report_persistence = reporter.persistent ? "persisted" : "pending";
      }).catch((error) => {
        job.report_persistence = "failed";
        job.error = `${job.error}; report persistence failed: ${error}`;
      });
    }
    return true;
  }

  private async drain(): Promise<void> {
    // Start all pending jobs immediately. Concurrency is bounded by the
    // global Claude session pool, not the queue (same as add-video).
    while (this.pending.length > 0) {
      const id = this.pending.shift()!;
      const job = this.jobs.get(id)!;

      job.status = "processing";
      job.updated_at = new Date().toISOString();

      // Fire and forget — runJob awaits a Claude slot from the shared session
      // pool, which is what actually bounds concurrency.
      void this.runJob(job);
    }
  }

  private async runJob(job: ArticleJob): Promise<void> {
    const ctrl = new AbortController();
    this.controllers.set(job.id, ctrl);
    const timeoutMs = jobTimeoutMs(job);
    const timer = setTimeout(
      () =>
        ctrl.abort(
          new Error(
            `Import timed out after ${Math.round(timeoutMs / 60_000)} minutes`,
          ),
        ),
      timeoutMs,
    );
    // Settles when the job is aborted (deadline or cancel) — raced against the
    // pipeline so the job's status ALWAYS resolves, even if some pipeline stage
    // ignores the signal and never returns.
    const aborted = new Promise<never>((_, reject) => {
      ctrl.signal.addEventListener(
        "abort",
        () => reject(ctrl.signal.reason ?? new Error("Job aborted")),
        { once: true },
      );
    });
    let reporter: ArticleReviewReporter | undefined;
    try {
      reporter = await this.reporterFactory(job);
      job.report_id = reporter.id;
      job.report_persistence = reporter.persistent ? "persisted" : "pending";
      await Promise.race([this.processJob(job, ctrl.signal, reporter), aborted]);
      await reporter.finish("done", { finalPath: job.relay_path });
      job.status = "done";
      job.report_summary = reporter.summary();
      job.report_persistence = reporter.persistent ? "persisted" : "pending";
      console.log(`[add-article] job=${job.id} report=${reporter.id} outcome=done path=${job.relay_path ?? ""} counts=${JSON.stringify(job.report_summary)}`);
    } catch (err) {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      if (reporter) {
        try {
          await reporter.finish("failed", { error: job.error, finalPath: job.relay_path });
          job.report_summary = reporter.summary();
          job.report_persistence = reporter.persistent ? "persisted" : "pending";
        } catch (reportError) {
          job.report_persistence = "failed";
          job.error = `${job.error}; report persistence failed: ${reportError}`;
        }
      } else {
        job.report_persistence = "failed";
        job.error = `Report persistence failed before import started: ${job.error}`;
      }
      console.error(`[add-article] Job ${job.id} failed: ${job.url}`);
      console.error(`[add-article]   Error: ${job.error}`);
      console.error(`[add-article] job=${job.id} report=${job.report_id ?? "unavailable"} outcome=failed path=${job.relay_path ?? ""} counts=${JSON.stringify(job.report_summary ?? {})}`);
    } finally {
      clearTimeout(timer);
      this.controllers.delete(job.id);
    }
    job.stage = undefined;
    job.updated_at = new Date().toISOString();
  }
}
