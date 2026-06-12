interface EvictableJob {
  status: string;
  updated_at: string;
}

// Finished (done/failed) jobs older than this are evicted on each add().
export const FINISHED_JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Evict finished (done/failed) jobs older than ttlMs from an in-memory job
 * map, so it doesn't grow unbounded over the server's lifetime. Active jobs
 * are never evicted. Shared by the add-video and add-article queues.
 */
export function evictFinishedJobs<T extends EvictableJob>(
  jobs: Map<string, T>,
  ttlMs: number,
): void {
  const cutoff = Date.now() - ttlMs;
  for (const [id, job] of jobs) {
    if (
      (job.status === "done" || job.status === "failed") &&
      Date.parse(job.updated_at) < cutoff
    ) {
      jobs.delete(id);
    }
  }
}
