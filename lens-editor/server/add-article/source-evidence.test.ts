import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bytes: new Uint8Array(),
  via: "pdf" as string,
  fetchRawBytes: vi.fn(),
  fetchRawHtml: vi.fn(),
  fetchRenderedHtml: vi.fn(),
  extractPdfSmart: vi.fn(),
}));

vi.mock("./fetch", async () => {
  const actual = await vi.importActual<typeof import("./fetch")>("./fetch");
  return {
    ...actual,
    fetchRawBytes: mocks.fetchRawBytes,
    fetchRawHtml: mocks.fetchRawHtml,
    fetchRenderedHtml: mocks.fetchRenderedHtml,
  };
});

vi.mock("./pdf", () => ({
  extractPdfSmart: mocks.extractPdfSmart,
}));

import { buildSourceEvidence, formatHtmlForReview, writeSourceEvidence } from "./source-evidence";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  vi.clearAllMocks();
});

describe("PDF source evidence retention", () => {
  it.each(["pdf-datalab", "pdf"])("preserves byte-identical evidence through %s extraction", async (via) => {
    const fixturePath = path.join(
      process.cwd(),
      "server/add-article/eval/fixtures-pdf/needforbias-1980/article.pdf",
    );
    mocks.bytes = new Uint8Array(await fs.readFile(fixturePath));
    mocks.via = via;
    mocks.fetchRawBytes.mockImplementation(async () => ({
      bytes: mocks.bytes.buffer.slice(mocks.bytes.byteOffset, mocks.bytes.byteOffset + mocks.bytes.byteLength),
      contentType: "application/pdf",
      finalUrl: "https://example.org/article.pdf",
    }));
    mocks.extractPdfSmart.mockImplementation(async (bytes: ArrayBuffer) => {
      expect(bytes.byteLength).toBeGreaterThan(0);
      // Reproduce pdf.js ownership semantics: the extraction copy is detached.
      structuredClone(bytes, { transfer: [bytes] });
      return {
        body: "A retained PDF article body with enough source text for review.",
        meta: { title: "PDF", author: ["Author"], source_url: "https://example.org/article.pdf", published: "2020-01-01", description: "" },
        siteName: "",
        via: mocks.via,
        linkedOut: false,
        assessment: { score: 1, flags: [] },
        images: [],
      };
    });

    const evidence = await buildSourceEvidence("https://example.org/article.pdf");
    expect(evidence.pdf?.byteLength).toBe(mocks.bytes.byteLength);
    expect(evidence.pdf?.equals(Buffer.from(mocks.bytes))).toBe(true);
    expect(mocks.fetchRenderedHtml).not.toHaveBeenCalled();

    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-evidence-"));
    tempDirs.push(workDir);
    await writeSourceEvidence(workDir, evidence);
    const retained = await fs.readFile(path.join(workDir, "evidence/source.pdf"));
    expect(retained.byteLength).toBeGreaterThan(0);
    expect(retained.equals(Buffer.from(mocks.bytes))).toBe(true);
    await expect(fs.stat(path.join(workDir, "evidence/source.txt"))).rejects.toThrow();
  });
});

