import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { ImportResultRow, JobLinkBack } from "../../shared/source-links-contract";
import { RelayLinkError } from "../add-video/relay-docs";
import { signShareToken, type ShareTokenPayload } from "../share-token";
import { DuplicateDocumentError } from "./duplicate";
import { LibraryIndex, type LibraryDocs } from "./library-index";
import { ArticleJobQueue } from "./queue";
import { createAddArticleRoutes, EDU_FOLDER } from "./routes";
import type { ArticleJob } from "./types";

const ALL_FOLDERS = "00000000-0000-0000-0000-000000000000";
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

function makeToken(overrides: Partial<ShareTokenPayload> = {}): string {
  return signShareToken({
    purpose: "share",
    role: "edit",
    folder: ALL_FOLDERS,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  });
}

const article = (name: string, url: string, title: string, tags = "") => ({
  path: `Lens Edu/articles/${name}.md`,
  frontmatter: `---\ntitle: "${title}"\nsource_url: "${url}"\n${tags}---`,
});
const library = (docs: Partial<LibraryDocs>) =>
  new LibraryIndex({ load: async () => ({ articles: [], transcripts: [], ...docs }) });
async function loaded(docs: Partial<LibraryDocs>) {
  const index = library(docs);
  index.ensureLoaded();
  await flush();
  return index;
}

interface Setup {
  index?: LibraryIndex;
  processJob?: (job: ArticleJob) => Promise<void>;
  workers?: number;
  linkSource?: ReturnType<typeof vi.fn>;
  resolveDocId?: ReturnType<typeof vi.fn>;
}

