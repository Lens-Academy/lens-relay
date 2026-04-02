import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JobQueue } from './queue';
import type { VideoPayload } from './types';

const makePayload = (id: string): VideoPayload => ({
  video_id: id,
  title: 'Test Video ' + id,
  channel: 'TestChannel',
  url: 'https://www.youtube.com/watch?v=' + id,
  transcript_type: 'word_level',
  transcript_raw: { events: [] },
});

describe('JobQueue', () => {
  let queue: JobQueue;

  beforeEach(() => {
    queue = new JobQueue({ processJob: vi.fn() });
  });

  it('adds jobs and returns job info', () => {
    const job = queue.add(makePayload('abc'));
    expect(job.id).toBeDefined();
    expect(job.status).toBe('queued');
    expect(job.video_id).toBe('abc');
    expect(job.title).toBe('Test Video abc');
  });

  it('returns all jobs via status()', () => {
    queue.add(makePayload('a'));
    queue.add(makePayload('b'));
    const jobs = queue.status();
    expect(jobs).toHaveLength(2);
  });

  it('returns a single job by id', () => {
    const job = queue.add(makePayload('x'));
    const found = queue.get(job.id);
    expect(found).toBeDefined();
    expect(found!.video_id).toBe('x');
  });

  it('returns undefined for unknown job id', () => {
    expect(queue.get('nonexistent')).toBeUndefined();
  });

  it('processes jobs serially', async () => {
    const processed: string[] = [];
    const processJob = vi.fn(async (job) => {
      processed.push(job.video_id);
    });

    const q = new JobQueue({ processJob });
    q.add(makePayload('first'));
    q.add(makePayload('second'));

    // Wait for processing
    await new Promise((r) => setTimeout(r, 100));

    expect(processed).toEqual(['first', 'second']);
    expect(q.status().every((j) => j.status === 'done')).toBe(true);
  });

  it('marks job as failed on processor error', async () => {
    const processJob = vi.fn(async () => {
      throw new Error('boom');
    });

    const q = new JobQueue({ processJob });
    const job = q.add(makePayload('fail'));

    await new Promise((r) => setTimeout(r, 100));

    const updated = q.get(job.id);
    expect(updated!.status).toBe('failed');
    expect(updated!.error).toBe('boom');
  });
});