describe("HTML source evidence retention", () => {
  it("always extracts rendered HTML and records fetch metadata", async () => {
    const rawHtml = `<html><head><title>Unrendered shell</title></head><body><article>${"unrendered shell ".repeat(2_000)}</article></body></html>`;
    const renderedHtml = `<html><head><title>Rendered Article</title><meta name="author" content="Real Author"><meta property="article:published_time" content="2024-01-02"></head><body><article><h1>Rendered Article</h1><p>${"rendered source evidence ".repeat(200)}</p></article></body></html>`;
    mocks.fetchRawBytes.mockResolvedValue({
      bytes: new TextEncoder().encode(rawHtml).buffer,
      contentType: "text/html",
      finalUrl: "https://example.org/final-article",
    });
    mocks.fetchRenderedHtml.mockResolvedValue(renderedHtml);

    const evidence = await buildSourceEvidence("https://example.org/article");

    expect(mocks.fetchRenderedHtml).toHaveBeenCalledWith("https://example.org/final-article", undefined);
    expect(evidence.extraction.body).toContain("rendered source evidence");
    expect(evidence.extraction.body).not.toContain("unrendered shell");
    expect(evidence.htmlCandidates?.rendered?.body).toContain("rendered source evidence");
    expect(evidence.htmlCandidates?.unrendered?.body).toContain("unrendered shell");
    expect(evidence.manifest.fetched_url).toBe("https://example.org/final-article");
  });

  it("falls back to the direct candidate when Jina cannot render", async () => {
    const rawHtml = `<html><head><title>Static Article</title></head><body><article>${"complete static article ".repeat(200)}</article></body></html>`;
    mocks.fetchRawBytes.mockResolvedValue({
      bytes: new TextEncoder().encode(rawHtml).buffer,
      contentType: "text/html",
      finalUrl: "https://example.org/article",
    });
    mocks.fetchRenderedHtml.mockRejectedValue(new Error("render unavailable"));

    const evidence = await buildSourceEvidence("https://example.org/article");
    expect(evidence.extraction.body).toContain("complete static article");
    expect(evidence.htmlCandidates?.rendered).toBeUndefined();
    expect(evidence.htmlCandidates?.unrendered?.body).toContain("complete static article");
  });

  it("preserves cancellation while waiting for Jina", async () => {
    mocks.fetchRawBytes.mockResolvedValue({
      bytes: new TextEncoder().encode("<html><body>source</body></html>").buffer,
      contentType: "text/html",
      finalUrl: "https://example.org/article",
    });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    mocks.fetchRenderedHtml.mockRejectedValue(controller.signal.reason);

    await expect(buildSourceEvidence("https://example.org/article", controller.signal)).rejects.toThrow(
      "cancelled",
    );
  });

  it("renders the adapter-selected HTML URL", async () => {
    const selectedUrl = "https://arxiv.org/html/2401.00001";
    const renderedHtml = `<html><body><article><h1 class="ltx_title_document">Rendered Paper</h1><div class="ltx_authors">Ada Author</div><div class="ltx_abstract">${"rendered paper body ".repeat(200)}</div></article></body></html>`;
    mocks.fetchRawBytes.mockResolvedValue({
      bytes: new TextEncoder().encode("<html><body>unrendered arXiv response</body></html>").buffer,
      contentType: "text/html",
      finalUrl: selectedUrl,
    });
    mocks.fetchRenderedHtml.mockResolvedValue(renderedHtml);
    mocks.fetchRawHtml.mockResolvedValue(`<html><head><meta property="og:title" content="Rendered Paper"><meta name="citation_author" content="Ada Author"><meta name="citation_date" content="2024-01-02"></head></html>`);

    const evidence = await buildSourceEvidence("https://arxiv.org/abs/2401.00001");

    expect(mocks.fetchRawBytes).toHaveBeenCalledTimes(1);
    expect(mocks.fetchRawBytes).toHaveBeenCalledWith(selectedUrl, undefined);
    expect(mocks.fetchRenderedHtml).toHaveBeenCalledWith(selectedUrl, undefined);
    expect(evidence.manifest.fetched_url).toBe(selectedUrl);
    expect(evidence.extraction.body).toContain("rendered paper body");
  });

  it("falls through to the arXiv PDF when every HTML mirror lands on the abstract page", async () => {
    const abstractPage = "https://arxiv.org/abs/2401.00002";
    mocks.fetchRawBytes.mockImplementation(async (url: string) => {
      if (url.endsWith("/pdf/2401.00002")) {
        return {
          bytes: new TextEncoder().encode("%PDF-1.4 paper bytes").buffer,
          contentType: "application/pdf",
          finalUrl: "https://arxiv.org/pdf/2401.00002v1",
        };
      }
      // arxiv.org/html 404s for the paper; ar5iv answers 200 with a redirect to
      // the abstract landing page instead of failing.
      if (url.startsWith("https://arxiv.org/html/")) throw new Error("Fetch failed: 404 Not Found");
      return {
        bytes: new TextEncoder().encode("<html><body>abstract only</body></html>").buffer,
        contentType: "text/html",
        finalUrl: abstractPage,
      };
    });
    mocks.extractPdfSmart.mockResolvedValue({
      body: "Full paper text recovered from the PDF for review.",
      meta: { title: "PDF Paper", author: ["Ada Author"], source_url: abstractPage, published: "2024-01-01", description: "" },
      siteName: "arXiv",
      via: "pdf",
      linkedOut: false,
      assessment: { score: 1, flags: [] },
      images: [],
    });

    const evidence = await buildSourceEvidence(abstractPage);

    expect(mocks.fetchRawBytes.mock.calls.map(([url]) => url)).toEqual([
      "https://arxiv.org/html/2401.00002",
      "https://ar5iv.labs.arxiv.org/html/2401.00002",
      "https://arxiv.org/pdf/2401.00002",
    ]);
    expect(mocks.fetchRenderedHtml).not.toHaveBeenCalled();
    expect(evidence.manifest.media_type).toBe("pdf");
    expect(evidence.manifest.fetched_url).toBe("https://arxiv.org/pdf/2401.00002v1");
    expect(evidence.extraction.body).toContain("recovered from the PDF");
    expect(evidence.pdf?.toString("latin1")).toContain("%PDF-");
  });

  it("writes lossless line-bounded unrendered and rendered review HTML", async () => {
    const rawHtml = `<html><body><article>unrendered source</article></body></html>`;
    const renderedHtml = `<html><body><article><a href="https://example.org/reference">reference</a>${"rendered source evidence ".repeat(2_000)}</article></body></html>`;
    const formatted = formatHtmlForReview(renderedHtml);

    expect(Math.max(...formatted.split("\n").map((line) => line.length))).toBeLessThanOrEqual(8_000);
    expect(formatted.replace(/\n/g, "")).toBe(renderedHtml);

    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "html-evidence-"));
    tempDirs.push(workDir);
    await writeSourceEvidence(workDir, {
      extraction: {
        body: "source evidence",
        meta: { title: "HTML", author: ["Author"], source_url: "https://example.org/article", published: "2020-01-01", description: "" },
        siteName: "",
        via: "html",
        linkedOut: false,
        assessment: { score: 1, flags: [] },
        images: [],
      },
      manifest: {
        source_url: "https://example.org/article",
        fetched_url: "https://example.org/article",
        fetched_at: "2020-01-01T00:00:00.000Z",
        source_kind: "fixture",
        media_type: "html",
        extraction_via: "html",
        candidate_chars: 15,
      },
      rawHtml,
      renderedHtml,
    });

    const unrenderedReviewHtml = await fs.readFile(path.join(workDir, "evidence/source-unrendered.html"), "utf8");
    expect(Math.max(...unrenderedReviewHtml.split("\n").map((line) => line.length))).toBeLessThanOrEqual(8_000);
    expect(unrenderedReviewHtml.replace(/\n/g, "")).toBe(rawHtml);
    const reviewHtml = await fs.readFile(path.join(workDir, "evidence/source-rendered.html"), "utf8");
    expect(Math.max(...reviewHtml.split("\n").map((line) => line.length))).toBeLessThanOrEqual(8_000);
    expect(reviewHtml.replace(/\n/g, "")).toBe(renderedHtml);
    expect(reviewHtml).toContain('<a href="https://example.org/reference">');
    await expect(fs.stat(path.join(workDir, "evidence/source.txt"))).rejects.toThrow();
    await expect(fs.stat(path.join(workDir, "evidence/source.html"))).rejects.toThrow();
    await expect(fs.stat(path.join(workDir, "evidence/source-original.html"))).rejects.toThrow();
  });
});
