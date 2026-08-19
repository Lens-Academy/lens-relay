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
        source_digest: "sha256:source",
        fetched_at: "2026-08-19T00:00:00.000Z",
        source_kind: "live",
      },
    });
    reviewMocks.validateArticleDraft.mockResolvedValue({
      valid: true, issues: [], truncated: false, counts: { errors: 0, warnings: 0 },
    });
    reviewMocks.reviewArticle.mockImplementation(async (_dir, markdown, reviewMeta) => ({
      review: { decision: "pass", source_status: "complete", findings: [], patches: [], note: "ok" },
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
    expect(markdown).toContain('  content-sha: "sha256:');
    expect(markdown).not.toContain("article-stub");
    expect(reviewMocks.reviewArticle).toHaveBeenCalledOnce();
    expect(reviewMocks.validateArticleDraft).toHaveBeenCalledTimes(3);
    expect(reviewMocks.validateArticleDraft.mock.invocationCallOrder[0])
      .toBeLessThan(reviewMocks.reviewArticle.mock.invocationCallOrder[0]);
    expect(reviewMocks.reviewArticle.mock.invocationCallOrder[0])
      .toBeLessThan(relayMocks.createRelayDoc.mock.invocationCallOrder[0]);
  });
});