function setup(options: Setup = {}) {
  const linkSource = options.linkSource ?? vi.fn(async () => ({ linked: 1, suggested: 0, unswappable: 0 }));
  const resolveDocId = options.resolveDocId ?? vi.fn(async (path: string) => `relay-${path}`);
  const index = options.index ?? library({});
  const queue = new ArticleJobQueue({
    workers: options.workers ?? 1,
    stateFile: null,
    processJob: options.processJob ?? (() => new Promise<void>(() => {})),
    linkSource: linkSource as never,
    linkRetryDelaysMs: [0],
    library: index,
  });
  const app = new Hono();
  app.route(
    "/api/add-article",
    createAddArticleRoutes(queue, {
      library: index,
      linkSource: linkSource as never,
      resolveDocId: resolveDocId as never,
    }),
  );
  const post = (path: string, body: unknown, token = makeToken()) =>
    app.request(`/api/add-article${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  return { app, queue, linkSource, resolveDocId, index, post };
}

const linkBack = { path: "Lens/Notes/a.md", actor: "human:Luc", author: "Luc" };

describe("POST /api/add-article/links/check", () => {
  const check = async (s: ReturnType<typeof setup>, urls: unknown[]) => {
    const resp = await s.post("/links/check", { urls });
    expect(resp.status).toBe(200);
    return resp.json();
  };

  it("requires an edit token and a list of at most 300", async () => {
    const s = setup();
    const noAuth = await s.app.request("/api/add-article/links/check", { method: "POST", body: "{}" });
    expect(noAuth.status).toBe(401);
    expect((await s.post("/links/check", { urls: [] }, makeToken({ role: "view" }))).status).toBe(403);
    expect((await s.post("/links/check", {})).status).toBe(400);
    expect((await s.post("/links/check", { urls: "https://example.com/a" })).status).toBe(400);
    const tooMany = Array.from({ length: 301 }, (_, i) => `https://example.com/${i}`);
    expect((await s.post("/links/check", { urls: tooMany })).status).toBe(400);
    const allowed = Array.from({ length: 300 }, (_, i) => `https://example.com/${i}`);
    expect((await s.post("/links/check", { urls: allowed })).status).toBe(200);
  });

  it("leaves out what isn't a source, and keeps each URL as sent", async () => {
    const s = setup({ index: await loaded({}) });
    const data = await check(s, [
      "https://example.com/post",
      "https://github.com/a/b",
      "https://example.com/figure.png",
      "not a url",
      42,
      "https://youtu.be/abcdefghijk",
      "HTTPS://Example.com/Post?utm_source=x",
    ]);
    expect(data.links).toEqual([
      { url: "https://example.com/post", key: "https://example.com/post", kind: "article", state: "new" },
      { url: "https://youtu.be/abcdefghijk", key: "yt:abcdefghijk", kind: "video", state: "new" },
      { url: "HTTPS://Example.com/Post?utm_source=x", key: "https://example.com/Post", kind: "article", state: "new" },
    ]);
  });

  it("reports the queue in the contract's shape", async () => {
    const s = setup({ index: await loaded({}) });
    const data = await check(s, []);
    expect(data).toEqual({
      ready: true,
      links: [],
      queue: { workers: 1, avg_job_minutes: 8, queued: 0, processing: 0 },
    });
  });

  it("is not ready on the first call, then knows the library", async () => {
    const index = library({ articles: [article("a", "https://www.example.com/a", "A")] });
    const s = setup({ index });
    const first = await check(s, ["https://example.com/a/"]);
    expect(first.ready).toBe(false);
    expect(first.links[0].state).toBe("new");
    await flush();
    const second = await check(s, ["https://example.com/a/"]);
    expect(second.ready).toBe(true);
    expect(second.links[0]).toEqual({
      url: "https://example.com/a/",
      key: "https://example.com/a",
      kind: "article",
      state: "library",
      path: "Lens Edu/articles/a.md",
      title: "A",
    });
  });

  it("tells a stub from a full copy", async () => {
    const stub = article("s", "https://example.com/s", "S", 'tags:\n  - "article-stub"\n');
    const s = setup({ index: await loaded({ articles: [stub] }) });
    const data = await check(s, ["https://example.com/s"]);
    expect(data.links[0]).toMatchObject({ state: "stub", path: "Lens Edu/articles/s.md", title: "S" });
  });

  it("lets a running job win over the index", async () => {
    const stub = article("s", "https://example.com/s", "S", 'tags:\n  - "article-stub"\n');
    const s = setup({ index: await loaded({ articles: [stub] }) });
    const running = s.queue.add("https://example.com/s", "article");
    const waiting = s.queue.add("https://example.com/w", "article");
    await flush();
    const data = await check(s, ["https://example.com/s", "https://www.example.com/w/"]);
    expect(data.links[0]).toMatchObject({
      state: "importing",
      job_id: running.id,
      path: "Lens Edu/articles/s.md",
      title: "S",
    });
    expect(data.links[0].eta_minutes).toEqual(expect.any(Number));
    expect(data.links[1]).toMatchObject({ state: "queued", job_id: waiting.id, queue_position: 1 });
    expect(data.queue).toMatchObject({ queued: 1, processing: 1 });
  });

  it("stops showing a job as running once it is being stopped", async () => {
    const s = setup({ index: await loaded({}) });
    const job = s.queue.add("https://example.com/a", "article");
    await flush();
    // A run that ignores its abort stays "processing" like this.
    s.queue.get(job.id)!.cancel_requested = true;
    const data = await check(s, ["https://example.com/a"]);
    expect(data.links[0].state).toBe("new");
    expect(data.links[0]).not.toHaveProperty("job_id");
  });

  it("counts a finished job's document as in the library, before any scan has seen it", async () => {
    const s = setup({
      index: library({}),
      workers: 2,
      processJob: async (job) => {
        job.relay_path = "Lens Edu/articles/a.md";
        job.title = "A";
      },
    });
    s.queue.add("https://example.com/a", "article");
    s.queue.add("https://example.com/b", "stub");
    await flush();
    const data = await check(s, ["https://example.com/a", "https://example.com/b"]);
    expect(data.links[0]).toMatchObject({ state: "library", path: "Lens Edu/articles/a.md", title: "A" });
    expect(data.links[1]).toMatchObject({ state: "stub" });
  });

  it("goes by the exact page, for the library and for jobs", async () => {
    const stored = [article("view", "https://example.com/view?ref=222", "View"), article("app", "https://example.com/app", "App")];
    const s = setup({ index: await loaded({ articles: stored }) });
    const running = s.queue.add("https://example.com/job#/a", "article");
    await flush();
    const data = await check(s, [
      "https://example.com/view?ref=222",
      "https://example.com/view?ref=111",
      "https://example.com/app#notes",
      "https://example.com/app#/route",
      "https://example.com/job#/a",
      "https://example.com/job#/b",
    ]);
    expect(data.links.map((l: { state: string }) => l.state)).toEqual(["library", "new", "library", "new", "importing", "new"]);
    expect(data.links[4].job_id).toBe(running.id);
    expect(data.links[5]).not.toHaveProperty("job_id");
  });

  describe("with a path", () => {
    const page = "Lens/Notes/a.md";
    // setup() resolves a path to `relay-<path>`.
    const link = (overrides: Partial<JobLinkBack> = {}): JobLinkBack => ({
      doc_id: `relay-${page}`,
      doc_path: page,
      actor: "human:Luc",
      author: "Luc",
      protect_human: false,
      urls: ["https://example.com/a"],
      state: "waiting",
      ...overrides,
    });
    const other = () => link({ doc_id: "relay-Lens/Notes/b.md", doc_path: "Lens/Notes/b.md" });
    const checkPage = async (s: ReturnType<typeof setup>, url = "https://example.com/a") => {
      const resp = await s.post("/links/check", { urls: [url], path: page });
      expect(resp.status).toBe(200);
      return (await resp.json()).links[0];
    };
    const stubbed = () =>
      loaded({ articles: [article("a", "https://example.com/a", "A", 'tags:\n  - "article-stub"\n')] });

    it("counts a running job with a link-back to the page", async () => {
      const s = setup({ index: await loaded({}) });
      const job = s.queue.add("https://example.com/a", "article", undefined, { linkBack: [link()] });
      await flush();
      expect(await checkPage(s)).toMatchObject({ state: "importing", job_id: job.id });
    });

    // Someone else's import isn't this page's news, and accepting here joins it.
    it("reports what the library says past anyone else's running job", async () => {
      const fresh = setup({ index: await loaded({}) });
      fresh.queue.add("https://example.com/a", "article", undefined, { linkBack: [other()] });
      await flush();
      const row = await checkPage(fresh);
      expect(row.state).toBe("new");
      expect(row).not.toHaveProperty("job_id");
      expect(row).not.toHaveProperty("queue_position");

      const stub = setup({ index: await stubbed() });
      stub.queue.add("https://example.com/a", "article");
      await flush();
      const stubRow = await checkPage(stub);
      expect(stubRow).toMatchObject({ state: "stub", path: "Lens Edu/articles/a.md" });
      expect(stubRow).not.toHaveProperty("job_id");

      const held = setup({ index: await loaded({ articles: [article("a", "https://example.com/a", "A")] }) });
      held.queue.add("https://example.com/a", "article");
      await flush();
      expect(await checkPage(held)).toMatchObject({ state: "library", title: "A" });
    });

    it("joins that job when the page accepts", async () => {
      const s = setup({ index: await loaded({}) });
      const job = s.queue.add("https://example.com/a", "article", undefined, { linkBack: [other()] });
      await flush();
      const resp = await s.post("", { urls: ["https://example.com/a"], importMode: "article", linkBack: { ...linkBack, path: page } });
      expect((await resp.json()).results[0]).toMatchObject({ status: "already_queued", id: job.id });
      expect(await checkPage(s)).toMatchObject({ state: "importing", job_id: job.id });
    });

    describe("when the job failed", () => {
      const fails = async () => {
        throw new Error("boom");
      };
      beforeEach(() => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        return () => vi.restoreAllMocks();
      });

      it("shows the failure on the page it was for", async () => {
        const s = setup({ index: await loaded({}), processJob: fails });
        const job = s.queue.add("https://example.com/a", "article", undefined, { linkBack: [link()] });
        await flush();
        expect(await checkPage(s)).toMatchObject({ state: "failed", job_id: job.id, error: "boom", link_state: "waiting" });
      });

      it("reads as new or stub on any other page", async () => {
        const fresh = setup({ index: await loaded({}), processJob: fails });
        fresh.queue.add("https://example.com/a", "article", undefined, { linkBack: [other()] });
        await flush();
        const row = await checkPage(fresh);
        expect(row.state).toBe("new");
        expect(row).not.toHaveProperty("error");
        expect(row).not.toHaveProperty("link_state");

        const stub = setup({ index: await stubbed(), processJob: fails });
        stub.queue.add("https://example.com/a", "article");
        await flush();
        expect((await checkPage(stub)).state).toBe("stub");
      });
    });

    it("reports what became of the page's link-back once the job ended", async () => {
      const s = setup({
        index: await loaded({}),
        linkSource: vi.fn(async () => ({ linked: 0, suggested: 1, unswappable: 0 })),
        processJob: async (job) => {
          job.relay_path = "Lens Edu/articles/a.md";
        },
      });
      s.queue.add("https://example.com/a", "article", undefined, { linkBack: [link()] });
      await flush();
      expect(await checkPage(s)).toMatchObject({ state: "library", link_state: "suggested" });
    });

    it("gives no link_state for another page's link-back, or while the page's job runs", async () => {
      const s = setup({
        index: await loaded({}),
        processJob: async (job) => {
          job.relay_path = "Lens Edu/articles/a.md";
        },
      });
      s.queue.add("https://example.com/a", "article", undefined, { linkBack: [other()] });
      await flush();
      expect(await checkPage(s)).not.toHaveProperty("link_state");

      const running = setup({ index: await loaded({}) });
      running.queue.add("https://example.com/a", "article", undefined, { linkBack: [link({ state: "waiting" })] });
      await flush();
      expect(await checkPage(running)).not.toHaveProperty("link_state");
    });

    it("gives no link_state without a path", async () => {
      const s = setup({
        index: await loaded({}),
        processJob: async (job) => {
          job.relay_path = "Lens Edu/articles/a.md";
        },
      });
      s.queue.add("https://example.com/a", "article", undefined, { linkBack: [link()] });
      await flush();
      expect((await check(s, ["https://example.com/a"])).links[0]).not.toHaveProperty("link_state");
    });

    it("shows anyone's job without a path, as before", async () => {
      const s = setup({ index: await loaded({}) });
      const job = s.queue.add("https://example.com/a", "article", undefined, { linkBack: [other()] });
      await flush();
      expect((await check(s, ["https://example.com/a"])).links[0]).toMatchObject({ state: "importing", job_id: job.id });
    });

    it("needs a string, and a folder the token reaches", async () => {
      const s = setup({ index: await loaded({}) });
      expect((await s.post("/links/check", { urls: [], path: 7 })).status).toBe(400);
      expect((await s.post("/links/check", { urls: [], path: page }, makeToken({ folder: EDU_FOLDER }))).status).toBe(403);
    });
  });

  describe("failed", () => {
    const failing = (seen: string[] = []) => async (job: ArticleJob) => {
      seen.push(job.id);
      throw new Error(`boom ${seen.length}`);
    };
    beforeEach(() => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      return () => vi.restoreAllMocks();
    });

    it("shows the latest job's error", async () => {
      const s = setup({ index: await loaded({}), processJob: failing() });
      s.queue.add("https://example.com/a", "article");
      await flush();
      const latest = s.queue.add("https://example.com/a/", "article");
      await flush();
      const data = await check(s, ["https://example.com/a"]);
      expect(data.links[0]).toMatchObject({ state: "failed", job_id: latest.id, error: "boom 2" });
    });

    it("doesn't show when a later job was cancelled instead", async () => {
      const s = setup({ index: await loaded({}), processJob: failing() });
      s.queue.add("https://example.com/a", "article");
      await flush();
      const later = s.queue.add("https://example.com/a", "article");
      s.queue.cancel(later.id);
      await flush();
      const data = await check(s, ["https://example.com/a"]);
      expect(data.links[0].state).toBe("new");
    });

    it("doesn't show once the library has the source", async () => {
      const index = await loaded({});
      const s = setup({ index, processJob: failing() });
      s.queue.add("https://example.com/a", "article");
      await flush();
      index.add({ url: "https://example.com/a", path: "Lens Edu/articles/a.md", stub: false });
      const data = await check(s, ["https://example.com/a"]);
      expect(data.links[0].state).toBe("library");
    });

    // A full import writes its stub first, so most failures leave one behind.
    it("shows over the stub a failed import left", async () => {
      const stub = article("s", "https://example.com/s", "S", 'tags:\n  - "article-stub"\n');
      const s = setup({ index: await loaded({ articles: [stub] }), processJob: failing() });
      s.queue.add("https://example.com/s", "article");
      await flush();
      const data = await check(s, ["https://example.com/s"]);
      expect(data.links[0]).toMatchObject({ state: "failed", path: "Lens Edu/articles/s.md" });
    });
  });
});

