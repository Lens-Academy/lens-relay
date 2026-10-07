import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ArticleJobQueue, articleImportWorkers } from "./queue";

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ArticleJobQueue", () => {
  it("fails before processing when mandatory report creation fails", async () => {
    const processJob = vi.fn(async () => {});
    const queue = new ArticleJobQueue({
      processJob,
      reporterFactory: async () => { throw new Error("report disk unavailable"); },
    });
    const job = queue.add("https://example.com/report-failure", "article");
    await flushMicrotasks();
    expect(processJob).not.toHaveBeenCalled();
    expect(queue.get(job.id)?.status).toBe("failed");
    expect(queue.get(job.id)?.report_persistence).toBe("failed");
    expect(queue.get(job.id)?.error).toContain("Report persistence failed before import started");
  });

  // Prevents: caller observing 'processing' before the POST response is built
  it("returns jobs as queued before processing starts", () => {
    const queue = new ArticleJobQueue({ processJob: vi.fn(async () => {}) });
    const job = queue.add("https://example.com/a", "article-and-lens");
    expect(job.status).toBe("queued");
  });

  it("processes jobs and marks them done", async () => {
    const processJob = vi.fn(async () => {});
    const queue = new ArticleJobQueue({ processJob });
    const job = queue.add("https://example.com/a", "article-and-lens");
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
    const job = queue.add("https://example.com/a", "article-and-lens");
    await flushMicrotasks();
    expect(queue.get(job.id)?.status).toBe("failed");
    expect(queue.get(job.id)?.error).toBe("boom");
  });

  it("findActive matches queued/processing jobs but not finished ones", async () => {
    const queue = new ArticleJobQueue({ processJob: vi.fn(async () => {}) });
    queue.add("https://example.com/a", "article-and-lens");
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
    const old = queue.add("https://example.com/old", "article-and-lens");
    await flushMicrotasks();
    expect(queue.get(old.id)?.status).toBe("done");
    // Age the finished job past the 7-day TTL
    queue.get(old.id)!.updated_at = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    ).toISOString();

    queue.add("https://example.com/new", "article-and-lens");
    expect(queue.get(old.id)).toBeUndefined();
  });

  it("never evicts active jobs, even old ones", () => {
    const neverResolves = vi.fn(() => new Promise<void>(() => {}));
    const queue = new ArticleJobQueue({ processJob: neverResolves });
    const stuck = queue.add("https://example.com/stuck", "article-and-lens");
    stuck.updated_at = new Date(
      Date.now() - 30 * 24 * 60 * 60 * 1000,
    ).toISOString();

    queue.add("https://example.com/new", "article-and-lens");
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
      const job = queue.add("https://example.com/hang", "article-and-lens");
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
    const job = queue.add(
      "https://example.com/cancel-me",
      "article-and-lens",
    );
    await flushMicrotasks();
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(queue.cancel(job.id)).toBe(true);
    await flushMicrotasks();
    const j = queue.get(job.id);
    expect(j?.status).toBe("cancelled");
    expect(j?.error).toMatch(/cancelled/i);
  });

  it("cancels a queued job before it starts", () => {
    const queue = new ArticleJobQueue({ processJob: vi.fn(async () => {}) });
    const job = queue.add("https://example.com/queued", "article-and-lens");
    expect(queue.cancel(job.id)).toBe(true); // still queued (drain is deferred)
    expect(queue.get(job.id)?.status).toBe("cancelled");
  });

  it("refuses to cancel finished or unknown jobs", async () => {
    const queue = new ArticleJobQueue({ processJob: vi.fn(async () => {}) });
    const job = queue.add("https://example.com/done", "article-and-lens");
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
    const job = queue.add("https://example.com/stage", "article-and-lens");
    await flushMicrotasks();
    expect(queue.get(job.id)?.status).toBe("done");
    expect(queue.get(job.id)?.stage).toBeUndefined();
  });

  it("matches active jobs by normalized URL when a normalizer is given", async () => {
    const queue = new ArticleJobQueue({
      processJob: () => new Promise<void>(() => {}),
    });
    queue.add("https://example.com/post", "article-and-lens");
    await flushMicrotasks();
    const strip = (u: string) => u.replace(/\?.*$/, "");
    expect(
      queue.findActive("https://example.com/post?utm_source=x", strip),
    ).toBeDefined();
    expect(queue.findActive("https://example.com/post?utm_source=x")).toBeUndefined();
  });
});

