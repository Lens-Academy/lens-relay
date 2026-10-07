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
import { ArticleReviewRejectedError, ArticleReviewUnavailableError } from "./claude";
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

describe("processArticle when the review cannot give a verdict", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMocks.looksLikePdf.mockReturnValue(false);
    relayMocks.checkRelayArticleUrls.mockResolvedValue({ found: {}, stubs: {} });
    relayMocks.checkRelayDocsExist.mockResolvedValue({});
    relayMocks.createRelayDoc.mockResolvedValue(undefined);
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
  const written = (): string => relayMocks.createRelayDoc.mock.calls[0][1];

  // Prevents: Ryan & Deci 2000, Kasser 2016 & co. never importing because
  // the content filter blocks the review.
  it("imports the article flagged when the content filter blocks the review", async () => {
    reviewMocks.reviewArticle.mockRejectedValue(
      new ArticleReviewUnavailableError("refused", "opus; API Error: Output blocked by content filtering policy"),
    );
    const j = job();
    await processArticle(j);

    expect(relayMocks.createRelayDoc).toHaveBeenCalledOnce();
    expect(written()).toContain(
      'review-status: "unreviewed: needs a Claude check (Claude\'s content filter blocked the review)"',
    );
    expect(written()).not.toContain("llm-review:");
    expect(written()).toContain("Intro paragraph.");
    expect(j.review_status).toBe("unreviewed");
    expect(j.review_note).toBe("Claude's content filter blocked the review");
    // The deterministic draft still passes the validator before it is written.
    expect(reviewMocks.validateArticleDraft).toHaveBeenCalledTimes(2);
  });

  it("keeps the reviewer's edits but flags the article when no PASS/REJECT came", async () => {
    reviewMocks.reviewArticle.mockImplementation(async (_dir, markdown, reviewMeta) => ({
      review: { decision: "pass", reason: "", unconfirmed: true },
      markdown: markdown.replace("Intro paragraph.", "Repaired paragraph."),
      meta: reviewMeta,
      reverted: [],
      model: "opus",
    }));
    const j = job();
    await processArticle(j);

    expect(written()).toContain("Repaired paragraph.");
    expect(written()).toContain(
      'review-status: "unreviewed: needs a Claude check (the review gave no PASS/REJECT)"',
    );
    expect(written()).not.toContain("llm-review:");
    expect(j.review_status).toBe("unreviewed");
  });

  it("flags the article when a later confirmation pass is refused", async () => {
    reviewMocks.reviewArticle
      .mockImplementationOnce(async (_dir, markdown, reviewMeta) => ({
        review: { decision: "pass", reason: "" },
        markdown,
        meta: reviewMeta,
        // A reverted protected edit forces a confirmation pass.
        reverted: [{ kind: "heading", detail: "restored a heading" }],
        model: "sonnet",
      }))
      .mockRejectedValueOnce(new ArticleReviewUnavailableError("refused", "opus; blocked"));
    await processArticle(job());

    expect(reviewMocks.reviewArticle).toHaveBeenCalledTimes(2);
    expect(written()).toContain("review-status:");
  });

  it("writes no flag for a normal reviewed import", async () => {
    reviewMocks.reviewArticle.mockImplementation(async (_dir, markdown, reviewMeta) => ({
      review: { decision: "pass", reason: "" },
      markdown,
      meta: reviewMeta,
      reverted: [],
      model: "sonnet",
    }));
    const j = job();
    await processArticle(j);
    expect(written()).toContain("llm-review:");
    expect(written()).not.toContain("review-status:");
    expect(j.review_status).toBeUndefined();
  });

  it("still fails on a REJECT", async () => {
    reviewMocks.reviewArticle.mockRejectedValue(new ArticleReviewRejectedError("only an abstract"));
    await expect(processArticle(job())).rejects.toThrow(/only an abstract/);
    expect(relayMocks.createRelayDoc).not.toHaveBeenCalled();
  });

  it("still fails when the unreviewed draft does not validate", async () => {
    reviewMocks.reviewArticle.mockRejectedValue(new ArticleReviewUnavailableError("refused", "blocked"));
    reviewMocks.validateArticleDraft.mockResolvedValue({
      valid: false,
      issues: [{ severity: "error", path: "articles/x.md", message: "broken" }],
      truncated: false,
      counts: { errors: 1, warnings: 0 },
    });
    await expect(processArticle(job())).rejects.toThrow();
    expect(relayMocks.createRelayDoc).not.toHaveBeenCalled();
  });
});
