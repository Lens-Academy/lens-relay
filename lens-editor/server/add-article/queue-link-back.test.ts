import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { JobLinkBack } from "../../shared/source-links-contract";
import { RelayLinkError } from "../add-video/relay-docs";
import { DuplicateDocumentError } from "./duplicate";
import { LibraryIndex } from "./library-index";
import { ArticleJobQueue } from "./queue";
import type { ArticleJob } from "./types";

const until = (check: () => void) => vi.waitFor(check, { timeout: 10_000, interval: 1 });

/** Every job over, and every swap it owed done. A fixed sleep raced the retry
 *  timers on a busy machine. */
const settled = (queue: ArticleJobQueue) =>
  until(() => {
    for (const job of queue.status()) {
      expect(job.status).not.toMatch(/^(queued|processing)$/);
      if (job.status === "done" || job.status === "skipped") {
        expect(job.link_back?.filter((link) => link.state === "waiting") ?? []).toEqual([]);
      }
    }
  });

const LINKED = { linked: 1, suggested: 0, unswappable: 0 };

const waiting = (overrides: Partial<JobLinkBack> = {}): JobLinkBack => ({
  doc_id: "relay-doc1",
  doc_path: "Lens/Notes/a.md",
  actor: "human:Luc",
  author: "Luc",
  protect_human: false,
  urls: ["https://example.com/a"],
  state: "waiting",
  ...overrides,
});

const writes = (relayPath: string, title = "The article") => async (job: ArticleJob) => {
  job.relay_path = relayPath;
  job.title = title;
};

function makeQueue(
  options: Partial<ConstructorParameters<typeof ArticleJobQueue>[0]> = {},
) {
  const linkSource = vi.fn(async () => LINKED);
  const queue = new ArticleJobQueue({
    stateFile: null,
    processJob: writes("Lens Edu/articles/a.md"),
    linkSource,
    linkRetryDelaysMs: [0, 0],
    library: new LibraryIndex({ load: async () => ({ articles: [], transcripts: [] }) }),
    ...options,
  });
  return { queue, linkSource };
}

