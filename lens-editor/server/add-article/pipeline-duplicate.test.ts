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

vi.mock("./fetch", () => fetchMocks);
vi.mock("../add-video/relay-docs", () => relayMocks);
vi.mock("./extract", () => ({ extractArticle: extractionMocks.extractArticle }));
vi.mock("./meta-normalize", () => ({
  normalizeMetaWithLlm: extractionMocks.normalizeMetaWithLlm,
}));

import { processArticle } from "./pipeline";

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
    expect(markdown).not.toContain("article-stub");
  });
});
