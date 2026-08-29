import { beforeEach, describe, expect, it, vi } from "vitest";
import { DuplicateDocumentError } from "./duplicate";

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

vi.mock("./fetch", () => fetchMocks);
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
  reviewArticle: reviewMocks.reviewArticle,
}));

import { assertRequiredBodyPrefix, processArticle } from "./pipeline";

describe("assertRequiredBodyPrefix", () => {
  const prefix =
    "*Chapter files: [View Markdown](https://ai-safety-atlas.com/chapters/v1/risks.md) · [Download PDF](https://atlas.foreviewusercontent.com/pdf/chapter.pdf)*";

  it("accepts exactly one unchanged prefix at the start of the body", () => {
    expect(() => assertRequiredBodyPrefix(`${prefix}\n\nArticle body`, prefix)).not.toThrow();
  });

  it("rejects removal, mutation, movement, or duplication", () => {
    for (const body of [
      "Article body",
      `${prefix.replace("Markdown", "MD")}\n\nArticle body`,
      `Article body\n\n${prefix}`,
      `${prefix}\n\n${prefix}\n\nArticle body`,
    ]) {
      expect(() => assertRequiredBodyPrefix(body, prefix)).toThrow(/mandatory source download links/i);
    }
  });
});

describe("processArticle duplicate detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMocks.looksLikePdf.mockReturnValue(false);
  });

  it("rejects a fully imported URL before fetching or parsing the article", async () => {
    relayMocks.checkRelayArticleUrls.mockImplementation(
      async (urls: string[]) => ({
        found: Object.fromEntries(
          urls.map((url) => [url, "/articles/existing.md"]),
        ),
        stubs: {},
      }),
    );
    const now = new Date().toISOString();
    const job = {
      id: "duplicate",
      url: "https://example.com/existing",
      status: "processing" as const,
      importMode: "article-and-lens" as const,
      created_at: now,
      updated_at: now,
    };

    await expect(processArticle(job)).rejects.toThrow(
      "This URL was already imported: Lens Edu/articles/existing.md",
    );
    expect(fetchMocks.fetchRawBytes).not.toHaveBeenCalled();
    expect(fetchMocks.fetchFirstHtml).not.toHaveBeenCalled();
    expect(fetchMocks.fetchRenderedHtml).not.toHaveBeenCalled();
  });

  // An already-imported URL is a no-op, not an error: the queue marks it
  // "skipped" and links to the existing document instead of showing FAILED
  // with a Retry button.
  it("reports an existing document as a duplicate carrying its path", async () => {
    relayMocks.checkRelayArticleUrls.mockImplementation(
      async (urls: string[]) => ({
        found: Object.fromEntries(
          urls.map((url) => [url, "/articles/existing.md"]),
        ),
        stubs: {},
      }),
    );
    const now = new Date().toISOString();
    const job = {
      id: "duplicate-typed",
      url: "https://example.com/existing",
      status: "processing" as const,
      importMode: "article-and-lens" as const,
      created_at: now,
      updated_at: now,
    };

    const err = await processArticle(job).catch((e) => e);
    expect(err).toBeInstanceOf(DuplicateDocumentError);
    expect((err as DuplicateDocumentError).docPath).toBe(
      "Lens Edu/articles/existing.md",
    );
  });

  it("promotes an article-stub in place while preserving its discussion", async () => {
    const stub = `---
title: "Old title"
source_url: "https://example.com/proposed"
created: 2026-06-27
tags:
  - "article-stub"
  - "validator-ignore"
---

%%
Luc:
This might be useful.
%%
`;
    relayMocks.checkRelayArticleUrls.mockImplementation(
      async (urls: string[]) => ({
        found: Object.fromEntries(
          urls.map((url) => [url, "/articles/original-stub-name.md"]),
        ),
        stubs: Object.fromEntries(
          urls.map((url) => [
            url,
            {
              path: "/articles/original-stub-name.md",
              content: stub,
            },
          ]),
        ),
      }),
    );
    fetchMocks.fetchRawBytes.mockResolvedValue({
      bytes: new TextEncoder().encode("<article>Full article</article>"),
      contentType: "text/html",
      finalUrl: "https://example.com/proposed",
    });
    const meta = {
      title: "New title",
      author: ["A. Writer"],
      source_url: "https://example.com/proposed",
      published: "2026-01-02",
      description: "Description.",
    };
    extractionMocks.extractArticle.mockResolvedValue({
      meta,
      body: "Full imported article body. ".repeat(20),
      siteName: "Example",
      linkedOut: false,
      assessment: { flags: [] },
      via: "readability",
      images: [],
    });
    reviewMocks.buildSourceEvidence.mockResolvedValue({
      extraction: await extractionMocks.extractArticle(),
      manifest: {
        fetched_at: "2026-08-19T00:00:00.000Z",
        source_kind: "live",
      },
    });
    const valid = { valid: true, issues: [], truncated: false, counts: { errors: 0, warnings: 0 } };
    const invalid = {
      valid: false,
      issues: [{ code: "article.test", severity: "error", path: "articles/test.md", message: "repair me" }],
      truncated: false,
      counts: { errors: 1, warnings: 0 },
    };
    reviewMocks.validateArticleDraft
      .mockResolvedValueOnce(valid)
      .mockResolvedValueOnce(invalid)
      .mockResolvedValueOnce(invalid)
      .mockResolvedValueOnce(valid)
      .mockResolvedValueOnce(valid);
    reviewMocks.reviewArticle.mockImplementation(async (_dir, markdown, reviewMeta) => ({
      review: { decision: "pass", reason: "" },
      markdown,
      meta: reviewMeta,
    }));
    extractionMocks.normalizeMetaWithLlm.mockResolvedValue(meta);

    const now = new Date().toISOString();
    const job = {
      id: "promote",
      url: "https://example.com/proposed",
      status: "processing" as const,
      importMode: "article" as const,
      created_at: now,
      updated_at: now,
    };
    await processArticle(job);

    expect(relayMocks.createRelayDoc).toHaveBeenCalledOnce();
    const [writtenPath, markdown] = relayMocks.createRelayDoc.mock.calls[0];
    expect(writtenPath).toBe(
      "Lens Edu/articles/original-stub-name.md",
    );
    expect(markdown).toContain("created: 2026-06-27");
    expect(markdown).toContain("%%\nLuc:\nThis might be useful.\n%%");
    expect(markdown).toContain("Full imported article body.");
    expect(markdown).toContain('  - "article-importer"');
    expect(markdown).toContain('  version: "article-qc-v1"');
    expect(markdown).not.toContain("content-sha:");
    expect(markdown).not.toContain("article-stub");
    expect(reviewMocks.reviewArticle).toHaveBeenCalledTimes(3);
    expect(reviewMocks.reviewArticle.mock.calls.map((call) => call[4])).toEqual([0, 1, 2]);
    expect(reviewMocks.validateArticleDraft).toHaveBeenCalledTimes(5);
    expect(reviewMocks.validateArticleDraft.mock.invocationCallOrder[0])
      .toBeLessThan(reviewMocks.reviewArticle.mock.invocationCallOrder[0]);
    expect(reviewMocks.reviewArticle.mock.invocationCallOrder[0])
      .toBeLessThan(relayMocks.createRelayDoc.mock.invocationCallOrder[0]);
  });

  it("lets the first review select the unrendered candidate as the written base", async () => {
    relayMocks.checkRelayArticleUrls.mockResolvedValue({ found: {}, stubs: {} });
    relayMocks.checkRelayDocsExist.mockResolvedValue({});
    relayMocks.createRelayDoc.mockResolvedValue(undefined);
    const meta = {
      title: "Dual source article",
      author: ["A. Writer"],
      source_url: "https://example.com/dual",
      published: "2026-01-02",
      description: "Description.",
    };
    const extraction = (body: string) => ({
      meta,
      body,
      siteName: "Example",
      linkedOut: false,
      assessment: { flags: [] },
      via: "readability",
      images: [],
    });
    const rendered = extraction("Rendered candidate body. ".repeat(20));
    const unrendered = extraction("Unrendered candidate body. ".repeat(20));
    reviewMocks.buildSourceEvidence.mockResolvedValue({
      extraction: rendered,
      htmlCandidates: { rendered, unrendered },
      manifest: {
        fetched_at: "2026-08-29T00:00:00.000Z",
        source_kind: "live",
        media_type: "html",
        fetched_url: "https://example.com/dual",
      },
    });
    const valid = { valid: true, issues: [], truncated: false, counts: { errors: 0, warnings: 0 } };
    reviewMocks.validateArticleDraft.mockResolvedValue(valid);
    reviewMocks.reviewArticle.mockImplementation(async (...args) => {
      const candidates = args[7];
      expect(candidates.rendered).toContain("Rendered candidate body.");
      expect(candidates.unrendered).toContain("Unrendered candidate body.");
      return {
        review: { decision: "pass", reason: "" },
        markdown: candidates.unrendered,
        originalMarkdown: candidates.unrendered,
        selectedBase: "unrendered",
        meta,
      };
    });

    const now = new Date().toISOString();
    await processArticle({
      id: "dual-candidate",
      url: "https://example.com/dual",
      status: "processing",
      importMode: "article",
      created_at: now,
      updated_at: now,
    });

    expect(reviewMocks.reviewArticle).toHaveBeenCalledOnce();
    const written = relayMocks.createRelayDoc.mock.calls[0][1];
    expect(written).toContain("Unrendered candidate body.");
    expect(written).not.toContain("Rendered candidate body.");
  });
});
