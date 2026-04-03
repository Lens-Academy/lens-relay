import { randomUUID } from 'node:crypto';
import type { Job, VideoPayload } from './types';

interface QueueOptions {
  processJob: (job: Job & { payload: VideoPayload }) => Promise<void>;
}

export class JobQueue {
  private jobs: Map<string, Job & { payload: VideoPayload }> = new Map();
  private pending: string[] = [];
  private activeCount = 0;
  private processJob: QueueOptions['processJob'];

  constructor(options: QueueOptions) {
    this.processJob = options.processJob;
  }

  add(payload: VideoPayload): Job {
    const id = randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    const job: Job & { payload: VideoPayload } = {
      id,
      video_id: payload.video_id,
      title: payload.title,
      channel: payload.channel,
      url: payload.url,
      transcript_type: payload.transcript_type,
      status: 'queued',
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
    return Array.from(this.jobs.values()).map(
      ({ payload: _, ...job }) => job
    );
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

      job.status = 'processing';
      job.updated_at = new Date().toISOString();
      this.activeCount++;

      // Fire and forget — don't await, so multiple jobs can start
      this.runJob(job).then(() => {
        this.activeCount--;
      });
    }
  }

  private async runJob(
    job: Job & { payload: VideoPayload }
  ): Promise<void> {
    try {
      await this.processJob(job);
      job.status = 'done';
    } catch (err) {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
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
class ClaudeSessionPool {
  private maxConcurrent: number;
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
  }

  get available(): number {
    return this.maxConcurrent - this.active;
  }

  async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return;
    }
    // Wait for a slot to free up
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  release(): void {
    this.active--;
    if (this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      next();
    }
  }
}

/** Global pool: max 3 concurrent Claude CLI processes */
export const claudeSessionPool = new ClaudeSessionPool(3);
