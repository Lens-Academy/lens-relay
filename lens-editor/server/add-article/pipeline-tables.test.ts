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
vi.mock("./claude", () => ({
  MAX_REVIEW_ROUNDS: 3,
  REVIEW_MODEL: "sonnet",
  REVIEW_VERSION: "article-qc-v1",
  resolveArticleReviewerConfig: () => ({ provider: "claude", model: "sonnet" }),
  reviewArticle: reviewMocks.reviewArticle,
  buildRevertNotice: (reverts: { detail: string }[]) => reverts.map((r) => r.detail).join("; "),
  ArticleReviewRejectedError: class ArticleReviewRejectedError extends Error {
    constructor(public readonly reason: string) { super(reason); }
  },
}));
import { processArticle } from "./pipeline";

// A table whose third row has one cell too many: the reviewer never repairs
// it (as on arXiv 2512.22154 / 2607.18966), so only the last-resort pass can.
const body = [
  "Intro paragraph. ".repeat(20),
  "",
  "| Setting | Value |",
  "| --- | --- |",
  "| Rank | 32 |",
  "| Alpha | 32 | Tinker default |",
].join("\n");
const meta = {
  title: "Table paper",
  author: ["A. Writer"],
  source_url: "https://example.com/tables",
  published: "2026-01-02",
  description: "Description.",
};
const tableError = {
  code: "article.table-malformed",
  severity: "error",
  path: "articles/test.md",
  line: 30,
  message: "Table row has 3 cells; expected 2",
};
const otherError = { code: "article.math-empty", severity: "error", path: "articles/test.md", message: "Empty maths" };

function result(issues: object[]) {
  return { valid: issues.length === 0, issues, truncated: false, counts: { errors: issues.length, warnings: 0 } };
}

describe("processArticle table errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMocks.looksLikePdf.mockReturnValue(false);
    relayMocks.checkRelayArticleUrls.mockResolvedValue({ found: {}, stubs: {} });
    relayMocks.checkRelayDocsExist.mockResolvedValue({});
    relayMocks.createRelayDoc.mockResolvedValue(undefined);
    const extraction = {
      meta,
      body,
      siteName: "Example",
      linkedOut: false,
      assessment: { flags: [] },
      via: "readability",
      images: [],
    };
    reviewMocks.buildSourceEvidence.mockResolvedValue({
      extraction,
      manifest: { fetched_at: "2026-10-01T00:00:00.000Z", source_kind: "live", media_type: "html" },
    });
    reviewMocks.reviewArticle.mockImplementation(async (_dir, markdown, reviewMeta) => ({
      review: { decision: "pass", reason: "" },
      markdown,
      meta: reviewMeta,
      reverted: [],
      model: "sonnet",
    }));
  });

  const job = () => {
    const now = new Date().toISOString();
    return {
      id: "tables",
      url: "https://example.com/tables",
      status: "processing" as const,
      importMode: "article" as const,
      created_at: now,
      updated_at: now,
    };
  };

  it("writes the article with the row fixed and flagged when only table errors survive every round", async () => {
    reviewMocks.validateArticleDraft.mockImplementation(async (_path: string, draft: string) =>
      result(draft.includes("| Alpha | 32 | Tinker default |") ? [tableError] : []),
    );

    await processArticle(job());

    expect(reviewMocks.reviewArticle).toHaveBeenCalledTimes(3);
    expect(relayMocks.createRelayDoc).toHaveBeenCalledOnce();
    const written: string = relayMocks.createRelayDoc.mock.calls[0][1];
    expect(written).toContain(
      "| Alpha | 32 \\| Tinker default {>>Importer: this row had 3 cells but the table has 2, so the last 2 were joined into this cell. Check it against the source.<<} |",
    );
    expect(written).toContain("| Rank | 32 |");
  });

  it("still discards the import when other errors remain beside the table", async () => {
    reviewMocks.validateArticleDraft.mockImplementation(async (_path: string, draft: string) =>
      result(draft.includes("| Alpha | 32 | Tinker default |") ? [tableError, otherError] : [otherError]),
    );

    await expect(processArticle(job())).rejects.toThrow("invalid");
    expect(relayMocks.createRelayDoc).not.toHaveBeenCalled();
  });
});