describe("POST /api/add-article with linkBack", () => {
  const rows = async (resp: Response): Promise<ImportResultRow[]> => (await resp.json()).results;
  const inLibrary = (url = "https://www.example.com/a") => loaded({ articles: [article("a", url, "A")] });

  describe("the request", () => {
    it.each([
      ["not an object", "x"],
      ["null", null],
      ["no path", { actor: "human:Luc", author: "Luc" }],
      ["a path with no folder", { ...linkBack, path: "a.md" }],
      ["no actor", { path: linkBack.path, author: "Luc" }],
      ["an actor of no known kind", { ...linkBack, actor: "Luc" }],
      ["an ai actor in another case", { ...linkBack, actor: "AI:fable" }],
      ["no author", { path: linkBack.path, actor: "human:Luc" }],
      ["a blank author", { ...linkBack, author: "  " }],
      ["a protectHuman that isn't a boolean", { ...linkBack, protectHuman: "yes" }],
    ])("refuses %s, and queues nothing", async (_name, value) => {
      const s = setup();
      const resp = await s.post("", { urls: ["https://example.com/a"], importMode: "article", linkBack: value });
      expect(resp.status).toBe(400);
      expect(s.queue.status()).toEqual([]);
    });

    // A wikilink to an article stays literal text on the platform, so a swap
    // in a lens would break a working link for learners.
    it("refuses a page under Lens Edu/, whatever the token", async () => {
      for (const folder of [ALL_FOLDERS, EDU_FOLDER]) {
        const s = setup();
        const resp = await s.post(
          "",
          { urls: ["https://example.com/a"], importMode: "article", linkBack: { ...linkBack, path: "Lens Edu/modules/a.md" } },
          makeToken({ folder }),
        );
        expect(resp.status).toBe(400);
        expect((await resp.json()).error).toMatch(/Lens Edu/);
        expect(s.resolveDocId).not.toHaveBeenCalled();
        expect(s.queue.status()).toEqual([]);
      }
    });

    it.each([
      ["in the trash", "Lens/_trash/a.md"],
      ["that isn't Markdown", "Lens/page.html"],
    ])("refuses a page %s", async (_name, path) => {
      const s = setup();
      const resp = await s.post("", { urls: ["https://example.com/a"], importMode: "article", linkBack: { ...linkBack, path } });
      expect(resp.status).toBe(400);
    });

    it("answers 403 when the token can't write the page's folder", async () => {
      const s = setup();
      const resp = await s.post(
        "",
        { urls: ["https://example.com/a"], importMode: "article", linkBack },
        makeToken({ folder: EDU_FOLDER }),
      );
      expect(resp.status).toBe(403);
      expect(s.resolveDocId).not.toHaveBeenCalled();
      expect(s.queue.status()).toEqual([]);
    });

    it("answers 404 for a page that doesn't exist", async () => {
      const s = setup({ resolveDocId: vi.fn(async () => null) });
      const resp = await s.post("", { urls: ["https://example.com/a"], importMode: "article", linkBack });
      expect(resp.status).toBe(404);
      expect(s.queue.status()).toEqual([]);
    });

    it("answers 502 when the relay can't say, and queues nothing", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const s = setup({ resolveDocId: vi.fn(async () => { throw new Error("relay down"); }) });
      const resp = await s.post("", { urls: ["https://example.com/a"], importMode: "article", linkBack });
      expect(resp.status).toBe(502);
      expect(s.queue.status()).toEqual([]);
      error.mockRestore();
    });

    it("pins the page's doc id at submit, on the job", async () => {
      const s = setup();
      await s.post("", { urls: ["https://example.com/a"], importMode: "article", linkBack });
      expect(s.resolveDocId).toHaveBeenCalledWith("Lens/Notes/a.md");
      expect(s.queue.status()[0].link_back?.[0]).toMatchObject({
        doc_id: "relay-Lens/Notes/a.md",
        doc_path: "Lens/Notes/a.md",
        actor: "human:Luc",
        author: "Luc",
        state: "waiting",
      });
    });

    it("forces protectHuman for an ai actor, and honours it for a person", async () => {
      const s = setup();
      await s.post("", {
        urls: ["https://example.com/a"],
        importMode: "article",
        linkBack: { ...linkBack, actor: "ai:fable-5:luc", protectHuman: false },
      });
      await s.post("", {
        urls: ["https://example.com/b"],
        importMode: "article",
        linkBack: { ...linkBack, protectHuman: true },
      });
      await s.post("", { urls: ["https://example.com/c"], importMode: "article", linkBack });
      expect(s.queue.status().map((job) => job.link_back?.[0].protect_human)).toEqual([true, true, false]);
    });

    it("keeps the 20-URL cap", async () => {
      const s = setup();
      const urls = Array.from({ length: 21 }, (_, i) => `https://example.com/${i}`);
      expect((await s.post("", { urls, importMode: "article", linkBack })).status).toBe(400);
    });

    it("marks an invalid URL invalid, as sent", async () => {
      const s = setup();
      const urls = ["not a url", "https://www.youtube.com/@channel", "https://example.com/a"];
      const results = await rows(await s.post("", { urls, importMode: "article", linkBack }));
      expect(results.map((r) => [r.url, r.status])).toEqual([
        ["not a url", "invalid"],
        ["https://www.youtube.com/@channel", "invalid"],
        ["https://example.com/a", "queued"],
      ]);
    });
  });

  describe("a source already in the library", () => {
    it("swaps now, with every spelling, and answers with the path and title", async () => {
      const s = setup({ index: await inLibrary() });
      const resp = await s.post("", { urls: ["https://example.com/a/?utm_source=x"], importMode: "article", linkBack });
      expect(resp.status).toBe(200);
      expect(await rows(resp)).toEqual([
        { url: "https://example.com/a/?utm_source=x", status: "linked", path: "Lens Edu/articles/a.md", title: "A" },
      ]);
      expect(s.queue.status()).toEqual([]);
      const request = s.linkSource.mock.calls[0][0];
      expect(request).toMatchObject({
        docId: "relay-Lens/Notes/a.md",
        target: "Lens Edu/articles/a.md",
        title: "A",
        actor: "human:Luc",
        author: "Luc",
        protectHuman: false,
      });
      expect(request.urls).toEqual(expect.arrayContaining([
        "https://example.com/a/?utm_source=x",
        "https://example.com/a",
        "https://www.example.com/a",
      ]));
    });

    // Prevents: a link being rewritten at once to a different article, because
    // the dedup key folds what tells the two apart.
    it("goes to a job when the library only has a neighbouring page", async () => {
      const s = setup({ index: await inLibrary("https://example.com/view?ref=222") });
      const results = await rows(await s.post("", { urls: ["https://example.com/view?ref=111"], importMode: "article", linkBack }));
      expect(results[0].status).toBe("queued");
      expect(s.linkSource).not.toHaveBeenCalled();
    });

    it("swaps when the only difference is a tracking ref or a fragment", async () => {
      const s = setup({ index: await inLibrary("https://example.com/view") });
      const urls = ["https://example.com/view?ref=hn", "https://example.com/view#notes"];
      const results = await rows(await s.post("", { urls, importMode: "article", linkBack }));
      expect(results.map((r) => r.status)).toEqual(["linked", "linked"]);
      expect(s.linkSource).toHaveBeenCalledOnce();
      expect(s.linkSource.mock.calls[0][0].urls).toEqual(expect.arrayContaining(urls));
    });

    it("keeps a video's spellings together", async () => {
      const url = "https://www.youtube.com/watch?v=abcdefghijk";
      const index = await loaded({
        transcripts: [{ path: "Lens Edu/video_transcripts/v.md", frontmatter: `---\ntitle: "V"\nurl: "${url}"\n---` }],
      });
      const s = setup({ index });
      const results = await rows(await s.post("", { urls: ["https://youtu.be/abcdefghijk?si=x"], importMode: "article", linkBack }));
      expect(results[0]).toMatchObject({ status: "linked", path: "Lens Edu/video_transcripts/v.md", title: "V" });
      expect(s.linkSource.mock.calls[0][0].urls).toContain(url);
    });

    it("sends a person's protectHuman to the relay", async () => {
      const s = setup({ index: await inLibrary() });
      await s.post("", { urls: ["https://example.com/a"], importMode: "article", linkBack: { ...linkBack, protectHuman: true } });
      expect(s.linkSource.mock.calls[0][0]).toMatchObject({ actor: "human:Luc", protectHuman: true });
    });

    it("reports suggested for an agent's swap of human text", async () => {
      const s = setup({
        index: await inLibrary(),
        linkSource: vi.fn(async () => ({ linked: 0, suggested: 1, unswappable: 0 })),
      });
      const results = await rows(await s.post("", {
        urls: ["https://example.com/a"],
        importMode: "article",
        linkBack: { ...linkBack, actor: "ai:fable-5:luc" },
      }));
      expect(results[0]).toMatchObject({ status: "suggested", path: "Lens Edu/articles/a.md", title: "A" });
      expect(s.linkSource.mock.calls[0][0].protectHuman).toBe(true);
    });

    it("reports link_failed with the relay's error, and queues nothing", async () => {
      const s = setup({ index: await inLibrary(), linkSource: vi.fn(async () => { throw new Error("relay down"); }) });
      const results = await rows(await s.post("", { urls: ["https://example.com/a"], importMode: "article", linkBack }));
      expect(results).toEqual([
        { url: "https://example.com/a", status: "link_failed", path: "Lens Edu/articles/a.md", title: "A", error: "relay down" },
      ]);
      expect(s.queue.status()).toEqual([]);
    });

    it("reports link_failed when the link has gone, or can't be swapped", async () => {
      const gone = setup({ index: await inLibrary(), linkSource: vi.fn(async () => ({ linked: 0, suggested: 0, unswappable: 0 })) });
      const [row] = await rows(await gone.post("", { urls: ["https://example.com/a"], importMode: "article", linkBack }));
      expect(row).toMatchObject({ status: "link_failed", error: "The link is no longer on the page" });

      const stuck = setup({ index: await inLibrary(), linkSource: vi.fn(async () => ({ linked: 0, suggested: 0, unswappable: 1 })) });
      const [other] = await rows(await stuck.post("", { urls: ["https://example.com/a"], importMode: "article", linkBack }));
      expect(other).toMatchObject({ status: "link_failed", error: expect.stringContaining("can't become a wikilink") });
    });

    // Prevents: a hung relay holding the request for 20 × 60 s.
    it("stops calling the relay after a failure, but not after a missing target", async () => {
      const urls = ["https://example.com/a", "https://example.com/b", "https://example.com/c"];
      const index = await loaded({
        articles: urls.map((url, i) => article(`d${i}`, url, `D${i}`)),
      });
      const down = setup({ index, linkSource: vi.fn(async () => { throw new Error("relay down"); }) });
      const results = await rows(await down.post("", { urls, importMode: "article", linkBack }));
      expect(results.map((r) => [r.status, r.error])).toEqual(urls.map(() => ["link_failed", "relay down"]));
      expect(down.linkSource).toHaveBeenCalledOnce();

      const missing = setup({ index, linkSource: vi.fn(async () => { throw new RelayLinkError("target_missing"); }) });
      await missing.post("", { urls, importMode: "article", linkBack });
      expect(missing.linkSource).toHaveBeenCalledTimes(3);
    });

    it("answers for the whole request when the page itself can't be linked", async () => {
      const urls = ["https://example.com/a", "https://example.com/b"];
      const index = await loaded({ articles: urls.map((url, i) => article(`d${i}`, url, `D${i}`)) });
      const s = setup({ index, linkSource: vi.fn(async () => { throw new RelayLinkError("page_not_eligible"); }) });
      const results = await rows(await s.post("", { urls, importMode: "article", linkBack }));
      expect(results.map((r) => r.status)).toEqual(["link_failed", "link_failed"]);
      expect(results[1].error).toMatch(/can't link to the library/);
      expect(s.linkSource).toHaveBeenCalledOnce();
    });

    it("runs a job anyway when replaceExisting asks for a new import", async () => {
      const url = "https://www.youtube.com/watch?v=abcdefghijk";
      const index = await loaded({
        transcripts: [{ path: "Lens Edu/video_transcripts/v.md", frontmatter: `---\nurl: "${url}"\n---` }],
      });
      const s = setup({ index });
      const results = await rows(await s.post("", { urls: [url], importMode: "article", replaceExisting: true, linkBack }));
      expect(results[0].status).toBe("queued");
      expect(s.linkSource).not.toHaveBeenCalled();
      expect(s.queue.status()[0]).toMatchObject({ replaceExisting: true, link_back: [{ state: "waiting" }] });
    });
  });

  describe("a source that isn't ready", () => {
    it("queues a job for a new source, holding the link-back", async () => {
      const s = setup({ index: await loaded({}) });
      const results = await rows(await s.post("", { urls: ["https://example.com/a"], importMode: "article", linkBack }));
      expect(results[0]).toMatchObject({ url: "https://example.com/a", status: "queued", queue_position: 0 });
      expect(s.linkSource).not.toHaveBeenCalled();
      expect(s.queue.get(results[0].id!)?.link_back?.[0].urls).toContain("https://example.com/a");
    });

    it("imports over a stub rather than linking to it", async () => {
      const stub = article("s", "https://example.com/s", "S", 'tags:\n  - "article-stub"\n');
      const s = setup({ index: await loaded({ articles: [stub] }) });
      const results = await rows(await s.post("", { urls: ["https://example.com/s"], importMode: "article", linkBack }));
      expect(results[0].status).toBe("queued");
      expect(s.linkSource).not.toHaveBeenCalled();
    });

    it("attaches to an active job", async () => {
      const s = setup({ index: await loaded({}) });
      const job = s.queue.add("https://example.com/a", "article");
      await flush();
      const results = await rows(await s.post("", { urls: ["https://www.example.com/a/?utm_source=x"], importMode: "article", linkBack }));
      expect(results[0]).toMatchObject({
        url: "https://www.example.com/a/?utm_source=x",
        status: "already_queued",
        id: job.id,
      });
      expect(s.queue.status()).toHaveLength(1);
      expect(s.queue.get(job.id)?.link_back?.[0].urls).toContain("https://www.example.com/a/?utm_source=x");
    });

    // Prevents: a second spelling on the page being left as an external link.
    it("puts every spelling in a request on the one job", async () => {
      const s = setup({ index: await loaded({}) });
      const urls = [
        "https://example.com/a?utm_source=x",
        "HTTPS://EXAMPLE.com/a",
        "https://example.com/a/",
      ];
      const results = await rows(await s.post("", { urls, importMode: "article", linkBack }));
      expect(results.map((r) => [r.url, r.status])).toEqual([
        [urls[0], "queued"],
        [urls[1], "already_queued"],
        [urls[2], "already_queued"],
      ]);
      const id = results[0].id!;
      expect(results.map((r) => r.id)).toEqual([id, id, id]);
      expect(s.queue.status()).toHaveLength(1);
      // Spelled as on the page: validateUrl would have lowercased this host.
      expect(s.queue.get(id)?.link_back?.[0].urls).toEqual(expect.arrayContaining(urls));
    });

    it("attaches every spelling of a request to an active job too", async () => {
      const s = setup({ index: await loaded({}) });
      const job = s.queue.add("https://example.com/a", "article");
      await flush();
      const urls = ["https://example.com/a?utm_source=x", "https://example.com/a/"];
      const results = await rows(await s.post("", { urls, importMode: "article", linkBack }));
      expect(results.map((r) => [r.status, r.id])).toEqual([
        ["already_queued", job.id],
        ["already_queued", job.id],
      ]);
      expect(s.queue.get(job.id)?.link_back).toHaveLength(1);
      expect(s.queue.get(job.id)?.link_back?.[0].urls).toEqual(expect.arrayContaining(urls));
    });

    it("gives every spelling of a library source the one swap", async () => {
      const s = setup({ index: await inLibrary() });
      const urls = ["https://example.com/a?utm_source=x", "https://example.com/a/"];
      const results = await rows(await s.post("", { urls, importMode: "article", linkBack }));
      expect(results.map((r) => [r.url, r.status, r.path])).toEqual([
        [urls[0], "linked", "Lens Edu/articles/a.md"],
        [urls[1], "linked", "Lens Edu/articles/a.md"],
      ]);
      expect(s.linkSource).toHaveBeenCalledOnce();
      expect(s.linkSource.mock.calls[0][0].urls).toEqual(expect.arrayContaining(urls));
    });

    // Prevents: two articles on one page sharing a job, and both links becoming
    // whichever imported first.
    it.each([
      ["refs", "https://example.com/view?ref=111", "https://example.com/view?ref=222"],
      ["app routes", "https://example.com/app#/a", "https://example.com/app#/b"],
      ["ports", "https://example.com:8443/x", "https://example.com:9443/x"],
    ])("treats two %s on one page as two sources", async (_name, first, second) => {
      const s = setup({ index: await loaded({}), workers: 2 });
      const results = await rows(await s.post("", { urls: [first, second], importMode: "article", linkBack }));
      expect(results.map((r) => r.status)).toEqual(["queued", "queued"]);
      expect(results[0].id).not.toBe(results[1].id);
      const spellings = results.map((r) => s.queue.get(r.id!)?.link_back?.[0].urls);
      expect(spellings[0]).toContain(first);
      expect(spellings[0]).not.toContain(second);
      expect(spellings[1]).toContain(second);
      expect(spellings[1]).not.toContain(first);
    });

    // Without its route, `/app#/b` is a link to `/app`.
    it("doesn't put a bare neighbour among a route's spellings", async () => {
      const s = setup({ index: await loaded({}) });
      const results = await rows(await s.post("", { urls: ["https://example.com/app#/b"], importMode: "article", linkBack }));
      const urls = s.queue.get(results[0].id!)?.link_back?.[0].urls;
      expect(urls).toContain("https://www.example.com/app#/b");
      expect(urls).not.toContain("https://example.com/app");
    });

    it("doesn't swap another source's link with a library hit", async () => {
      const s = setup({ index: await inLibrary("https://example.com/view?ref=222") });
      const urls = ["https://example.com/view?ref=222", "https://example.com/view?ref=111"];
      const results = await rows(await s.post("", { urls, importMode: "article", linkBack }));
      expect(results.map((r) => r.status)).toEqual(["linked", "queued"]);
      expect(s.linkSource.mock.calls[0][0].urls).not.toContain(urls[1]);
    });

    // A bare URL matches either ref, so these two group together, and only the
    // stored URL can tell that the second isn't this document.
    it("leaves a grouped spelling out of a swap it doesn't match", async () => {
      const s = setup({ index: await inLibrary("https://example.com/view?ref=222") });
      const urls = ["https://example.com/view", "https://example.com/view?ref=111"];
      await s.post("", { urls, importMode: "article", linkBack });
      expect(s.linkSource).toHaveBeenCalledOnce();
      expect(s.linkSource.mock.calls[0][0].urls).toContain(urls[0]);
      expect(s.linkSource.mock.calls[0][0].urls).not.toContain(urls[1]);
    });

    it("doesn't join a job for a neighbouring page", async () => {
      const s = setup({ index: await loaded({}), workers: 2 });
      const job = s.queue.add("https://example.com/app#/a", "article");
      await flush();
      const results = await rows(await s.post("", { urls: ["https://example.com/app#/b"], importMode: "article", linkBack }));
      expect(results[0].status).toBe("queued");
      expect(results[0].id).not.toBe(job.id);
      expect(s.queue.get(job.id)).not.toHaveProperty("link_back");
    });

    it("doesn't join a job that is being stopped", async () => {
      const s = setup({ index: await loaded({}) });
      const job = s.queue.add("https://example.com/a", "article");
      await flush();
      // A run that ignores its abort stays "processing" like this.
      s.queue.get(job.id)!.cancel_requested = true;
      const results = await rows(await s.post("", { urls: ["https://example.com/a"], importMode: "article", linkBack }));
      expect(results[0].status).toBe("queued");
      expect(results[0].id).not.toBe(job.id);
      expect(s.queue.get(job.id)).not.toHaveProperty("link_back");
    });

    it("sends a person's protectHuman through a job too", async () => {
      const s = setup({
        index: await loaded({}),
        processJob: async (job) => {
          job.relay_path = "Lens Edu/articles/new.md";
        },
      });
      await s.post("", { urls: ["https://example.com/a"], importMode: "article", linkBack: { ...linkBack, protectHuman: true } });
      await flush();
      expect(s.linkSource.mock.calls[0][0]).toMatchObject({ actor: "human:Luc", protectHuman: true });
    });

    it("folds youtu.be and watch spellings, and adds the canonical one", async () => {
      const s = setup({ index: await loaded({}) });
      const urls = ["https://youtu.be/abcdefghijk?si=x"];
      const results = await rows(await s.post("", { urls, importMode: "article", linkBack }));
      expect(s.queue.get(results[0].id!)?.link_back?.[0].urls).toEqual(expect.arrayContaining([
        urls[0],
        "https://www.youtube.com/watch?v=abcdefghijk",
      ]));
    });
  });

  describe("start to finish", () => {
    it("links through a job when the index isn't ready and the import ends skipped", async () => {
      const s = setup({
        index: library({}),
        processJob: async () => {
          throw new DuplicateDocumentError("Already imported", "Lens Edu/articles/existing.md");
        },
      });
      const results = await rows(await s.post("", { urls: ["https://example.com/a"], importMode: "article", linkBack }));
      expect(results[0].status).toBe("queued");
      await flush();
      expect(s.linkSource.mock.calls[0][0]).toMatchObject({
        target: "Lens Edu/articles/existing.md",
        docId: "relay-Lens/Notes/a.md",
      });
      expect(s.queue.get(results[0].id!)).toMatchObject({
        status: "skipped",
        relay_path: "Lens Edu/articles/existing.md",
        link_back: [{ state: "linked" }],
      });
    });

    it("links after an import, and shows the state in /status", async () => {
      const s = setup({
        index: await loaded({}),
        processJob: async (job) => {
          job.relay_path = "Lens Edu/articles/new.md";
          job.title = "New";
        },
      });
      const [row] = await rows(await s.post("", { urls: ["https://example.com/a"], importMode: "article", linkBack }));
      await flush();
      const status = await (await s.app.request(`/api/add-article/status?id=${row.id}`, {
        headers: { Authorization: `Bearer ${makeToken()}` },
      })).json();
      expect(status.jobs[0]).toMatchObject({ status: "done", link_back: [{ state: "linked", attempts: 1 }] });

      // The next page to link it finds it in the library, without a scan.
      const second = await rows(await s.post("", {
        urls: ["https://example.com/a"],
        importMode: "article",
        linkBack: { ...linkBack, path: "Lens/Notes/b.md" },
      }));
      expect(second[0]).toMatchObject({ status: "linked", path: "Lens Edu/articles/new.md", title: "New" });
    });
  });

  describe("a neighbouring page, through the importer", () => {
    // The importer's duplicate check folds what `sameSource` tells apart, so a
    // link that missed the library comes back from a job as "skipped".
    it("leaves the link and shows the source as not in the library", async () => {
      const page = "Lens/Notes/a.md";
      const s = setup({
        index: await inLibrary("https://example.com/app"),
        processJob: async () => {
          throw new DuplicateDocumentError("Already imported", "Lens Edu/articles/a.md", "https://example.com/app");
        },
      });
      const url = "https://example.com/app#/b";
      const results = await rows(await s.post("", { urls: [url], importMode: "article", linkBack: { ...linkBack, path: page } }));
      expect(results[0].status).toBe("queued");
      await flush();
      expect(s.linkSource).not.toHaveBeenCalled();
      expect(s.queue.get(results[0].id!)).toMatchObject({ status: "skipped", link_back: [{ state: "failed" }] });
      const check = await (await s.post("/links/check", { urls: [url], path: page })).json();
      expect(check.links[0]).toMatchObject({ state: "new", link_state: "failed" });
    });
  });

  describe("POST /:id/retry", () => {
    beforeEach(() => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      return () => vi.restoreAllMocks();
    });

    it("carries the waiting link-backs to the new job, which swaps them", async () => {
      let attempt = 0;
      const s = setup({
        index: await loaded({}),
        processJob: async (job) => {
          if (++attempt === 1) throw new Error("boom");
          job.relay_path = "Lens Edu/articles/a.md";
        },
      });
      const [row] = await rows(await s.post("", { urls: ["https://example.com/a"], importMode: "article", linkBack }));
      await flush();
      expect(s.queue.get(row.id!)?.status).toBe("failed");
      expect(s.queue.get(row.id!)?.link_back?.[0].state).toBe("waiting");

      const retry = await s.post(`/${row.id}/retry`, {});
      expect(retry.status).toBe(200);
      const { id } = await retry.json();
      expect(s.queue.get(row.id!)).not.toHaveProperty("link_back");
      await flush();
      expect(s.queue.get(id)).toMatchObject({ status: "done", retry_of: row.id, link_back: [{ state: "linked" }] });
      expect(s.linkSource).toHaveBeenCalledOnce();
    });

    it("carries them from a cancelled job too", async () => {
      const s = setup({ index: await loaded({}) });
      const [row] = await rows(await s.post("", { urls: ["https://example.com/a"], importMode: "article", linkBack }));
      s.queue.cancel(row.id!);
      await flush();
      const { id } = await (await s.post(`/${row.id}/retry`, {})).json();
      expect(s.queue.get(id)?.link_back?.[0]).toMatchObject({ doc_path: "Lens/Notes/a.md", state: "waiting" });
    });

    it("hands them to a job already running when the retry is refused", async () => {
      const s = setup({ index: await loaded({}) });
      const [row] = await rows(await s.post("", { urls: ["https://example.com/a"], importMode: "article", linkBack }));
      s.queue.cancel(row.id!);
      await flush();
      const running = s.queue.add("https://example.com/a", "article");
      const retry = await s.post(`/${row.id}/retry`, {});
      expect(retry.status).toBe(409);
      expect(s.queue.get(running.id)?.link_back).toHaveLength(1);
      expect(s.queue.get(row.id!)).not.toHaveProperty("link_back");
    });

    it("doesn't hand them to a running job for a neighbouring page", async () => {
      const s = setup({ index: await loaded({}), workers: 2 });
      const url = "https://example.com/app#/a";
      const [row] = await rows(await s.post("", { urls: [url], importMode: "article", linkBack }));
      s.queue.cancel(row.id!);
      await flush();
      const neighbour = s.queue.add("https://example.com/app#/b", "article");
      const retry = await s.post(`/${row.id}/retry`, {});
      expect(retry.status).toBe(200);
      const { id } = await retry.json();
      expect(s.queue.get(id)?.link_back).toHaveLength(1);
      expect(s.queue.get(neighbour.id)).not.toHaveProperty("link_back");
    });

    it("retries a job without link-backs as before", async () => {
      const s = setup({ index: await loaded({}) });
      const job = s.queue.add("https://example.com/a", "article");
      s.queue.cancel(job.id);
      const { id } = await (await s.post(`/${job.id}/retry`, {})).json();
      expect(s.queue.get(id)).not.toHaveProperty("link_back");
    });
  });
});