describe("link-backs on a finished job", () => {
  it("swaps the links once the job is done", async () => {
    const { queue, linkSource } = makeQueue();
    const job = queue.add("https://example.com/a", "article", undefined, { linkBack: [waiting()] });
    expect(linkSource).not.toHaveBeenCalled();
    await settled(queue);

    expect(linkSource).toHaveBeenCalledExactlyOnceWith({
      docId: "relay-doc1",
      urls: ["https://example.com/a"],
      target: "Lens Edu/articles/a.md",
      title: "The article",
      actor: "human:Luc",
      author: "Luc",
      protectHuman: false,
    });
    expect(queue.get(job.id)?.link_back?.[0]).toMatchObject({ state: "linked", attempts: 1 });
  });

  // Prevents: a link pointing at a stub that then fails to fill.
  it("waits for the job to end, not for the stub to appear", async () => {
    let finish!: () => void;
    const { queue, linkSource } = makeQueue({
      processJob: (job) =>
        new Promise<void>((resolve) => {
          job.relay_path = "Lens Edu/articles/a.md";
          finish = resolve;
        }),
    });
    queue.add("https://example.com/a", "article", undefined, { linkBack: [waiting()] });
    await until(() => expect(finish).toBeDefined());
    expect(linkSource).not.toHaveBeenCalled();
    finish();
    await settled(queue);
    expect(linkSource).toHaveBeenCalledOnce();
  });

  it("swaps after a skip, with the full path of the document it found", async () => {
    const { queue, linkSource } = makeQueue({
      processJob: async () => {
        throw new DuplicateDocumentError("Already imported", "Lens Edu/articles/existing.md");
      },
    });
    const job = queue.add("https://example.com/a", "article", undefined, { linkBack: [waiting()] });
    await settled(queue);
    expect(queue.get(job.id)).toMatchObject({
      status: "skipped",
      relay_path: "Lens Edu/articles/existing.md",
    });
    expect(linkSource.mock.calls[0]).toMatchObject([{ target: "Lens Edu/articles/existing.md" }]);
    expect(queue.get(job.id)?.link_back?.[0].state).toBe("linked");
  });

  it("takes a title it doesn't have from the library", async () => {
    const library = new LibraryIndex({ load: async () => ({ articles: [], transcripts: [] }) });
    library.add({ url: "https://example.com/a", path: "Lens Edu/articles/x.md", title: "From the index", stub: false });
    const { queue, linkSource } = makeQueue({
      library,
      processJob: async () => {
        throw new DuplicateDocumentError("Already imported", "Lens Edu/articles/x.md");
      },
    });
    queue.add("https://example.com/a", "article", undefined, { linkBack: [waiting()] });
    await settled(queue);
    expect(linkSource.mock.calls[0]).toMatchObject([{ title: "From the index" }]);
  });

  it("swaps every page waiting on a job, and leaves each one's own result", async () => {
    const linkSource = vi.fn()
      .mockResolvedValueOnce(LINKED)
      .mockResolvedValueOnce({ linked: 0, suggested: 2, unswappable: 0 });
    const { queue } = makeQueue({ linkSource });
    const job = queue.add("https://example.com/a", "article", undefined, {
      linkBack: [waiting(), waiting({ doc_id: "relay-doc2", protect_human: true, actor: "ai:fable-5:luc" })],
    });
    await settled(queue);
    expect(linkSource.mock.calls[1][0]).toMatchObject({ docId: "relay-doc2", protectHuman: true, actor: "ai:fable-5:luc" });
    expect(queue.get(job.id)?.link_back?.map((link) => link.state)).toEqual(["linked", "suggested"]);
  });

  it("reports not_found when nothing on the page matched", async () => {
    const { queue } = makeQueue({ linkSource: async () => ({ linked: 0, suggested: 0, unswappable: 0 }) });
    const job = queue.add("https://example.com/a", "article", undefined, { linkBack: [waiting()] });
    await settled(queue);
    expect(queue.get(job.id)?.link_back?.[0].state).toBe("not_found");
  });

  it("fails a link-back whose only matches can't be swapped, and notes a partial swap", async () => {
    const linkSource = vi.fn()
      .mockResolvedValueOnce({ linked: 0, suggested: 0, unswappable: 2 })
      .mockResolvedValueOnce({ linked: 1, suggested: 0, unswappable: 1 });
    const { queue } = makeQueue({ linkSource });
    const job = queue.add("https://example.com/a", "article", undefined, {
      linkBack: [waiting(), waiting({ doc_id: "relay-doc2" })],
    });
    await settled(queue);
    const [none, partial] = queue.get(job.id)!.link_back!;
    expect(none).toMatchObject({ state: "failed", error: "2 links can't become a wikilink and stayed as written" });
    expect(partial).toMatchObject({ state: "linked", error: "1 link can't become a wikilink and stayed as written" });
  });

  it("fails a link-back when a finished job has no document", async () => {
    const { queue, linkSource } = makeQueue({ processJob: async () => {} });
    const job = queue.add("https://example.com/a", "article", undefined, { linkBack: [waiting()] });
    await settled(queue);
    expect(linkSource).not.toHaveBeenCalled();
    expect(queue.get(job.id)?.link_back?.[0]).toMatchObject({ state: "failed" });
  });

  it("leaves a job without link-backs alone", async () => {
    const { queue, linkSource } = makeQueue();
    const job = queue.add("https://example.com/a", "article");
    await settled(queue);
    expect(linkSource).not.toHaveBeenCalled();
    expect(queue.get(job.id)).not.toHaveProperty("link_back");
  });

  // Prevents: a slow relay stalling the import queue through the swap.
  it("frees the worker before swapping", async () => {
    let release!: () => void;
    const linkSource = vi.fn(() => new Promise<typeof LINKED>((resolve) => {
      release = () => resolve(LINKED);
    }));
    const { queue } = makeQueue({ workers: 1, linkSource });
    const first = queue.add("https://example.com/a", "article", undefined, { linkBack: [waiting()] });
    const second = queue.add("https://example.com/b", "article");
    await until(() => expect(queue.get(second.id)?.status).toBe("done"));
    expect(linkSource).toHaveBeenCalledOnce();
    expect(queue.get(first.id)?.status).toBe("done");
    expect(queue.get(first.id)?.link_back?.[0].state).toBe("waiting");
    release();
    await settled(queue);
    expect(queue.get(first.id)?.link_back?.[0].state).toBe("linked");
  });
});

