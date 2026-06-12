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
});