describe("POST /api/add-article/cancel with a path", () => {
  const page = "Lens/Notes/a.md";
  const link = (doc_path: string): JobLinkBack => ({
    doc_id: `relay-${doc_path}`,
    doc_path,
    actor: "human:Luc",
    author: "Luc",
    protect_human: false,
    urls: ["https://example.com/a"],
    state: "waiting",
  });
  const running = async () => {
    const s = setup({ index: await loaded({}), workers: 3 });
    return s;
  };
  const cancel = async (s: ReturnType<typeof setup>, ids: string[], path?: string, token?: string) => {
    const resp = await s.post("/cancel", { ids, ...(path === undefined ? {} : { path }) }, token);
    expect(resp.status).toBe(200);
    return (await resp.json()).results;
  };

  const startedHere = (s: ReturnType<typeof setup>, url = "https://example.com/a", others: string[] = []) =>
    s.queue.add(url, "article", undefined, {
      linkBack: [link(page), ...others.map(link)],
      startedBy: `relay-${page}`,
    });

  it("takes the page off a job others are waiting on, and leaves the job running", async () => {
    const s = await running();
    const job = startedHere(s, "https://example.com/a", ["Lens/Notes/b.md"]);
    await flush();
    expect(await cancel(s, [job.id], page)).toEqual([{ id: job.id, cancelled: false, detached: true }]);
    expect(s.queue.get(job.id)?.status).toBe("processing");
    expect(s.queue.get(job.id)?.cancel_requested).toBeUndefined();
    expect(s.queue.get(job.id)?.link_back?.map((l) => l.doc_path)).toEqual(["Lens/Notes/b.md"]);
  });

  it("cancels a job the page started that nobody else joined", async () => {
    const s = await running();
    const job = startedHere(s);
    await flush();
    expect(await cancel(s, [job.id], page)).toEqual([{ id: job.id, cancelled: true, was: "processing" }]);
    await flush();
    expect(s.queue.get(job.id)?.status).toBe("cancelled");
    expect(s.queue.get(job.id)).not.toHaveProperty("link_back");
  });

  it("answers each job by who started it and who else waits", async () => {
    const s = await running();
    const shared = startedHere(s, "https://example.com/a", ["Lens/Notes/b.md"]);
    const own = startedHere(s, "https://example.com/b");
    const theirs = s.queue.add("https://example.com/c", "article", undefined, {
      linkBack: [link("Lens/Notes/b.md"), link(page)],
      startedBy: "relay-Lens/Notes/b.md",
    });
    await flush();
    expect(await cancel(s, [shared.id, own.id, theirs.id, "nope"], page)).toEqual([
      { id: shared.id, cancelled: false, detached: true },
      { id: own.id, cancelled: true, was: "processing" },
      { id: theirs.id, cancelled: false, detached: true },
      { id: "nope", cancelled: false, error: "No such job" },
    ]);
  });

  it("cancels anything without a path, as before, and keeps its link-backs", async () => {
    const s = await running();
    const job = s.queue.add("https://example.com/a", "article", undefined, {
      linkBack: [link(page), link("Lens/Notes/b.md")],
    });
    await flush();
    expect(await cancel(s, [job.id])).toEqual([{ id: job.id, cancelled: true, was: "processing" }]);
    expect(s.queue.get(job.id)?.link_back).toHaveLength(2);
  });

  it("needs a string, and a folder the token can write", async () => {
    const s = await running();
    const job = s.queue.add("https://example.com/a", "article", undefined, {
      linkBack: [link(page), link("Lens/Notes/b.md")],
    });
    expect((await s.post("/cancel", { ids: [job.id], path: 7 })).status).toBe(400);
    expect((await s.post("/cancel", { ids: [job.id], path: page }, makeToken({ folder: EDU_FOLDER }))).status).toBe(403);
    expect(s.queue.get(job.id)?.link_back).toHaveLength(2);
  });
});

