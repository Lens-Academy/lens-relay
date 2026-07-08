import { randomUUID } from "node:crypto";
import type { ArticleJob } from "./types";
import { evictFinishedJobs, FINISHED_JOB_TTL_MS } from "../queue-utils";

// Hard ceiling on a single import job. Individual stages carry their own
// timeouts (fetch 30s, render 60s, Claude QC 7min, relay calls 30–60s), but a
// stage that misbehaves — or a gap between stages — must never strand a job in
// "processing" forever (three did, for 2h+, in production). The race below
// settles the job even if the underlying promise never does.
const DEFAULT_JOB_TIMEOUT_MS = 12 * 60_000;

function jobTimeoutMs(): number {
  const v = Number(process.env.ARTICLE_JOB_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_JOB_TIMEOUT_MS;
}

interface QueueOptions {
  processJob: (job: ArticleJob, signal: AbortSignal) => Promise<void>;
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

  constructor(options: QueueOptions) {
    this.processJob = options.processJob;
  }

  add(url: string, createLens = true): ArticleJob {
    evictFinishedJobs(this.jobs, FINISHED_JOB_TTL_MS);
    const id = randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    const job: ArticleJob = {
      id,
      url,
      status: "queued",
      createLens,
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
    const timeoutMs = jobTimeoutMs();
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
    try {
      await Promise.race([this.processJob(job, ctrl.signal), aborted]);
      job.status = "done";
      console.log(`[add-article] Job ${job.id} done: ${job.url}`);
    } catch (err) {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      console.error(`[add-article] Job ${job.id} failed: ${job.url}`);
      console.error(`[add-article]   Error: ${job.error}`);
    } finally {
      clearTimeout(timer);
      this.controllers.delete(job.id);
    }
    job.stage = undefined;
    job.updated_at = new Date().toISOString();
  }
}
