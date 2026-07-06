import { randomUUID } from "node:crypto";
import type { Job, VideoPayload } from "./types";
import { generateFilenameBase } from "./export";
import { evictFinishedJobs, FINISHED_JOB_TTL_MS } from "../queue-utils";

interface QueueOptions {
  processJob: (job: Job & { payload: VideoPayload }) => Promise<void>;
}

export class JobQueue {
  private jobs: Map<string, Job & { payload: VideoPayload }> = new Map();
  private pending: string[] = [];
  private activeCount = 0;
  private processJob: QueueOptions["processJob"];

  constructor(options: QueueOptions) {
    this.processJob = options.processJob;
  }

  add(payload: VideoPayload, createLens = true): Job {
    evictFinishedJobs(this.jobs, FINISHED_JOB_TTL_MS);
    const id = randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    const editorBase =
      process.env.EDITOR_BASE_URL || "https://editor.lensacademy.org";
    const relayFolder =
      process.env.RELAY_TRANSCRIPT_FOLDER || "Lens Edu/video_transcripts";
    const filenameBase = generateFilenameBase(payload.channel, payload.title);
    const mdPath = `${relayFolder}/${filenameBase}.md`;

    const job: Job & { payload: VideoPayload } = {
      id,
      video_id: payload.video_id,
      title: payload.title,
      channel: payload.channel,
      url: payload.url,
      transcript_type: payload.transcript_type,
      status: "queued",
      createLens,
      relay_url: `${editorBase}/open/${encodeURI(mdPath)}`,
      created_at: now,
      updated_at: now,
      payload,
    };
    this.jobs.set(id, job);
    this.pending.push(id);
    // Defer drain to the next microtask so callers always receive the job
    // with 'queued' status before any processing begins.
    void Promise.resolve().then(() => this.drain());
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  status(): Job[] {
    return Array.from(this.jobs.values()).map((entry) => {
      const { payload, ...job } = entry;
      void payload; // omit the (large) payload from status output
      return job;
    });
  }

  /** Number of jobs currently processing */
  get processing(): number {
    return this.activeCount;
  }

  /** Number of jobs waiting in queue */
  get queued(): number {
    return this.pending.length;
  }

  private async drain(): Promise<void> {
    // Start all pending jobs immediately. Each job creates its placeholder
    // right away, then waits for a Claude session from the global pool.
    // The session pool (not the queue) controls concurrency.
    while (this.pending.length > 0) {
      const id = this.pending.shift()!;
      const job = this.jobs.get(id)!;

      job.status = "processing";
      job.updated_at = new Date().toISOString();
      this.activeCount++;

      // Fire and forget — don't await, so multiple jobs can start
      this.runJob(job).then(() => {
        this.activeCount--;
      });
    }
  }

  private async runJob(job: Job & { payload: VideoPayload }): Promise<void> {
    try {
      await this.processJob(job);
      job.status = "done";
      console.log(
        `[add-video] Job ${job.id} done: "${job.title}" (${job.video_id})`,
      );
    } catch (err) {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      console.error(
        `[add-video] Job ${job.id} failed: "${job.title}" (${job.video_id})`,
      );
      console.error(`[add-video]   Error: ${job.error}`);
    }
    job.updated_at = new Date().toISOString();
  }
}

/**
 * Semaphore for limiting concurrent Claude CLI processes.
 * Shared between chunked processing (within one video) and
 * concurrent video processing (across multiple videos).
 * Each claude process uses ~300MB RAM.
 */
// A pool wait longer than this means slots are leaked or saturated — fail
// loudly instead of queueing forever (a leaked slot once wedged all QC jobs).
// Must stay BELOW the add-article job deadline (12 min default): a job that
// can't get a slot should fail fast inside its own lifetime, not deadline
// while queued and then wake up as a zombie.
const POOL_ACQUIRE_TIMEOUT_MS = 8 * 60_000;
const POOL_WAIT_LOG_MS = 30_000;

class ClaudeSessionPool {
  private maxConcurrent: number;
  private active = 0;
  private waiters: Array<{ grant: () => void; cancel: () => void }> = [];

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
  }

  get available(): number {
    return this.maxConcurrent - this.active;
  }

  /** Pool state for logs/diagnostics. */
  stats(): { active: number; waiting: number; max: number } {
    return {
      active: this.active,
      waiting: this.waiters.length,
      max: this.maxConcurrent,
    };
  }

  async acquire(timeoutMs: number = POOL_ACQUIRE_TIMEOUT_MS): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return;
    }
    const { active, waiting } = this.stats();
    console.warn(
      `[claude-pool] All ${active} slots busy — queueing (${waiting + 1} waiting)`,
    );
    return new Promise<void>((resolve, reject) => {
      const startedAt = Date.now();
      const waiter = {
        grant: () => {
          clearTimeout(deadline);
          clearInterval(waitLogger);
          this.active++;
          resolve();
        },
        cancel: () => {
          clearInterval(waitLogger);
          reject(
            new Error(
              `Timed out waiting ${Math.round(timeoutMs / 60_000)} min for a Claude session slot ` +
                `(active=${this.active}/${this.maxConcurrent}, waiting=${this.waiters.length}) — possible leaked slot`,
            ),
          );
        },
      };
      const deadline = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx !== -1) this.waiters.splice(idx, 1);
        waiter.cancel();
      }, timeoutMs);
      const waitLogger = setInterval(() => {
        console.warn(
          `[claude-pool] Still waiting for a slot after ${Math.round((Date.now() - startedAt) / 1000)}s ` +
            `(active=${this.active}/${this.maxConcurrent}, waiting=${this.waiters.length})`,
        );
      }, POOL_WAIT_LOG_MS);
      this.waiters.push(waiter);
    });
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    if (this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      next.grant();
    }
  }
}

/** Global pool: max 3 concurrent Claude CLI processes */
export const claudeSessionPool = new ClaudeSessionPool(3);