describe("Stop and retry, from the review's probes", () => {
  const linkBackFrom = (path: string, actor = "human:Luc") => ({ path, actor, author: actor.slice(6) });
  const submit = async (s: ReturnType<typeof setup>, url: string, linkBack?: object) =>
    (await (await s.post("", { urls: [url], importMode: "article", ...(linkBack ? { linkBack } : {}) })).json()).results[0];

  // probe-stop-plain: Luc imports from the Add Source page, Ana's page joins
  // with "Import and link", then Ana presses Stop.
  it("doesn't let a page that joined cancel someone else's import", async () => {
    const s = setup({ index: await loaded({}) });
    const luc = await submit(s, "https://example.com/a");
    await flush();
    const check = await (await s.post("/links/check", { urls: ["https://example.com/a"], path: "Lens/Ana.md" })).json();
    expect(check.links[0].state).toBe("new");
    const ana = await submit(s, "https://example.com/a", linkBackFrom("Lens/Ana.md", "human:Ana"));
    expect(ana).toMatchObject({ status: "already_queued", id: luc.id });
    const stop = await (await s.post("/cancel", { ids: [luc.id], path: "Lens/Ana.md" })).json();
    expect(stop.results).toEqual([{ id: luc.id, cancelled: false, detached: true }]);
    expect(s.queue.get(luc.id)?.status).toBe("processing");
    expect(s.queue.get(luc.id)).not.toHaveProperty("link_back");
  });

  it("records the page whose request created the job", async () => {
    const s = setup({ index: await loaded({}) });
    const row = await submit(s, "https://example.com/a", linkBackFrom("Lens/Notes/a.md"));
    expect(s.queue.get(row.id)?.started_by).toBe("relay-Lens/Notes/a.md");
    const plain = await submit(s, "https://example.com/b");
    expect(s.queue.get(plain.id)).not.toHaveProperty("started_by");
  });

  // probe-routes part 1: the page presses Stop, then someone retries the
  // cancelled job from the Add Source page.
  it("doesn't swap a stopped page's link through a later retry", async () => {
    const s = setup({
      index: await loaded({}),
      processJob: async (job) => {
        if (job.retry_of) job.relay_path = "Lens Edu/articles/a.md";
        else await new Promise<void>(() => {});
      },
    });
    const row = await submit(s, "https://example.com/a", linkBackFrom("Lens/Notes/a.md"));
    await flush();
    const stop = await (await s.post("/cancel", { ids: [row.id], path: "Lens/Notes/a.md" })).json();
    expect(stop.results).toEqual([{ id: row.id, cancelled: true, was: "processing" }]);
    await flush();
    expect(s.queue.get(row.id)).not.toHaveProperty("link_back");
    const retry = await (await s.post(`/${row.id}/retry`, {})).json();
    await flush();
    expect(s.queue.get(retry.id)).toMatchObject({ status: "done" });
    expect(s.queue.get(retry.id)).not.toHaveProperty("link_back");
    expect(s.linkSource).not.toHaveBeenCalled();
  });

  it("keeps the starter on a retry only while it still waits", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const s = setup({ index: await loaded({}), workers: 2, processJob: async () => { throw new Error("boom"); } });
    const kept = await submit(s, "https://example.com/a", linkBackFrom("Lens/Notes/a.md"));
    await flush();
    const keptRetry = await (await s.post(`/${kept.id}/retry`, {})).json();
    expect(s.queue.get(keptRetry.id)?.started_by).toBe("relay-Lens/Notes/a.md");

    // The starter stopped while another page waited, so the retry has no starter.
    const left = setup({ index: await loaded({}), workers: 2, processJob: () => new Promise<void>(() => {}) });
    const row = await submit(left, "https://example.com/b", linkBackFrom("Lens/Notes/a.md"));
    await submit(left, "https://example.com/b", linkBackFrom("Lens/Notes/b.md"));
    await (await left.post("/cancel", { ids: [row.id], path: "Lens/Notes/a.md" })).json();
    left.queue.cancel(row.id);
    await flush();
    const retry = await (await left.post(`/${row.id}/retry`, {})).json();
    expect(left.queue.get(retry.id)).not.toHaveProperty("started_by");
    expect(left.queue.get(retry.id)?.link_back?.map((l) => l.doc_path)).toEqual(["Lens/Notes/b.md"]);
    vi.restoreAllMocks();
  });
});

