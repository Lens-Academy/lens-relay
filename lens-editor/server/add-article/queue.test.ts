import { describe, it, expect, vi } from "vitest";
import { ArticleJobQueue } from "./queue";

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ArticleJobQueue", () => {
  // Prevents: caller observing 'processing' before the POST response is built
  it("returns jobs as queued before processing starts", () => {
    const queue = new ArticleJobQueue({ processJob: vi.fn(async () => {}) });
    const job = queue.add("https://example.com/a");
    expect(job.status).toBe("queued");
  });

  it("processes jobs and marks them done", async () => {
    const processJob = vi.fn(async () => {});
    const queue = new ArticleJobQueue({ processJob });
    const job = queue.add("https://example.com/a");
    await flushMicrotasks();
    expect(processJob).toHaveBeenCalledTimes(1);
    expect(queue.get(job.id)?.status).toBe("done");
  });

  it("marks failed jobs with the error message", async () => {
    const queue = new ArticleJobQueue({
      processJob: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const job = queue.add("https://example.com/a");
    await flushMicrotasks();
    expect(queue.get(job.id)?.status).toBe("failed");
    expect(queue.get(job.id)?.error).toBe("boom");
  });

  it("findActive matches queued/processing jobs but not finished ones", async () => {
    const queue = new ArticleJobQueue({ processJob: vi.fn(async () => {}) });
    queue.add("https://example.com/a");
    expect(queue.findActive("https://example.com/a")?.url).toBe(
      "https://example.com/a",
    );
    expect(queue.findActive("https://example.com/other")).toBeUndefined();
    await flushMicrotasks();
    // job is done now — resubmitting should be allowed
    expect(queue.findActive("https://example.com/a")).toBeUndefined();
  });

  // Prevents: in-memory job map growing unbounded over the server's lifetime
  it("evicts finished jobs older than the TTL on add", async () => {
    const queue = new ArticleJobQueue({ processJob: vi.fn(async () => {}) });
    const old = queue.add("https://example.com/old");
    await flushMicrotasks();
    expect(queue.get(old.id)?.status).toBe("done");
    // Age the finished job past the 7-day TTL
    queue.get(old.id)!.updated_at = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    ).toISOString();

    queue.add("https://example.com/new");
    expect(queue.get(old.id)).toBeUndefined();
  });

  it("never evicts active jobs, even old ones", () => {
    const neverResolves = vi.fn(() => new Promise<void>(() => {}));
    const queue = new ArticleJobQueue({ processJob: neverResolves });
    const stuck = queue.add("https://example.com/stuck");
    stuck.updated_at = new Date(
      Date.now() - 30 * 24 * 60 * 60 * 1000,
    ).toISOString();

    queue.add("https://example.com/new");
    expect(queue.get(stuck.id)).toBeDefined();
  });
});

describe("ArticleJobQueue — deadline, cancel, signal", () => {
  // Prevents: jobs stuck in "processing" forever (3 LW jobs sat 2h+ in prod).
  // The overall deadline settles the job even if the pipeline never returns.
  it("fails a job that exceeds the overall deadline", async () => {
    vi.stubEnv("ARTICLE_JOB_TIMEOUT_MS", "40");
    try {
      const queue = new ArticleJobQueue({
        processJob: () => new Promise<void>(() => {}), // hangs forever
      });
      const job = queue.add("https://example.com/hang");
      await new Promise((r) => setTimeout(r, 200));
      expect(queue.get(job.id)?.status).toBe("failed");
      expect(queue.get(job.id)?.error).toMatch(/timed out/i);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("passes an AbortSignal that fires on cancel", async () => {
    let seenSignal: AbortSignal | undefined;
    const queue = new ArticleJobQueue({
      processJob: (_job, signal) => {
        seenSignal = signal;
        return new Promise<void>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    });
    const job = queue.add("https://example.com/cancel-me");
    await flushMicrotasks();
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(queue.cancel(job.id)).toBe(true);
    await flushMicrotasks();
    const j = queue.get(job.id);
    expect(j?.status).toBe("failed");
    expect(j?.error).toMatch(/cancelled/i);
  });

  it("cancels a queued job before it starts", () => {
    const queue = new ArticleJobQueue({ processJob: vi.fn(async () => {}) });
    const job = queue.add("https://example.com/queued");
    expect(queue.cancel(job.id)).toBe(true); // still queued (drain is deferred)
    expect(queue.get(job.id)?.status).toBe("failed");
  });

  it("refuses to cancel finished or unknown jobs", async () => {
    const queue = new ArticleJobQueue({ processJob: vi.fn(async () => {}) });
    const job = queue.add("https://example.com/done");
    await flushMicrotasks();
    expect(queue.get(job.id)?.status).toBe("done");
    expect(queue.cancel(job.id)).toBe(false);
    expect(queue.cancel("nope")).toBe(false);
  });

  it("clears the stage field when a job settles", async () => {
    const queue = new ArticleJobQueue({
      processJob: async (job) => {
        job.stage = "fetching";
      },
    });
    const job = queue.add("https://example.com/stage");
    await flushMicrotasks();
    expect(queue.get(job.id)?.status).toBe("done");
    expect(queue.get(job.id)?.stage).toBeUndefined();
  });

  it("matches active jobs by normalized URL when a normalizer is given", async () => {
    const queue = new ArticleJobQueue({
      processJob: () => new Promise<void>(() => {}),
    });
    queue.add("https://example.com/post");
    await flushMicrotasks();
    const strip = (u: string) => u.replace(/\?.*$/, "");
    expect(
      queue.findActive("https://example.com/post?utm_source=x", strip),
    ).toBeDefined();
    expect(queue.findActive("https://example.com/post?utm_source=x")).toBeUndefined();
  });
});