describe("ArticleJobQueue — a real queue", () => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
  };

  // Prevents: 60 submissions all starting at once and timing out while they
  // wait for one of three Claude slots (76 failures, 4-6 Oct).
  it("runs at most `workers` jobs at once and starts the next as one finishes", async () => {
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const started: string[] = [];
    const queue = new ArticleJobQueue({
      workers: 2,
      stateFile: null,
      processJob: (job) => {
        started.push(job.url);
        const gate = deferred();
        gates.set(job.url, gate);
        return gate.promise;
      },
    });
    const jobs = ["a", "b", "c", "d", "e"].map((x) => queue.add(`https://example.com/${x}`, "article"));
    await flushMicrotasks();
    expect(started).toEqual(["https://example.com/a", "https://example.com/b"]);
    expect(jobs.map((j) => queue.get(j.id)?.status)).toEqual([
      "processing", "processing", "queued", "queued", "queued",
    ]);
    expect(queue.view(jobs[2]).queue_position).toBe(1);
    expect(queue.view(jobs[4]).queue_position).toBe(3);
    expect(queue.summary()).toMatchObject({ workers: 2, processing: 2, queued: 3 });
    expect(queue.summary().message).toMatch(/2 importing now, 3 waiting/);
    expect(queue.summary().message).toMatch(/do not time out or fail for waiting/);

    gates.get("https://example.com/a")!.resolve();
    await flushMicrotasks();
    expect(started).toHaveLength(3);
    expect(queue.get(jobs[2].id)?.status).toBe("processing");
    expect(queue.view(jobs[3]).queue_position).toBe(1);
  });

  // Prevents: time spent waiting in the queue counting against the job's
  // deadline (the old 25-min deadline started at submit).
  it("starts the job deadline only when a worker picks the job up", async () => {
    vi.stubEnv("ARTICLE_JOB_TIMEOUT_MS", "80");
    try {
      const first = deferred();
      let calls = 0;
      const queue = new ArticleJobQueue({
        workers: 1,
        stateFile: null,
        processJob: () => (++calls === 1 ? first.promise : Promise.resolve()),
      });
      const a = queue.add("https://example.com/a", "article");
      const b = queue.add("https://example.com/b", "article");
      await new Promise((r) => setTimeout(r, 50));
      first.resolve();
      await new Promise((r) => setTimeout(r, 60));
      // b waited ~50 ms + ran: well past 80 ms since submit, yet done.
      expect(queue.get(a.id)?.status).toBe("done");
      expect(queue.get(b.id)?.status).toBe("done");
      expect(queue.get(b.id)?.started_at).toBeDefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("takes a cancelled job out of the queue so later ones move up", async () => {
    const queue = new ArticleJobQueue({
      workers: 1,
      stateFile: null,
      processJob: () => new Promise<void>(() => {}),
    });
    const a = queue.add("https://example.com/a", "article");
    const b = queue.add("https://example.com/b", "article");
    const c = queue.add("https://example.com/c", "article");
    await flushMicrotasks();
    expect(queue.view(c).queue_position).toBe(2);
    expect(queue.cancel(b.id)).toBe(true);
    expect(queue.get(b.id)?.status).toBe("cancelled");
    expect(queue.view(c).queue_position).toBe(1);
    expect(queue.get(a.id)?.status).toBe("processing");
  });

  it("lists unreviewed imports in the summary", async () => {
    const queue = new ArticleJobQueue({
      stateFile: null,
      processJob: async (job) => {
        job.review_status = "unreviewed";
        job.review_note = "Claude's content filter blocked the review";
        job.relay_path = "Lens Edu/articles/x.md";
      },
    });
    const job = queue.add("https://example.com/x", "article");
    await flushMicrotasks();
    expect(queue.summary().unreviewed).toEqual([{
      id: job.id,
      url: "https://example.com/x",
      relay_path: "Lens Edu/articles/x.md",
      reason: "Claude's content filter blocked the review",
    }]);
  });

  it("reads ARTICLE_IMPORT_WORKERS, defaulting to 3", async () => {
    expect(articleImportWorkers({})).toBe(3);
    expect(articleImportWorkers({ ARTICLE_IMPORT_WORKERS: "" })).toBe(3);
    expect(articleImportWorkers({ ARTICLE_IMPORT_WORKERS: "5" })).toBe(5);
    expect(articleImportWorkers({ ARTICLE_IMPORT_WORKERS: "0" })).toBe(3);
    expect(articleImportWorkers({ ARTICLE_IMPORT_WORKERS: "x" })).toBe(3);
  });
});

describe("ArticleJobQueue — survives a restart", () => {
  const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "article-queue-")), "queue.json");

  // Prevents: a deploy or restart dropping a 70-job batch.
  it("saves the queue and restores it, interrupted jobs first", async () => {
    const file = tmpFile();
    const first = new ArticleJobQueue({
      workers: 1,
      stateFile: file,
      processJob: () => new Promise<void>(() => {}),
    });
    const a = first.add("https://example.com/a", "article");
    const b = first.add("https://example.com/b", "article");
    const c = first.add("https://example.com/c", "article");
    first.cancel(c.id);
    await flushMicrotasks();
    expect(first.get(a.id)?.status).toBe("processing");

    // A new process on the same file: a was running, b waiting.
    const started: string[] = [];
    const second = new ArticleJobQueue({
      workers: 1,
      stateFile: file,
      processJob: async (job) => { started.push(job.id); },
    });
    expect(second.get(a.id)?.requeued_after_restart).toBe(true);
    expect(second.get(c.id)?.status).toBe("cancelled");
    await flushMicrotasks();
    await flushMicrotasks();
    expect(started).toEqual([a.id, b.id]);
    expect(second.get(a.id)?.status).toBe("done");
    expect(second.get(b.id)?.status).toBe("done");
    // The finished state is saved too.
    const saved = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(saved.pending).toEqual([]);
    expect(saved.jobs.map((j: { status: string }) => j.status).sort()).toEqual(["cancelled", "done", "done"]);
  });

  it("moves an unreadable queue file aside and starts empty, saying so", () => {
    const file = tmpFile();
    fs.writeFileSync(file, "{not json");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const queue = new ArticleJobQueue({ stateFile: file, processJob: async () => {} });
    expect(queue.status()).toEqual([]);
    expect(queue.summary().persistence_error).toMatch(/unreadable/);
    expect(fs.readdirSync(path.dirname(file)).some((f) => f.startsWith("queue.json.corrupt-"))).toBe(true);
    error.mockRestore();
  });

  it("reports a save failure instead of failing the import", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "article-queue-"));
    const blocker = path.join(dir, "not-a-dir");
    fs.writeFileSync(blocker, "");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const queue = new ArticleJobQueue({ stateFile: path.join(blocker, "queue.json"), processJob: async () => {} });
    const job = queue.add("https://example.com/a", "article");
    await flushMicrotasks();
    expect(queue.get(job.id)?.status).toBe("done");
    expect(queue.summary().persistence_error).toMatch(/Could not save/);
    error.mockRestore();
  });
});