describe("a renamed page, from the review's probes", () => {
  const url = "https://example.com/a";
  const start = async (s: ReturnType<typeof setup>) => {
    const r = await (await s.post("", {
      urls: [url],
      importMode: "article",
      linkBack: { path: "Lens/Notes/a.md", actor: "human:Luc", author: "Luc" },
    })).json();
    await flush();
    return r.results[0].id as string;
  };
  const stateFor = async (s: ReturnType<typeof setup>, path: string) =>
    (await (await s.post("/links/check", { urls: [url], path })).json()).links[0].state;

  // probe-rename: both names are the same document.
  it("matches the page's link-backs by doc id under its new name", async () => {
    const s = setup({ index: await loaded({}), resolveDocId: vi.fn(async () => "doc-1") });
    const id = await start(s);
    expect(await stateFor(s, "Lens/Notes/a.md")).toBe("importing");
    expect(await stateFor(s, "Lens/Notes/b.md")).toBe("importing");
    const stop = await (await s.post("/cancel", { ids: [id], path: "Lens/Notes/b.md" })).json();
    expect(stop.results).toEqual([{ id, cancelled: true, was: "processing" }]);
    expect(s.queue.get(id)).not.toHaveProperty("link_back");
    await flush();
    expect(s.linkSource).not.toHaveBeenCalled();
  });

  it("falls back to the path the link-back was made with when the relay can't say", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolveDocId = vi.fn(async (path: string) => {
      if (path === "Lens/Notes/a.md" && resolveDocId.mock.calls.length === 1) return "doc-1";
      throw new Error("relay down");
    });
    const s = setup({ index: await loaded({}), resolveDocId });
    await start(s);
    expect(await stateFor(s, "Lens/Notes/b.md")).toBe("new");
    expect(await stateFor(s, "Lens/Notes/c.md")).toBe("new");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("matches by path when the page isn't known by that name", async () => {
    const resolveDocId = vi.fn(async (path: string) => (path === "Lens/Notes/a.md" && resolveDocId.mock.calls.length === 1 ? "doc-1" : null));
    const s = setup({ index: await loaded({}), resolveDocId });
    await start(s);
    expect(await stateFor(s, "Lens/Notes/a.md")).toBe("importing");
  });

  // The offer polls: a lookup per poll would be a relay call per poll.
  it("caches the lookup for about 30 seconds, failures too", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolveDocId = vi.fn(async (path: string) => {
      if (path === "Lens/Notes/down.md") throw new Error("relay down");
      return `relay-${path}`;
    });
    const s = setup({ index: await loaded({}), resolveDocId });
    const ask = (path: string) => s.post("/links/check", { urls: [url], path });
    await ask("Lens/Notes/b.md");
    await ask("Lens/Notes/b.md");
    await s.post("/cancel", { ids: ["nope"], path: "Lens/Notes/b.md" });
    await ask("Lens/Notes/down.md");
    await ask("Lens/Notes/down.md");
    expect(resolveDocId.mock.calls.map(([path]) => path)).toEqual(["Lens/Notes/b.md", "Lens/Notes/down.md"]);
    now += 30_000;
    await ask("Lens/Notes/b.md");
    expect(resolveDocId).toHaveBeenCalledTimes(3);
    warn.mockRestore();
    vi.restoreAllMocks();
  });

  it("doesn't look anything up without a path", async () => {
    const s = setup({ index: await loaded({}) });
    await s.post("/links/check", { urls: [url] });
    await s.post("/cancel", { ids: ["nope"] });
    expect(s.resolveDocId).not.toHaveBeenCalled();
  });
});