describe("link-back retries", () => {
  it("retries relay errors, recording each attempt, and clears the error on success", async () => {
    const seen: Array<{ attempts?: number; error?: string }> = [];
    let job: ArticleJob;
    const linkSource = vi.fn(async () => {
      const link = queue.get(job.id)!.link_back![0];
      seen.push({ attempts: link.attempts, error: link.error });
      if (linkSource.mock.calls.length < 3) throw new Error("relay busy");
      return LINKED;
    });
    const { queue } = makeQueue({ linkSource });
    job = queue.add("https://example.com/a", "article", undefined, { linkBack: [waiting()] });
    await settled(queue);
    expect(seen).toEqual([
      { attempts: 1, error: undefined },
      { attempts: 2, error: "relay busy" },
      { attempts: 3, error: "relay busy" },
    ]);
    const link = queue.get(job.id)!.link_back![0];
    expect(link).toMatchObject({ state: "linked", attempts: 3 });
    expect(link).not.toHaveProperty("error");
  });

  it("gives up after the last attempt and leaves the job as it ended", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const linkSource = vi.fn(async () => {
      throw new Error("relay down");
    });
    const { queue } = makeQueue({ linkSource });
    const job = queue.add("https://example.com/a", "article", undefined, { linkBack: [waiting()] });
    await settled(queue);
    expect(linkSource).toHaveBeenCalledTimes(3);
    expect(queue.get(job.id)).toMatchObject({
      status: "done",
      link_back: [{ state: "failed", attempts: 3, error: "relay down" }],
    });
    expect(queue.get(job.id)?.error).toBeUndefined();
    error.mockRestore();
  });

  it("waits between attempts", async () => {
    vi.useFakeTimers();
    try {
      const linkSource = vi.fn(async () => {
        if (linkSource.mock.calls.length === 1) throw new Error("relay busy");
        return LINKED;
      });
      const { queue } = makeQueue({ linkSource, linkRetryDelaysMs: [1_000] });
      queue.add("https://example.com/a", "article", undefined, { linkBack: [waiting()] });
      await vi.advanceTimersByTimeAsync(999);
      expect(linkSource).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(linkSource).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // Prevents: an outage outlasting the retries and quietly dropping a link
  // nobody is watching: agents are told not to poll.
  it("keeps trying for about 45 minutes by default, spaced out", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const calledAt: number[] = [];
      const started = Date.now();
      const linkSource = vi.fn(async () => {
        calledAt.push(Date.now() - started);
        throw new Error("relay down");
      });
      const { queue } = makeQueue({ linkSource, linkRetryDelaysMs: undefined });
      const job = queue.add("https://example.com/a", "article", undefined, { linkBack: [waiting()] });
      await vi.advanceTimersByTimeAsync(40 * 60_000);
      expect(queue.get(job.id)?.link_back?.[0].state).toBe("waiting");
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(queue.get(job.id)?.link_back?.[0]).toMatchObject({ state: "failed", error: "relay down" });
      const gaps = calledAt.slice(1).map((at, i) => at - calledAt[i]);
      expect(gaps).toEqual([...gaps].sort((a, b) => a - b));
      expect(gaps.at(-1)).toBeLessThanOrEqual(15 * 60_000);
      expect(calledAt.at(-1)).toBeGreaterThanOrEqual(40 * 60_000);
    } finally {
      error.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not retry a page the relay won't link", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const linkSource = vi.fn(async () => {
      throw new RelayLinkError("page_not_eligible");
    });
    const { queue } = makeQueue({ linkSource });
    const job = queue.add("https://example.com/a", "article", undefined, { linkBack: [waiting()] });
    await settled(queue);
    expect(linkSource).toHaveBeenCalledOnce();
    expect(queue.get(job.id)?.link_back?.[0]).toMatchObject({
      state: "failed",
      attempts: 1,
      error: expect.stringContaining("can't link to the library"),
    });
    error.mockRestore();
  });

  // The relay's path resolver is eventually consistent, so a page or a file
  // written a moment ago can read as missing.
  it.each(["target_missing", "doc_not_found"] as const)("retries %s", async (code) => {
    const linkSource = vi.fn(async () => {
      if (linkSource.mock.calls.length === 1) throw new RelayLinkError(code);
      return LINKED;
    });
    const { queue } = makeQueue({ linkSource });
    const job = queue.add("https://example.com/a", "article", undefined, { linkBack: [waiting()] });
    await settled(queue);
    expect(queue.get(job.id)?.link_back?.[0]).toMatchObject({ state: "linked", attempts: 2 });
  });
});

