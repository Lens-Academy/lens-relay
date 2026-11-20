import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLibraryEntries, LibraryIndex, type LibraryDocs } from "./library-index";

const article = (path: string, frontmatter: string) => ({ path: `Lens Edu/articles/${path}`, frontmatter });
const transcript = (path: string, frontmatter: string) => ({ path: `Lens Edu/video_transcripts/${path}`, frontmatter });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function indexOf(docs: Partial<LibraryDocs>): LibraryIndex["lookup"] {
  const { entries } = buildLibraryEntries({ articles: [], transcripts: [], ...docs });
  const index = new LibraryIndex();
  (index as unknown as { entries: typeof entries }).entries = entries;
  return (url) => index.lookup(url);
}

describe("buildLibraryEntries", () => {
  it("reads a stored source_url quoted, unquoted or single-quoted", () => {
    const lookup = indexOf({
      articles: [
        article("a.md", '---\ntitle: "A"\nsource_url: "https://example.com/a"\n---'),
        article("b.md", "---\ntitle: B\nsource_url: https://example.com/b\n---\n"),
        article("c.md", "---\ntitle: 'C'\nsource_url: 'https://example.com/c'\n---"),
      ],
    });
    expect(lookup("https://example.com/a")).toEqual({
      path: "Lens Edu/articles/a.md",
      title: "A",
      stub: false,
      sourceUrl: "https://example.com/a",
    });
    expect(lookup("https://example.com/b")?.title).toBe("B");
    expect(lookup("https://example.com/c")?.title).toBe("C");
  });

  it("takes a block with or without its closing fence", () => {
    const lookup = indexOf({
      articles: [article("a.md", '---\nsource_url: "https://example.com/a"'), article("b.md", '---\r\nsource_url: "https://example.com/b"\r\n---\r\n')],
    });
    expect(lookup("https://example.com/a")).toBeDefined();
    expect(lookup("https://example.com/b")).toBeDefined();
  });

  // Prevents: a link offered as new when the page spells the URL differently
  // from what the importer stored.
  it.each([
    ["utm tags", "https://www.lesswrong.com/posts/abc/title?utm_source=x&utm_medium=y"],
    ["www", "https://lesswrong.com/posts/abc/title"],
    ["a trailing slash", "https://www.lesswrong.com/posts/abc/title/"],
    ["http", "http://www.lesswrong.com/posts/abc/title"],
    ["a fragment", "https://www.lesswrong.com/posts/abc/title#section"],
    ["the GreaterWrong mirror", "https://www.greaterwrong.com/posts/abc/title"],
  ])("finds an article spelled with %s", (_name, url) => {
    const lookup = indexOf({
      articles: [article("a.md", '---\ntitle: "A"\nsource_url: "https://www.lesswrong.com/posts/abc/title"\n---')],
    });
    expect(lookup(url)?.path).toBe("Lens Edu/articles/a.md");
  });

  // Prevents: a link being rewritten to a different article because the dedup
  // key folds what tells the two apart.
  it.each([
    ["a different ref", "https://example.com/view?ref=111", "https://example.com/view?ref=222", false],
    ["a ref on the link only", "https://example.com/view?ref=hn", "https://example.com/view", true],
    ["a different port", "https://example.com:8443/view", "https://example.com/view", false],
    ["a different app route", "https://example.com/app#/b", "https://example.com/app#/a", false],
    ["an app route on the link only", "https://example.com/app#/b", "https://example.com/app", false],
    ["an ordinary fragment", "https://example.com/view#notes", "https://example.com/view", true],
  ])("is strict about %s", (_name, url, stored, hit) => {
    const lookup = indexOf({ articles: [article("a.md", `---\nsource_url: "${stored}"\n---`)] });
    expect(lookup(url) !== undefined).toBe(hit);
  });

  it("keeps a forum comment apart from its post", () => {
    const lookup = indexOf({
      articles: [article("a.md", '---\nsource_url: "https://www.lesswrong.com/posts/abc/title"\n---')],
    });
    expect(lookup("https://www.lesswrong.com/posts/abc/title?commentId=c1")).toBeUndefined();
  });

  it.each([
    ["watch", "https://www.youtube.com/watch?v=abcdefghijk"],
    ["watch with other params", "https://www.youtube.com/watch?t=30&v=abcdefghijk"],
    ["youtu.be", "https://youtu.be/abcdefghijk?si=x"],
    ["embed", "https://www.youtube.com/embed/abcdefghijk"],
  ])("finds a transcript by its `url`, spelled as %s", (_name, url) => {
    const lookup = indexOf({
      transcripts: [transcript("v.md", '---\ntitle: "V"\nchannel: "C"\nurl: "https://www.youtube.com/watch?v=abcdefghijk"\n---')],
    });
    expect(lookup(url)).toEqual({
      path: "Lens Edu/video_transcripts/v.md",
      title: "V",
      stub: false,
      sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
    });
  });

  it("flags a stub by its tag, in any list form", () => {
    const lookup = indexOf({
      articles: [
        article("a.md", '---\nsource_url: "https://example.com/a"\ntags:\n  - "article-stub"\n  - "validator-ignore"\n---'),
        article("b.md", "---\nsource_url: https://example.com/b\ntags: [article-stub]\n---"),
        article("c.md", "---\nsource_url: https://example.com/c\ntags: article-stub, other\n---"),
        article("d.md", '---\nsource_url: "https://example.com/d"\ntags:\n  - "article-importer"\n---'),
      ],
      transcripts: [transcript("v.md", '---\nurl: "https://www.youtube.com/shorts/abcdefghijk"\ntags:\n  - "video-stub"\n---')],
    });
    expect(lookup("https://example.com/a")?.stub).toBe(true);
    expect(lookup("https://example.com/b")?.stub).toBe(true);
    expect(lookup("https://example.com/c")?.stub).toBe(true);
    expect(lookup("https://example.com/d")?.stub).toBe(false);
    expect(lookup("https://youtu.be/abcdefghijk")?.stub).toBe(true);
  });

  it("prefers a full copy over a stub of the same source", () => {
    const lookup = indexOf({
      articles: [
        article("stub.md", '---\nsource_url: "https://example.com/a"\ntags: [article-stub]\n---'),
        article("full.md", '---\nsource_url: "https://example.com/a"\n---'),
      ],
    });
    expect(lookup("https://example.com/a")).toMatchObject({ path: "Lens Edu/articles/full.md", stub: false });
  });

  // Prevents: one hand-edited file taking the whole library down with it.
  it("costs only the document when its YAML is bad", () => {
    const { entries, unreadable } = buildLibraryEntries({
      articles: [
        article("bad.md", "---\ntitle: Foo: bar: baz\nsource_url: https://example.com/bad\n---"),
        article("list.md", "---\n- not\n- a mapping\n---"),
        article("good.md", '---\nsource_url: "https://example.com/good"\n---'),
        article("none.md", ""),
      ],
      transcripts: [],
    });
    expect([...entries.keys()]).toEqual(["https://example.com/good"]);
    expect(unreadable).toBe(2);
  });

  // Prevents: an article vanishing from the library while someone's comment
  // sits on its frontmatter. The first two are real library files.
  it("reads past pending comments and suggestions in frontmatter", () => {
    const meta = '{"author":"Elias\'s AI","timestamp":1783847958515}';
    const { entries, unreadable } = buildLibraryEntries({
      articles: [
        article("comment.md", `---\ntitle: "C"\nsource_url: "https://example.com/c"\npublished: 2025-12-01 {>>${meta}@@required: the page shows no date<<}\n---`),
        article("edit.md", `---\ntitle: "E"\nauthor:\n  - {--${meta}@@"aaguirre"--}{++${meta}@@"Anthony Aguirre"\nauthor_url:\n  - "https://example.org/"++}\nsource_url: "https://example.com/e"\n---`),
        article("title.md", `---\ntitle: "Before" {>>${meta}@@retitle this<<}\nsource_url: "https://example.com/t" {>>${meta}@@check: this link<<}\n---`),
        article("swap.md", `---\ntitle: {~~${meta}@@"Old"~>"New"~~}\nsource_url: "https://example.com/s"\ntags:\n  - {--${meta}@@"article-stub"--}\n---`),
      ],
      transcripts: [],
    });
    expect(unreadable).toBe(0);
    expect([...entries.keys()].sort()).toEqual([
      "https://example.com/c",
      "https://example.com/e",
      "https://example.com/s",
      "https://example.com/t",
    ]);
    expect(entries.get("https://example.com/t")?.title).toBe("Before");
    // Not accepted yet: the file still is what it was.
    expect(entries.get("https://example.com/s")).toMatchObject({ title: "Old", stub: true });
  });

  it("leaves out what can't be keyed, and anything in the trash", () => {
    const { entries } = buildLibraryEntries({
      articles: [
        article("no-url.md", '---\ntitle: "A note"\n---'),
        { path: "Lens Edu/_trash/articles/x.md", frontmatter: '---\nsource_url: "https://example.com/x"\n---' },
      ],
      transcripts: [transcript("playlist.md", '---\nurl: "https://www.youtube.com/playlist?list=PL1"\n---')],
    });
    expect(entries.size).toBe(0);
  });

  it("tolerates a number for a title, and repeated keys", () => {
    const lookup = indexOf({
      articles: [article("a.md", "---\ntitle: 1984\ntitle: 1985\nsource_url: https://example.com/a\n---")],
    });
    expect(lookup("https://example.com/a")?.title).toBe("1985");
  });
});