describe("sources that only share a key, from the review's probes", () => {
  const linkBack = { path: "Lens/Notes/a.md", actor: "human:Luc", author: "Luc" };
  const bare = "https://app.example.com/view";
  const first = `${bare}?ref=111`;
  const second = `${bare}?ref=222`;

  // probe-routes part 2: `/view` matches both refs, which don't match each other.
  it("joins a URL to a group only if it matches every member", async () => {
    const s = setup({ index: await loaded({}), workers: 2 });
    const rows = (await (await s.post("", { urls: [bare, first, second], importMode: "article", linkBack })).json()).results;
    expect(rows.map((r: ImportResultRow) => r.status)).toEqual(["queued", "already_queued", "queued"]);
    expect(rows[1].id).toBe(rows[0].id);
    expect(rows[2].id).not.toBe(rows[0].id);
    const [one, two] = rows.filter((r: ImportResultRow) => r.status === "queued").map((r: ImportResultRow) => s.queue.get(r.id!)!.link_back![0].urls);
    expect(one).toEqual(expect.arrayContaining([bare, first]));
    expect(one).not.toContain(second);
    expect(two).toContain(second);
    expect(two).not.toContain(first);
    // Both sources could claim this spelling, so neither swaps it.
    expect(two).not.toContain(bare);
    expect([...one, ...two]).not.toContain("https://www.app.example.com/view");
  });

  it("doesn't join a job that already carries a link this one doesn't match", async () => {
    const s = setup({ index: await loaded({}), workers: 2 });
    const job = s.queue.add(bare, "article", undefined, {
      linkBack: [{
        doc_id: "relay-b", doc_path: "Lens/Notes/b.md", actor: "human:Ana", author: "Ana",
        protect_human: false, urls: [bare, first], state: "waiting",
      }],
    });
    await flush();
    const [row] = (await (await s.post("", { urls: [second], importMode: "article", linkBack })).json()).results;
    expect(row.status).toBe("queued");
    expect(row.id).not.toBe(job.id);
    const check = await (await s.post("/links/check", { urls: [second, first] })).json();
    expect(check.links.map((l: { job_id: string }) => l.job_id)).toEqual([row.id, job.id]);
  });
});