describe("a skip that found a neighbouring page", () => {
  const skips = (storedUrl?: string) => async () => {
    throw new DuplicateDocumentError("Already imported", "Lens Edu/articles/app.md", storedUrl);
  };

  // Prevents: the fall-through from `sameSource` swapping the link anyway, moments
  // later, because the importer's own duplicate check folds the same things.
  it.each([
    ["an app route", "https://example.com/app#/b", "https://example.com/app"],
    ["a port", "https://example.com:8443/app", "https://example.com/app"],
  ])("leaves the link alone when the match differs by %s", async (_name, url, stored) => {
    const index = new LibraryIndex({ load: async () => ({ articles: [], transcripts: [] }) });
    const { queue, linkSource } = makeQueue({ library: index, processJob: skips(stored) });
    const job = queue.add(url, "article", undefined, { linkBack: [waiting({ urls: [url] })] });
    await settled(queue);
    expect(queue.get(job.id)?.status).toBe("skipped");
    expect(queue.get(job.id)?.relay_path).toBeUndefined();
    expect(queue.get(job.id)?.link_back?.[0]).toMatchObject({
      state: "failed",
      error: "The library has no copy of this exact page to link to",
    });
    expect(linkSource).not.toHaveBeenCalled();
    expect(index.lookup(url)).toBeUndefined();
  });

  it("links when the stored URL is the same page", async () => {
    const { queue, linkSource } = makeQueue({ processJob: skips("https://www.example.com/a/") });
    queue.add("https://example.com/a?utm_source=x", "article", undefined, { linkBack: [waiting()] });
    await settled(queue);
    expect(linkSource).toHaveBeenCalledOnce();
  });

  it("links when the importer read the page and its canonical URL matched", async () => {
    const { queue, linkSource } = makeQueue({ processJob: skips(undefined) });
    queue.add("https://short.example/abc", "article", undefined, { linkBack: [waiting()] });
    await settled(queue);
    expect(linkSource).toHaveBeenCalledOnce();
  });
});

describe("findActive", () => {
  const normalize = (url: string) => url;

  it("ignores a job being stopped, so nothing attaches to it", async () => {
    const { queue } = makeQueue({ processJob: () => new Promise<void>(() => {}), reporterFactory: () => new Promise(() => {}) });
    const job = queue.add("https://example.com/a", "article");
    await until(() => expect(queue.get(job.id)?.status).toBe("processing"));
    expect(queue.findActive("https://example.com/a", normalize)?.id).toBe(job.id);
    queue.cancel(job.id);
    expect(queue.get(job.id)?.status).toBe("processing");
    expect(queue.findActive("https://example.com/a", normalize)).toBeUndefined();
  });

  it("can be narrowed by the caller", () => {
    const { queue } = makeQueue({ workers: 0 });
    const first = queue.add("https://example.com/a", "article");
    const second = queue.add("https://example.com/a", "stub");
    expect(queue.findActive("https://example.com/a", normalize)?.id).toBe(first.id);
    expect(queue.findActive("https://example.com/a", normalize, (job) => job.importMode === "stub")?.id).toBe(second.id);
    expect(queue.findActive("https://example.com/a", normalize, () => false)).toBeUndefined();
  });
});