describe("LibraryIndex", () => {
  const url = "https://example.com/a";
  const docs = (title: string): LibraryDocs => ({
    articles: [article("a.md", `---\ntitle: "${title}"\nsource_url: "${url}"\n---`)],
    transcripts: [],
  });
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers the first call at once, not ready, and is ready when the scan lands", async () => {
    const scan = deferred<LibraryDocs>();
    const load = vi.fn(() => scan.promise);
    const index = new LibraryIndex({ load });

    expect(index.ensureLoaded()).toBe(false);
    expect(index.lookup(url)).toBeUndefined();
    await flush();
    expect(load).toHaveBeenCalledOnce();

    scan.resolve(docs("A"));
    await flush();
    expect(index.ensureLoaded()).toBe(true);
    expect(index.lookup(url)?.title).toBe("A");
  });

  it("does nothing until it is asked", async () => {
    const load = vi.fn(async () => docs("A"));
    const index = new LibraryIndex({ load });
    index.add({ url, path: "Lens Edu/articles/a.md", stub: false });
    index.lookup(url);
    await flush();
    expect(load).not.toHaveBeenCalled();
  });

  it("runs one scan at a time", async () => {
    const scan = deferred<LibraryDocs>();
    const load = vi.fn(() => scan.promise);
    const index = new LibraryIndex({ load });
    index.ensureLoaded();
    index.ensureLoaded();
    await flush();
    index.ensureLoaded();
    await flush();
    expect(load).toHaveBeenCalledOnce();
  });

  it("serves the old data while a stale index rescans, then the new data", async () => {
    const second = deferred<LibraryDocs>();
    const load = vi.fn<() => Promise<LibraryDocs>>().mockResolvedValueOnce(docs("Old")).mockReturnValueOnce(second.promise);
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const index = new LibraryIndex({ load, staleMs: 1_000 });
    index.ensureLoaded();
    await flush();

    now += 999;
    index.ensureLoaded();
    await flush();
    expect(load).toHaveBeenCalledOnce();

    now += 1;
    expect(index.ensureLoaded()).toBe(true);
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(index.lookup(url)?.title).toBe("Old");

    second.resolve(docs("New"));
    await flush();
    expect(index.lookup(url)?.title).toBe("New");
  });

  it("keeps the old data and logs when a rescan fails, and waits before trying again", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const load = vi.fn<() => Promise<LibraryDocs>>()
      .mockResolvedValueOnce(docs("Old"))
      .mockRejectedValueOnce(new Error("relay down"))
      .mockResolvedValueOnce(docs("New"));
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const index = new LibraryIndex({ load, staleMs: 1_000, failedScanRetryMs: 500 });
    index.ensureLoaded();
    await flush();

    now += 1_000;
    index.ensureLoaded();
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(error.mock.calls[0][0]).toMatch(/relay down/);
    expect(index.ensureLoaded()).toBe(true);
    expect(index.lookup(url)?.title).toBe("Old");

    // Prevents: every status poll rescanning 1,280 documents on a failing relay.
    now += 499;
    index.ensureLoaded();
    await flush();
    expect(load).toHaveBeenCalledTimes(2);

    now += 1;
    index.ensureLoaded();
    await flush();
    expect(load).toHaveBeenCalledTimes(3);
    expect(index.lookup(url)?.title).toBe("New");
  });

  it("stays not ready when the first scan fails, and tries again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const load = vi.fn<() => Promise<LibraryDocs>>().mockRejectedValueOnce(new Error("relay down")).mockResolvedValueOnce(docs("A"));
    const index = new LibraryIndex({ load, failedScanRetryMs: 500 });
    index.ensureLoaded();
    await flush();
    expect(index.ensureLoaded()).toBe(false);
    now += 500;
    index.ensureLoaded();
    await flush();
    expect(index.ensureLoaded()).toBe(true);
  });

  it("shows an added import at once, and keeps a title it already had", () => {
    const index = new LibraryIndex({ load: async () => docs("A") });
    index.add({ url, path: "Lens Edu/articles/a.md", title: "A", stub: true });
    expect(index.lookup("https://www.example.com/a/?utm_source=x")).toEqual({
      path: "Lens Edu/articles/a.md",
      title: "A",
      stub: true,
      sourceUrl: url,
    });
    index.add({ url, path: "Lens Edu/articles/a.md", stub: false });
    expect(index.lookup(url)).toMatchObject({ title: "A", stub: false });
  });

  it("holds an added import to the URL it came from", () => {
    const index = new LibraryIndex({ load: async () => docs("A") });
    index.add({ url: "https://example.com/app#/a", path: "Lens Edu/articles/a.md", stub: false });
    expect(index.lookup("https://example.com/app#/a")).toBeDefined();
    expect(index.lookup("https://example.com/app#/b")).toBeUndefined();
  });

  // Prevents: an import finishing during a minutes-long scan vanishing when the
  // scan's older snapshot lands.
  it("keeps an import added while a scan runs", async () => {
    const scan = deferred<LibraryDocs>();
    const index = new LibraryIndex({ load: () => scan.promise });
    index.ensureLoaded();
    await flush();
    index.add({ url: "https://example.com/new", path: "Lens Edu/articles/new.md", stub: false });
    scan.resolve(docs("A"));
    await flush();
    expect(index.lookup("https://example.com/new")?.path).toBe("Lens Edu/articles/new.md");
    expect(index.lookup(url)?.title).toBe("A");
  });

  it("never reaches for a relay in tests unless given a loader", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const index = new LibraryIndex();
    expect(index.ensureLoaded()).toBe(false);
    await flush();
    expect(index.ensureLoaded()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
