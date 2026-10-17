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
  arxivSourceToHtml: vi.fn(),
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

vi.mock("./arxiv-latex", async () => {
  const actual = await vi.importActual<typeof import("./arxiv-latex")>("./arxiv-latex");
  return { ...actual, arxivSourceToHtml: mocks.arxivSourceToHtml };
});

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
    mocks.fetchRawBytes.mockImplementation(async (url: string) => {
      if (url.includes("/e-print/")) throw new Error("Fetch failed: 404 Not Found");
      return {
        bytes: new TextEncoder().encode(`<html><body>${"unrendered arXiv response ".repeat(20)}</body></html>`).buffer,
        contentType: "text/html",
        finalUrl: selectedUrl,
      };
    });
    mocks.fetchRenderedHtml.mockResolvedValue(renderedHtml);
    mocks.fetchRawHtml.mockResolvedValue(`<html><head><meta property="og:title" content="Rendered Paper"><meta name="citation_author" content="Ada Author"><meta name="citation_date" content="2024-01-02"></head></html>`);

    const evidence = await buildSourceEvidence("https://arxiv.org/abs/2401.00001");

    expect(mocks.fetchRawBytes).toHaveBeenCalledTimes(2);
    expect(mocks.fetchRawBytes).toHaveBeenLastCalledWith(selectedUrl, undefined);
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
      if (url.startsWith("https://arxiv.org/html/") || url.includes("/e-print/")) {
        throw new Error("Fetch failed: 404 Not Found");
      }
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
      "https://arxiv.org/e-print/2401.00002",
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

  it("skips a LaTeXML page that died part-way (FDT) and the empty ar5iv page (Compact Proofs) for the PDF", async () => {
    const abs = "https://arxiv.org/abs/1710.05060";
    const fatal = `<html><body><article><h1 class="ltx_title_document">FDT</h1><p>${"sections one to five ".repeat(100)}</p></article><div>Conversion to HTML had a Fatal error and exited abruptly. This document may be truncated or damaged.</div></body></html>`;
    const empty = `<html><body>\n<div class="ltx_page_main">\n No content available \n</div></body></html>`;
    mocks.fetchRawBytes.mockImplementation(async (url: string) => {
      if (url.includes("/e-print/")) throw new Error("Fetch failed: 404 Not Found");
      if (url.startsWith("https://arxiv.org/html/")) return { bytes: new TextEncoder().encode(fatal).buffer, contentType: "text/html", finalUrl: url };
      if (url.includes("ar5iv")) return { bytes: new TextEncoder().encode(empty).buffer, contentType: "text/html", finalUrl: url };
      return { bytes: new TextEncoder().encode("%PDF-1.4 whole paper").buffer, contentType: "application/pdf", finalUrl: url };
    });
    mocks.extractPdfSmart.mockResolvedValue({
      body: "The whole paper, sections one to nine, from the PDF.",
      meta: { title: "FDT", author: [], source_url: abs, published: "", description: "" },
      siteName: "arXiv",
      via: "pdf",
      linkedOut: false,
      assessment: { score: 1, flags: [] },
      images: [],
    });

    const evidence = await buildSourceEvidence(abs);
    expect(evidence.manifest.media_type).toBe("pdf");
    expect(evidence.manifest.fetched_url).toBe("https://arxiv.org/pdf/1710.05060");
    expect(evidence.rawHtml).toBeUndefined();
  });

  it("uses the converted arXiv e-print as the only candidate, with its figures, and renders nothing", async () => {
    const abs = "https://arxiv.org/abs/1609.03543";
    const converted = `<html><head><meta name="generator" content="lens-arxiv-latex"></head><body>
      <header id="title-block-header"><h1 class="title">Logical Induction</h1></header>
      <h1>Introduction</h1><p>${"Every theorem has a price ".repeat(40)}<span class="math inline">\\(\\mathbb{P}_n(\\phi)\\)</span>.</p>
      <figure><img src="lens-source-image:0" alt=""><figcaption>A market.</figcaption></figure></body></html>`;
    const figure = { png: Buffer.from("png"), mime: "image/png", yTop: 0, width: 0, height: 0 };
    mocks.fetchRawBytes.mockImplementation(async (url: string) => ({
      bytes: new TextEncoder().encode("gzip bytes").buffer,
      contentType: "application/x-eprint-tar",
      finalUrl: url.replace("/e-print/", "/src/"),
    }));
    mocks.arxivSourceToHtml.mockResolvedValue({ html: converted, images: [figure] });
    mocks.fetchRawHtml.mockResolvedValue(`<html><head><meta property="og:title" content="Logical Induction"><meta name="citation_author" content="Garrabrant, Scott"></head></html>`);

    const evidence = await buildSourceEvidence(abs);

    expect(mocks.fetchRawBytes).toHaveBeenCalledTimes(1);
    expect(mocks.fetchRenderedHtml).not.toHaveBeenCalled();
    expect(evidence.manifest.fetched_url).toBe("https://arxiv.org/src/1609.03543");
    expect(evidence.htmlCandidates?.rendered).toBeUndefined();
    expect(evidence.rawHtml).toBe(converted);
    expect(evidence.extraction.via).toBe("arxiv");
    expect(evidence.extraction.body).toContain("$\\mathbb{P}_n(\\phi)$");
    expect(evidence.extraction.body).toContain("![[__pdfimg_0__]]");
    expect(evidence.extraction.images).toEqual([figure]);
  });

  it("moves on from an e-print pandoc cannot convert", async () => {
    const abs = "https://arxiv.org/abs/2406.11779";
    mocks.fetchRawBytes.mockImplementation(async (url: string) => {
      if (url.includes("/e-print/")) return { bytes: new TextEncoder().encode("gzip").buffer, contentType: "application/gzip", finalUrl: url };
      if (url.includes("/pdf/")) return { bytes: new TextEncoder().encode("%PDF-1.4 paper").buffer, contentType: "application/pdf", finalUrl: url };
      throw new Error("Fetch failed: 404 Not Found");
    });
    mocks.arxivSourceToHtml.mockRejectedValue(new Error("pandoc exited 64: unexpected end of input"));
    mocks.extractPdfSmart.mockResolvedValue({
      body: "Compact proofs, the whole paper from the PDF.",
      meta: { title: "Compact Proofs", author: [], source_url: abs, published: "", description: "" },
      siteName: "arXiv",
      via: "pdf",
      linkedOut: false,
      assessment: { score: 1, flags: [] },
      images: [],
    });

    const evidence = await buildSourceEvidence(abs);
    expect(evidence.manifest.media_type).toBe("pdf");
    expect(evidence.extraction.body).toContain("whole paper from the PDF");
  });

  it("moves on when a converted e-print keeps almost nothing", async () => {
    const abs = "https://arxiv.org/abs/2401.00004";
    const converted = `<html><head><meta name="generator" content="lens-arxiv-latex"></head><body><header id="title-block-header"><h1 class="title">Paper</h1><p class="author">${"Author Name, Some Long Affiliation. ".repeat(10)}</p><div class="abstract">Short.</div></header><p>x</p></body></html>`;
    mocks.fetchRawBytes.mockImplementation(async (url: string) => {
      if (url.includes("/e-print/")) return { bytes: new TextEncoder().encode("gzip").buffer, contentType: "application/gzip", finalUrl: url };
      if (url.includes("/pdf/")) return { bytes: new TextEncoder().encode("%PDF-1.4 paper").buffer, contentType: "application/pdf", finalUrl: url };
      throw new Error("Fetch failed: 404 Not Found");
    });
    mocks.arxivSourceToHtml.mockResolvedValue({ html: converted, images: [] });
    mocks.extractPdfSmart.mockResolvedValue({
      body: "The whole paper from the PDF.",
      meta: { title: "Paper", author: [], source_url: abs, published: "", description: "" },
      siteName: "arXiv",
      via: "pdf",
      linkedOut: false,
      assessment: { score: 1, flags: [] },
      images: [],
    });
    const evidence = await buildSourceEvidence(abs);
    expect(evidence.manifest.media_type).toBe("pdf");
  });

  it("moves on when a converted e-print will not extract", async () => {
    const abs = "https://arxiv.org/abs/2401.00003";
    // Extracts to a block page, which extractArticle refuses.
    const converted = `<html><head><meta name="generator" content="lens-arxiv-latex"></head><body><h1>Paper</h1><p>Access denied. ${"x ".repeat(150)}</p></body></html>`;
    mocks.fetchRawBytes.mockImplementation(async (url: string) => {
      if (url.includes("/e-print/")) return { bytes: new TextEncoder().encode("gzip").buffer, contentType: "application/gzip", finalUrl: url };
      if (url.includes("/pdf/")) return { bytes: new TextEncoder().encode("%PDF-1.4 paper").buffer, contentType: "application/pdf", finalUrl: url };
      throw new Error("Fetch failed: 404 Not Found");
    });
    mocks.arxivSourceToHtml.mockResolvedValue({ html: converted, images: [] });
    mocks.extractPdfSmart.mockResolvedValue({
      body: "The paper from the PDF.",
      meta: { title: "Paper", author: [], source_url: abs, published: "", description: "" },
      siteName: "arXiv",
      via: "pdf",
      linkedOut: false,
      assessment: { score: 1, flags: [] },
      images: [],
    });

    const evidence = await buildSourceEvidence(abs);
    expect(evidence.manifest.media_type).toBe("pdf");
    expect(evidence.rawHtml).toBeUndefined();
  });

  it("reads a LessWrong wiki page from the GraphQL API as JSON and keeps its math", async () => {
    const wikiUrl = "https://www.lesswrong.com/w/updateless-decision-theory";
    const answer = {
      data: {
        tags: {
          results: [{
            name: "Updateless Decision Theory",
            description: {
              html: `<p>${"UDT chooses a policy. ".repeat(30)}Let <span class="math-tex"><span class="mjpage"><span class="mjx-chtml"><span class="mjx-math" aria-label="O"><span class="mjx-mi">O</span></span></span></span></span> be the observations; getting $100 now is as good as $200 later.</p>`,
            },
          }],
        },
      },
    };
    mocks.fetchRawBytes.mockImplementation(async (url: string) => ({
      bytes: new TextEncoder().encode(JSON.stringify(answer)).buffer,
      contentType: "application/json",
      finalUrl: url,
    }));

    const evidence = await buildSourceEvidence(wikiUrl);

    const [apiUrl, , opts] = mocks.fetchRawBytes.mock.calls[0];
    expect(apiUrl).toMatch(/^https:\/\/www\.lesswrong\.com\/graphql\?query=/);
    expect(opts).toEqual({ accept: "application/json" });
    expect(mocks.fetchRenderedHtml).not.toHaveBeenCalled();
    expect(evidence.extraction.via).toBe("forum-adapter");
    expect(evidence.extraction.meta.title).toBe("Updateless Decision Theory");
    expect(evidence.extraction.meta.source_url).toBe(wikiUrl);
    expect(evidence.extraction.body).toContain("Let $O$ be the observations");
    expect(evidence.extraction.body).toContain("getting \\$100 now is as good as \\$200 later");
  });

  describe("bot-walled candidates", () => {
    const lwUrl = "https://www.lesswrong.com/posts/TTFsKxQThrqgWeXYJ/how-might-we-safely-pass-the-buck-to-ai";
    const gwUrl = "https://www.greaterwrong.com/posts/TTFsKxQThrqgWeXYJ/how-might-we-safely-pass-the-buck-to-ai";
    // What production gets from lesswrong.com: HTTP 200 with a ~100-char
    // interstitial instead of the post.
    const botWall = `<html><head><title>Just a moment...</title></head><body><p>Verifying you are human. This may take a few seconds.</p></body></html>`;
    const mirrorPage = `<html><head><title>How might we safely pass the buck to AI? - LessWrong 2.0 viewer</title></head><body>
      <h1 class="post-title">How might we safely pass the buck to AI?</h1>
      <div class="top-post-meta"><a class="author" href="/users/joshc">joshc</a><a class="lw2-link" href="${lwUrl}">LW link</a></div>
      <div class="body-text post-body"><p>${"The mirror serves the full post body. ".repeat(80)}</p></div></body></html>`;
    const html = (body: string, finalUrl: string) => ({
      bytes: new TextEncoder().encode(body).buffer,
      contentType: "text/html",
      finalUrl,
    });

    it("skips a 200 bot-wall page and falls through to the GreaterWrong mirror", async () => {
      mocks.fetchRawBytes.mockImplementation(async (url: string) => {
        if (url.includes("/graphql")) throw new Error("Fetch failed: 429 Too Many Requests");
        return url === lwUrl ? html(botWall, lwUrl) : html(mirrorPage, gwUrl);
      });
      mocks.fetchRenderedHtml.mockImplementation(async (url: string) => (url === gwUrl ? mirrorPage : botWall));

      const evidence = await buildSourceEvidence(lwUrl);

      expect(mocks.fetchRawBytes.mock.calls.map(([url]) => url).slice(1)).toEqual([lwUrl, gwUrl]);
      expect(mocks.fetchRenderedHtml).toHaveBeenCalledWith(gwUrl, undefined);
      expect(evidence.manifest.fetched_url).toBe(gwUrl);
      expect(evidence.extraction.body).toContain("The mirror serves the full post body.");
      expect(evidence.rawHtml).toBe(mirrorPage);
    });

    it("treats a near-empty 200 page without a challenge marker as a failed candidate too", async () => {
      mocks.fetchRawBytes.mockImplementation(async (url: string) =>
        url === lwUrl ? html("<html><body><div id=\"root\">Loading</div></body></html>", lwUrl) : html(mirrorPage, gwUrl),
      );
      mocks.fetchRenderedHtml.mockResolvedValue(mirrorPage);

      const evidence = await buildSourceEvidence(lwUrl);
      expect(evidence.manifest.fetched_url).toBe(gwUrl);
    });

    it("says the source is bot-walled when every candidate and the renderer are walled", async () => {
      mocks.fetchRawBytes.mockImplementation(async (url: string) => html(botWall, url));
      mocks.fetchRenderedHtml.mockResolvedValue(botWall);

      await expect(buildSourceEvidence(lwUrl)).rejects.toThrow(/bot-walled.*try a mirror/i);
    });

    it("says the source is bot-walled when the renderer returns a near-empty page", async () => {
      mocks.fetchRawBytes.mockImplementation(async (url: string) => html(botWall, url));
      mocks.fetchRenderedHtml.mockResolvedValue("<html><body><article><p>Sign in to continue reading.</p></article></body></html>");

      await expect(buildSourceEvidence(lwUrl)).rejects.toThrow(/bot-walled.*try a mirror/i);
    });

    it("keeps the renderer's own error when every candidate is walled and the renderer fails", async () => {
      mocks.fetchRawBytes.mockImplementation(async (url: string) => html(botWall, url));
      mocks.fetchRenderedHtml.mockRejectedValue(new Error("Jina timed out"));

      // The direct-fetch part still names the wall; the renderer's failure is not hidden.
      await expect(buildSourceEvidence(lwUrl)).rejects.toThrow(
        /^Could not extract article \(direct fetch: BotWallError: Source is bot-walled.*Jina: Error: Jina timed out\)$/,
      );
    });

    it("keeps a single-candidate JS shell when the renderer recovers the article", async () => {
      const shell = "<html><head><title>App</title></head><body><div id=\"root\"></div><script>boot()</script></body></html>";
      const rendered = `<html><head><title>Rendered Article</title></head><body><article><h1>Rendered Article</h1><p>${"rendered app body ".repeat(200)}</p></article></body></html>`;
      mocks.fetchRawBytes.mockResolvedValue(html(shell, "https://example.org/app"));
      mocks.fetchRenderedHtml.mockResolvedValue(rendered);

      const evidence = await buildSourceEvidence("https://example.org/app");
      expect(mocks.fetchRenderedHtml).toHaveBeenCalledWith("https://example.org/app", undefined);
      expect(evidence.extraction.body).toContain("rendered app body");
    });
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
