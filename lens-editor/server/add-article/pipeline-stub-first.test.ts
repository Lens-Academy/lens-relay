import { beforeEach, describe, expect, it, vi } from "vitest";


const fetchMocks = vi.hoisted(() => ({
  fetchFirstHtml: vi.fn(),
  fetchRawHtml: vi.fn(),
  fetchRenderedHtml: vi.fn(),
  fetchRawBytes: vi.fn(),
  looksLikePdf: vi.fn(),
}));
const relayMocks = vi.hoisted(() => ({
  checkRelayArticleUrls: vi.fn(),
  checkRelayDocsExist: vi.fn(),
  createRelayDoc: vi.fn(),
  createRelayAttachment: vi.fn(),
  checkRelayVideoIds: vi.fn(),
  relayTranscriptFolder: () => "Lens Edu/video_transcripts",
  editorOpenUrl: (p: string) =>
    `https://editor.lensacademy.org/open/${encodeURI(p)}`,
}));
const extractionMocks = vi.hoisted(() => ({
  extractArticle: vi.fn(),
  normalizeMetaWithLlm: vi.fn(),
}));
const reviewMocks = vi.hoisted(() => ({
  buildSourceEvidence: vi.fn(),
  writeSourceEvidence: vi.fn(),
  validateArticleDraft: vi.fn(),
  reviewArticle: vi.fn(),
}));

vi.mock("./fetch", () => ({ ...fetchMocks, MIN_ARTICLE_CHARS: 200 }));
vi.mock("../add-video/relay-docs", () => relayMocks);
vi.mock("./extract", () => ({ extractArticle: extractionMocks.extractArticle }));
vi.mock("./meta-normalize", () => ({
  normalizeMetaWithLlm: extractionMocks.normalizeMetaWithLlm,
}));
vi.mock("./source-evidence", () => ({
  buildSourceEvidence: reviewMocks.buildSourceEvidence,
  writeSourceEvidence: reviewMocks.writeSourceEvidence,
}));
vi.mock("./platform-validation", () => ({
  validateArticleDraft: reviewMocks.validateArticleDraft,
  assertArticleValid: (result: { valid: boolean }) => { if (!result.valid) throw new Error("invalid"); },
}));
vi.mock("./claude", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./claude")>()),
  resolveArticleReviewerConfig: () => ({ provider: "claude", model: "sonnet" }),
  reviewArticle: reviewMocks.reviewArticle,
}));
import { processArticle } from "./pipeline";
import { installFakeRelay } from "./fake-relay.test-helper";
import type { ArticleJob } from "./types";

const body = "Intro paragraph. ".repeat(30);
const meta = {
  title: "Self-determination theory",
  author: ["R. Ryan", "E. Deci"],
  source_url: "https://example.com/sdt",
  published: "2000-01-01",
  description: "Description.",
};
const valid = { valid: true, issues: [], truncated: false, counts: { errors: 0, warnings: 0 } };

describe("processArticle writes the stub first", () => {
  let files: Map<string, string>;
  const path = "Lens Edu/articles/ryan-self-determination-theory.md";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    fetchMocks.looksLikePdf.mockReturnValue(false);
    files = installFakeRelay(relayMocks);
    reviewMocks.buildSourceEvidence.mockResolvedValue({
      extraction: {
        meta,
        body,
        siteName: "Example",
        linkedOut: false,
        assessment: { flags: [] },
        via: "readability",
        images: [],
      },
      manifest: { fetched_at: "2026-10-01T00:00:00.000Z", source_kind: "live", media_type: "html" },
    });
    reviewMocks.validateArticleDraft.mockResolvedValue(valid);
  });

  const job = (): ArticleJob => {
    const now = new Date().toISOString();
    return {
      id: "sdt",
      url: "https://example.com/sdt",
      status: "processing",
      importMode: "article",
      created_at: now,
      updated_at: now,
    };
  };

  // A person opens the stub while the (minutes-long) review runs and writes a
  // note; the finished import must keep it.
  const reviewWhile = (edit: (stub: string) => string) =>
    reviewMocks.reviewArticle.mockImplementation(async (_dir, markdown, reviewMeta) => {
      files.set(path, edit(files.get(path)!));
      return {
        review: { decision: "pass", reason: "" },
        markdown,
        meta: reviewMeta,
        reverted: [],
        model: "sonnet",
      };
    });

  it("links the stub while the import runs and fills the article in under notes added meanwhile", async () => {
    const j = job();
    let linkDuringReview: string | undefined;
    reviewWhile((stub) => {
      linkDuringReview = j.relay_url;
      expect(stub).toContain('"article-stub"');
      expect(stub).not.toContain("Intro paragraph.");
      return stub.replace("Add discussion note here:\n\n...", "Luc: good for week 3");
    });

    await processArticle(j);

    expect(linkDuringReview).toBe(`https://editor.lensacademy.org/open/${encodeURI(path)}`);
    expect(relayMocks.createRelayDoc).toHaveBeenCalledTimes(2);
    const final = files.get(path)!;
    expect(final).toContain("%%\nLuc: good for week 3\n\n%%\n\nIntro paragraph.");
    expect(final).toContain('  - "article-importer"');
    expect(final).not.toContain("article-stub");
    expect(j.relay_path).toBe(path);
  });

  it("stops rather than overwrite text written outside the notes, leaving the stub as it is", async () => {
    reviewWhile((stub) => `${stub}\nMy own summary of it.\n`);

    await expect(processArticle(job())).rejects.toThrow(/non-comment content.*My own summary/);
    expect(relayMocks.createRelayDoc).toHaveBeenCalledOnce();
    expect(files.get(path)).toContain("My own summary of it.");
  });

  it("writes no separate stub in stub-only mode", async () => {
    await processArticle({ ...job(), importMode: "stub" });

    expect(relayMocks.createRelayDoc).toHaveBeenCalledOnce();
    expect(files.get(path)).toContain('"article-stub"');
    expect(reviewMocks.reviewArticle).not.toHaveBeenCalled();
  });
});