describe("link-backs on a job that didn't finish", () => {
  it("keeps them waiting when the import fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { queue, linkSource } = makeQueue({
      processJob: async (job) => {
        job.relay_path = "Lens Edu/articles/stub.md";
        throw new Error("boom");
      },
    });
    const job = queue.add("https://example.com/a", "article", undefined, { linkBack: [waiting()] });
    await settled(queue);
    expect(queue.get(job.id)?.status).toBe("failed");
    expect(queue.get(job.id)?.link_back?.[0].state).toBe("waiting");
    expect(linkSource).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("keeps them waiting when the job is cancelled", async () => {
    const { queue, linkSource } = makeQueue();
    const job = queue.add("https://example.com/a", "article", undefined, { linkBack: [waiting()] });
    queue.cancel(job.id);
    await settled(queue);
    expect(queue.get(job.id)?.status).toBe("cancelled");
    expect(queue.get(job.id)?.link_back?.[0].state).toBe("waiting");
    expect(linkSource).not.toHaveBeenCalled();
  });

  it("hands over only the ones still waiting", () => {
    const { queue } = makeQueue();
    const job = queue.add("https://example.com/a", "article", undefined, {
      linkBack: [waiting(), waiting({ doc_id: "relay-doc2", state: "linked" })],
    });
    expect(queue.takeLinkBacks(job.id).map((link) => link.doc_id)).toEqual(["relay-doc1"]);
    expect(queue.get(job.id)?.link_back?.map((link) => link.doc_id)).toEqual(["relay-doc2"]);
    expect(queue.takeLinkBacks(job.id)).toEqual([]);
  });
});

describe("attachLinkBack", () => {
  it("swaps a link-back attached while the job runs", async () => {
    let finish!: () => void;
    const { queue, linkSource } = makeQueue({
      processJob: (job) =>
        new Promise<void>((resolve) => {
          job.relay_path = "Lens Edu/articles/a.md";
          finish = resolve;
        }),
    });
    const job = queue.add("https://example.com/a", "article");
    await until(() => expect(finish).toBeDefined());
    queue.attachLinkBack(job.id, waiting());
    finish();
    await settled(queue);
    expect(linkSource).toHaveBeenCalledOnce();
    expect(queue.get(job.id)?.link_back?.[0].state).toBe("linked");
  });

  // Prevents: a person who joined in Editing mode, then accepted another
  // spelling in Suggesting mode, having it swapped directly.
  it("keeps a different edit policy apart, so a suggestion stays a suggestion", async () => {
    const { queue, linkSource } = makeQueue();
    const job = queue.add("https://example.com/a", "article", undefined, { linkBack: [waiting()] });
    queue.attachLinkBack(job.id, waiting({ protect_human: true, urls: ["https://example.com/a/"] }));
    expect(queue.get(job.id)?.link_back?.map((link) => link.protect_human)).toEqual([false, true]);
    await settled(queue);
    expect(linkSource.mock.calls.map(([request]) => (request as { protectHuman: boolean }).protectHuman)).toEqual([false, true]);
  });

  it("adds new spellings to the same page and actor, and a new entry otherwise", () => {
    const { queue } = makeQueue();
    const job = queue.add("https://example.com/a", "article", undefined, { linkBack: [waiting()] });
    queue.attachLinkBack(job.id, waiting({ urls: ["https://example.com/a", "https://example.com/a/"] }));
    queue.attachLinkBack(job.id, waiting({ actor: "ai:fable-5:luc", protect_human: true }));
    queue.attachLinkBack(job.id, waiting({ doc_id: "relay-doc2" }));
    const links = queue.get(job.id)!.link_back!;
    expect(links.map((link) => [link.doc_id, link.actor])).toEqual([
      ["relay-doc1", "human:Luc"],
      ["relay-doc1", "ai:fable-5:luc"],
      ["relay-doc2", "human:Luc"],
    ]);
    expect(links[0].urls).toEqual(["https://example.com/a", "https://example.com/a/"]);
  });
});