describe("GET /api/add-article/status", () => {
  const jobs = async (s: ReturnType<typeof setup>, token: string) => {
    const resp = await s.app.request("/api/add-article/status", { headers: { Authorization: `Bearer ${token}` } });
    expect(resp.status).toBe(200);
    return (await resp.json()).jobs;
  };

  // Prevents: an Edu-scoped token reading the names of Lens pages, and who
  // asked, through import_status.
  it("shows link-backs to an all-folders token only", async () => {
    const s = setup({ index: await loaded({}) });
    const job = s.queue.add("https://example.com/a", "article", undefined, {
      startedBy: "relay-a",
      linkBack: [{
        doc_id: "relay-a",
        doc_path: "Lens/Private/a.md",
        actor: "human:Luc",
        author: "Luc",
        protect_human: false,
        urls: ["https://example.com/a"],
        state: "waiting",
      }],
    });
    const [all] = await jobs(s, makeToken({ folder: ALL_FOLDERS }));
    expect(all.link_back[0].doc_path).toBe("Lens/Private/a.md");
    expect(all.started_by).toBe("relay-a");

    const [edu] = await jobs(s, makeToken({ folder: EDU_FOLDER }));
    expect(edu).not.toHaveProperty("link_back");
    expect(edu).not.toHaveProperty("started_by");
    expect(edu).toMatchObject({ id: job.id, url: "https://example.com/a" });
    expect(JSON.stringify(edu)).not.toContain("Lens/Private");
  });
});

describe("POST /api/add-article without linkBack", () => {
  // Prevents: the import page and import_source seeing any change from this
  // feature. The strings are what the route answered before it existed.
  it("answers exactly as it did, and touches neither the index nor the relay", async () => {
    let counter = 0;
    const mockQueue = {
      add: vi.fn((url: string) => ({ id: `job${++counter}`, url, status: "queued" })),
      status: vi.fn(() => []),
      findActive: vi.fn((url: string) =>
        url === "https://example.com/active" ? { id: "existing", url, status: "processing" } : undefined,
      ),
      get: vi.fn(() => undefined),
      view: vi.fn((job: object) => job),
      summary: vi.fn(() => ({ workers: 3, processing: 0, queued: 0 })),
    };
    const linkSource = vi.fn();
    const resolveDocId = vi.fn();
    const index = { ensureLoaded: vi.fn(), lookup: vi.fn() };
    const app = new Hono();
    app.route(
      "/api/add-article",
      createAddArticleRoutes(mockQueue as never, { library: index, linkSource, resolveDocId }),
    );
    const resp = await app.request("/api/add-article", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${makeToken({ folder: EDU_FOLDER })}` },
      body: JSON.stringify({
        urls: [
          "HTTPS://Example.com/a",
          "https://example.com/a/",
          "https://example.com/active",
          "not a url",
          "https://www.youtube.com/@channel",
        ],
        importMode: "article",
      }),
    });
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe(
      '{"results":[' +
        '{"url":"https://example.com/a","status":"queued","id":"job1"},' +
        '{"url":"https://example.com/a/","status":"already_queued"},' +
        '{"url":"https://example.com/active","status":"already_queued","id":"existing"},' +
        '{"url":"not a url","status":"invalid","error":"Not a valid http(s) URL"},' +
        '{"url":"https://www.youtube.com/@channel","status":"invalid","error":"This YouTube URL doesn\'t point to a single video. Submit a watch/shorts/youtu.be link"}' +
        '],"queue":{"workers":3,"processing":0,"queued":0}}',
    );
    expect(mockQueue.add.mock.calls).toEqual([
      ["https://example.com/a", "article", undefined, { replaceExisting: false }],
    ]);
    expect(index.ensureLoaded).not.toHaveBeenCalled();
    expect(index.lookup).not.toHaveBeenCalled();
    expect(linkSource).not.toHaveBeenCalled();
    expect(resolveDocId).not.toHaveBeenCalled();
  });
});
