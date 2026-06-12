import { randomUUID } from "node:crypto";
import type { ArticleJob } from "./types";

interface QueueOptions {
  processJob: (job: ArticleJob) => Promise<void>;
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
  private processJob: QueueOptions["processJob"];

  constructor(options: QueueOptions) {
    this.processJob = options.processJob;
  }

  add(url: string): ArticleJob {
    const id = randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    const job: ArticleJob = {
      id,
      url,
      status: "queued",
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

  /** An unfinished job for this URL, if any — used to reject double submits. */
  findActive(url: string): ArticleJob | undefined {
    for (const job of this.jobs.values()) {
      if (
        job.url === url &&
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
    try {
      await this.processJob(job);
      job.status = "done";
      console.log(`[add-article] Job ${job.id} done: ${job.url}`);
    } catch (err) {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      console.error(`[add-article] Job ${job.id} failed: ${job.url}`);
      console.error(`[add-article]   Error: ${job.error}`);
    }
    job.updated_at = new Date().toISOString();
  }
}