describe("stopForPage", () => {
  const running = () => makeQueue({ processJob: () => new Promise<void>(() => {}) });
  const pageA = (link: { doc_id: string }) => link.doc_id === "relay-doc1";
  const pageB = waiting({ doc_id: "relay-doc2", doc_path: "Lens/Notes/b.md" });

  it("records which page started a job, and only that", () => {
    const { queue } = running();
    const started = queue.add("https://example.com/a", "article", undefined, { linkBack: [waiting()], startedBy: "relay-doc1" });
    const plain = queue.add("https://example.com/b", "article");
    expect(queue.get(started.id)?.started_by).toBe("relay-doc1");
    expect(queue.get(plain.id)).not.toHaveProperty("started_by");
    queue.attachLinkBack(plain.id, waiting());
    expect(queue.get(plain.id)).not.toHaveProperty("started_by");
  });

  it("cancels a job the page started that nobody else joined, taking its link-back off first", async () => {
    const { queue } = running();
    const job = queue.add("https://example.com/a", "article", undefined, { linkBack: [waiting()], startedBy: "relay-doc1" });
    expect(queue.stopForPage(job.id, pageA)).toBe("cancelled");
    expect(queue.get(job.id)?.status).toBe("cancelled");
    expect(queue.get(job.id)).not.toHaveProperty("link_back");
  });

  it("leaves a job it started running when another page has joined", () => {
    const { queue } = running();
    const job = queue.add("https://example.com/a", "article", undefined, { linkBack: [waiting(), pageB], startedBy: "relay-doc1" });
    expect(queue.stopForPage(job.id, pageA)).toBe("detached");
    expect(queue.get(job.id)?.status).toBe("queued");
    expect(queue.get(job.id)?.link_back?.map((link) => link.doc_id)).toEqual(["relay-doc2"]);
  });

  // Prevents: a page that joined someone's import from the Add Source page
  // cancelling it with its Stop.
  it("never cancels a job someone else started, or one started from no page", () => {
    const { queue } = running();
    const plain = queue.add("https://example.com/a", "article");
    queue.attachLinkBack(plain.id, waiting());
    expect(queue.stopForPage(plain.id, pageA)).toBe("detached");
    expect(queue.get(plain.id)?.status).toBe("queued");
    expect(queue.get(plain.id)).not.toHaveProperty("link_back");

    const theirs = queue.add("https://example.com/b", "article", undefined, { linkBack: [pageB], startedBy: "relay-doc2" });
    queue.attachLinkBack(theirs.id, waiting());
    expect(queue.stopForPage(theirs.id, pageA)).toBe("detached");
    expect(queue.get(theirs.id)?.status).toBe("queued");
    // The starter, though alone now, can stop it.
    expect(queue.stopForPage(theirs.id, (link) => link.doc_id === "relay-doc2")).toBe("cancelled");
  });

  it("drops every entry of that page, whoever asked", () => {
    const { queue } = running();
    const job = queue.add("https://example.com/a", "article", undefined, {
      linkBack: [waiting(), waiting({ actor: "ai:fable-5:luc" }), pageB],
    });
    queue.stopForPage(job.id, pageA);
    expect(queue.get(job.id)?.link_back).toEqual([pageB]);
  });

  it("knows its starter by the path it was made with when the doc id is unknown", () => {
    const { queue } = running();
    const job = queue.add("https://example.com/a", "article", undefined, { linkBack: [waiting()], startedBy: "relay-doc1" });
    expect(queue.stopForPage(job.id, (link) => link.doc_path === "Lens/Notes/a.md")).toBe("cancelled");
  });

  it("leaves a job that has ended, or doesn't exist, to the plain cancel", async () => {
    const { queue } = makeQueue();
    const ended = queue.add("https://example.com/b", "article", undefined, { linkBack: [waiting()], startedBy: "relay-doc1" });
    await settled(queue);
    expect(queue.stopForPage(ended.id, pageA)).toBe("unchanged");
    expect(queue.get(ended.id)?.link_back).toHaveLength(1);
    expect(queue.stopForPage("nope", pageA)).toBe("unchanged");
  });

  // Its article is written: a Stop now must not lose the link either.
  it("leaves a job that is closing its report, with its link-back", async () => {
    const { queue } = makeQueue({
      processJob: async () => {},
      reporterFactory: async (job) => ({
        id: `r-${job.id}`,
        persistent: false,
        finish: () => new Promise<void>(() => {}),
        summary: () => undefined,
      }) as never,
    });
    const job = queue.add("https://example.com/a", "article", undefined, { linkBack: [waiting()], startedBy: "relay-doc1" });
    await until(() => expect(queue.get(job.id)?.report_id).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queue.stopForPage(job.id, pageA)).toBe("unchanged");
    expect(queue.get(job.id)?.link_back).toHaveLength(1);
  });
});

