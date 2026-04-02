import { randomUUID } from 'node:crypto';
import type { Job, VideoPayload } from './types';

interface QueueOptions {
  processJob: (job: Job & { payload: VideoPayload }) => Promise<void>;
}

export class JobQueue {
  private jobs: Map<string, Job & { payload: VideoPayload }> = new Map();
  private pending: string[] = [];
  private processing = false;
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

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.pending.length > 0) {
      const id = this.pending.shift()!;
      const job = this.jobs.get(id)!;

      job.status = 'processing';
      job.updated_at = new Date().toISOString();

      try {
        await this.processJob(job);
        job.status = 'done';
      } catch (err) {
        job.status = 'failed';
        job.error = err instanceof Error ? err.message : String(err);
      }

      job.updated_at = new Date().toISOString();
    }

    this.processing = false;
  }
}