describe("pages swap on their own", () => {
  // Prevents: one page retrying for 45 minutes (it was deleted, say) holding
  // up every other page waiting on the job.
  it("doesn't make one page wait for another's retries", async () => {
    const linkSource = vi.fn(async (request: { docId: string }) => {
      if (request.docId === "relay-doc1") return new Promise<never>(() => {});
      return LINKED;
    });
    const { queue } = makeQueue({ linkSource: linkSource as never });
    const job = queue.add("https://example.com/a", "article", undefined, {
      linkBack: [waiting(), waiting({ doc_id: "relay-doc2", doc_path: "Lens/Notes/b.md" })],
    });
    await until(() => expect(queue.get(job.id)?.link_back?.[1].state).toBe("linked"));
    expect(queue.get(job.id)?.link_back?.[0].state).toBe("waiting");
    expect(linkSource).toHaveBeenCalledTimes(2);
  });

  it("swaps each one once, however often the job is looked at again", async () => {
    let release!: () => void;
    const linkSource = vi.fn(() => new Promise<typeof LINKED>((resolve) => { release = () => resolve(LINKED); }));
    const { queue } = makeQueue({ linkSource: linkSource as never });
    const job = queue.add("https://example.com/a", "article", undefined, { linkBack: [waiting()] });
    await until(() => expect(linkSource).toHaveBeenCalledOnce());
    (queue as unknown as { swapLinkBacks(job: ArticleJob): void }).swapLinkBacks(queue.get(job.id)!);
    release();
    await settled(queue);
    expect(linkSource).toHaveBeenCalledOnce();
  });
});

describe("link-backs across a restart", () => {
  const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "article-queue-")), "queue.json");
  const silence = () => vi.spyOn(console, "log").mockImplementation(() => {});
  const snapshot = (jobs: object[]) => JSON.stringify({ version: 1, saved_at: "x", pending: [], jobs, durations_ms: [] });
  const finished = (overrides: object) => {
    const now = new Date().toISOString();
    return { id: "j1", url: "https://example.com/a", importMode: "article", created_at: now, updated_at: now, ...overrides };
  };

  it("saves them, and shows them in the job view", async () => {
    const file = tmpFile();
    const log = silence();
    const { queue } = makeQueue({
      stateFile: file,
      workers: 1,
      processJob: () => new Promise<void>(() => {}),
    });
    const job = queue.add("https://example.com/a", "article", undefined, { linkBack: [waiting()] });
    expect(queue.view(queue.get(job.id)!).link_back).toEqual([waiting()]);
    const saved = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(saved.jobs[0].link_back).toEqual([waiting()]);
    log.mockRestore();
  });

  it("resumes swaps for a job that finished before the restart", async () => {
    const file = tmpFile();
    const log = silence();
    fs.writeFileSync(file, snapshot([
      finished({ status: "done", relay_path: "Lens Edu/articles/a.md", title: "A", link_back: [waiting({ attempts: 1, error: "relay busy" })] }),
    ]));
    const { queue, linkSource } = makeQueue({ stateFile: file });
    await settled(queue);
    expect(linkSource.mock.calls[0]).toMatchObject([{ target: "Lens Edu/articles/a.md", title: "A" }]);
    expect(queue.get("j1")?.link_back?.[0]).toMatchObject({ state: "linked", attempts: 2 });
    expect(JSON.parse(fs.readFileSync(file, "utf-8")).jobs[0].link_back[0].state).toBe("linked");
    log.mockRestore();
  });

  it("resumes for a skipped job, and leaves settled, failed and running ones", async () => {
    const file = tmpFile();
    const log = silence();
    fs.writeFileSync(file, snapshot([
      finished({ id: "skipped", status: "skipped", relay_path: "Lens Edu/articles/a.md", link_back: [waiting()] }),
      finished({ id: "settled", status: "done", relay_path: "Lens Edu/articles/b.md", link_back: [waiting({ state: "linked" })] }),
      finished({ id: "failed", status: "failed", link_back: [waiting()] }),
      finished({ id: "plain", status: "done", relay_path: "Lens Edu/articles/c.md" }),
    ]));
    const { queue, linkSource } = makeQueue({ stateFile: file });
    await settled(queue);
    expect(linkSource).toHaveBeenCalledOnce();
    expect(queue.get("skipped")?.link_back?.[0].state).toBe("linked");
    expect(queue.get("failed")?.link_back?.[0].state).toBe("waiting");
    log.mockRestore();
  });

  it("swaps a job that was interrupted once it finishes", async () => {
    const file = tmpFile();
    const log = silence();
    fs.writeFileSync(file, snapshot([finished({ status: "processing", link_back: [waiting()] })]));
    const { queue, linkSource } = makeQueue({ stateFile: file });
    await settled(queue);
    expect(queue.get("j1")?.status).toBe("done");
    expect(linkSource).toHaveBeenCalledOnce();
    log.mockRestore();
  });
});

describe("the library index, from the queue", () => {
  const library = () => new LibraryIndex({ load: async () => ({ articles: [], transcripts: [] }) });

  it("shows an imported document at once", async () => {
    const index = library();
    const { queue } = makeQueue({ library: index });
    queue.add("https://example.com/a?utm_source=x", "article");
    await settled(queue);
    expect(index.lookup("https://example.com/a")).toEqual({
      path: "Lens Edu/articles/a.md",
      title: "The article",
      stub: false,
      sourceUrl: "https://example.com/a?utm_source=x",
    });
  });

  it("marks a stub-mode import as a stub", async () => {
    const index = library();
    const { queue } = makeQueue({ library: index });
    queue.add("https://example.com/a", "stub");
    await settled(queue);
    expect(index.lookup("https://example.com/a")?.stub).toBe(true);
  });

  it("records a skip the index doesn't know, and keeps what it does know", async () => {
    const index = library();
    index.add({ url: "https://example.com/known", path: "Lens Edu/articles/known.md", title: "Known", stub: false });
    const { queue } = makeQueue({
      library: index,
      processJob: async () => {
        throw new DuplicateDocumentError("Already imported", "Lens Edu/articles/elsewhere.md");
      },
    });
    queue.add("https://example.com/known", "stub");
    queue.add("https://example.com/unknown", "article");
    await settled(queue);
    expect(index.lookup("https://example.com/known")).toMatchObject({ path: "Lens Edu/articles/known.md", stub: false });
    expect(index.lookup("https://example.com/unknown")).toMatchObject({ path: "Lens Edu/articles/elsewhere.md", stub: false });
  });

  it("records nothing for a failed import", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const index = library();
    const { queue } = makeQueue({
      library: index,
      processJob: async (job) => {
        job.relay_path = "Lens Edu/articles/stub.md";
        throw new Error("boom");
      },
    });
    queue.add("https://example.com/a", "article");
    await settled(queue);
    expect(index.lookup("https://example.com/a")).toBeUndefined();
    error.mockRestore();
  });
});
