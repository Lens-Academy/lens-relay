import { describe, it, expect } from "vitest";
import {
  extractPdf,
  embedPdfImages,
  pageText,
  cleanPdfText,
  parsePdfDate,
  filenameTitle,
  firstLineTitle,
  looksLikeHeading,
  authorsFromPdfText,
  repeatedFurniture,
  detectGutter,
  ocrSuspectWords,
  derivePdfMeta,
} from "./pdf";
import type { PdfPageImage } from "./pdf-images";

// A positioned glyph run, as pdf.js emits in page.getTextContent().items.
const run = (str: string, x: number, y: number, width: number, height = 10) => ({
  str,
  transform: [height, 0, 0, height, x, y],
  width,
  height,
});

describe("pageText (position-aware reconstruction)", () => {
  it("inserts a space across a horizontal gap on the same line", () => {
    // The bug: adjacent runs with no separator → "INSTITUTECoherent".
    expect(pageText([run("INSTITUTE", 0, 100, 90), run("Coherent", 200, 100, 80)])).toBe(
      "INSTITUTE Coherent",
    );
  });

  it("does NOT split a word that was emitted as two touching runs", () => {
    expect(pageText([run("Vol", 0, 100, 30), run("ition", 30, 100, 50)])).toBe("Volition");
  });

  it("breaks a line when the baseline drops", () => {
    expect(pageText([run("Line one", 0, 100, 80), run("Line two", 0, 88, 80)])).toBe(
      "Line one\nLine two",
    );
  });

  it("inserts a blank line (paragraph break) on a large vertical gap", () => {
    expect(pageText([run("Para one", 0, 100, 80), run("Para two", 0, 75, 80)])).toBe(
      "Para one\n\nPara two",
    );
  });

  it("orders runs left-to-right even when emitted out of visual order", () => {
    expect(pageText([run("World", 200, 100, 50), run("Hello", 0, 100, 50)])).toBe(
      "Hello World",
    );
  });
});

describe("cleanPdfText", () => {
  it("drops bare page-number lines, collapses whitespace and blank-line runs", () => {
    expect(cleanPdfText("Title\n\n\n\nBody  text \n42\nMore")).toBe(
      "Title\n\nBody text\nMore",
    );
  });

  it("strips C0 control bytes (e.g. a glyph that decoded to 0x0F)", () => {
    // The bug: a broken font encoding emitted a raw 0x0F where "ϵ" belonged.
    expect(cleanPdfText("beta = 0.98 and \x0f = 10")).toBe(
      "beta = 0.98 and = 10",
    );
    // No surrounding spaces → must not merge the neighbours into one token.
    expect(cleanPdfText("Pdrop\x0fls")).toBe("Pdrop ls");
  });

  it("escapes tag-opening < so placeholders survive the platform's rehype-raw", () => {
    expect(cleanPdfText("a 'text to <behavior>' model")).toBe(
      "a 'text to \\<behavior>' model",
    );
    // Comparisons are not tag-like — left alone.
    expect(cleanPdfText("P<0.05 and 1 < 2")).toBe("P<0.05 and 1 < 2");
  });
});

describe("parsePdfDate", () => {
  it("parses the PDF 'D:YYYYMMDD…' Info date", () => {
    expect(parsePdfDate("D:20040115120000Z")).toBe("2004-01-15");
  });
  it("returns '' for non-PDF-date or non-string values", () => {
    expect(parsePdfDate("2004")).toBe("");
    expect(parsePdfDate(undefined)).toBe("");
    expect(parsePdfDate(20040115)).toBe("");
  });
  it("rejects a structurally-invalid Info date (no poisoned unquoted YAML)", () => {
    expect(parsePdfDate("D:20049999000000")).toBe("");
    expect(parsePdfDate("D:20040000")).toBe("");
  });
});

describe("filenameTitle", () => {
  it("uses the last path segment, de-extensioned and spaced", () => {
    expect(filenameTitle("https://intelligence.org/files/CEV.pdf")).toBe("CEV");
    expect(filenameTitle("https://x.org/a/ai_drives_final.pdf")).toBe("ai drives final");
    expect(filenameTitle("https://x.org/NeedForBias_1980.pdf")).toBe("NeedForBias 1980");
  });
});

describe("firstLineTitle", () => {
  it("skips ALL-CAPS banners and short lines, taking the first mixed-case title", () => {
    expect(
      firstLineTitle(
        "MIRI\nMACHINE INTELLIGENCE RESEARCH INSTITUTE\nCoherent Extrapolated Volition\nEliezer Yudkowsky",
      ),
    ).toBe("Coherent Extrapolated Volition");
  });
  it("skips a leading 'Abstract' heading", () => {
    expect(firstLineTitle("Abstract\nThe Real Title Here")).toBe("The Real Title Here");
  });
  it("skips bylines, journal metadata, and date lines", () => {
    expect(firstLineTitle("by Jane Doe\nThe Real Title")).toBe("The Real Title");
    expect(firstLineTitle("Journal of AI Safety, Vol 3\nThe Real Title")).toBe(
      "The Real Title",
    );
    expect(firstLineTitle("January 15, 2004\nThe Real Title")).toBe("The Real Title");
  });

  it("skips venue/publication banners (running headers)", () => {
    expect(
      firstLineTitle(
        "Published as a conference paper at ICLR 2024\nThe Real Paper Title",
      ),
    ).toBe("The Real Paper Title");
    expect(firstLineTitle("Preprint. Under review.\nThe Real Title")).toBe(
      "The Real Title",
    );
  });

  it("joins a title that wraps on a function word", () => {
    expect(
      firstLineTitle("Computing Power and the\nGovernance of Artificial Intelligence"),
    ).toBe("Computing Power and the Governance of Artificial Intelligence");
    // …but stops at a byline rather than swallowing it.
    expect(firstLineTitle("The Ethics of\nby Jane Doe")).toBe("The Ethics of");
  });

  it("accepts a long clean ALL-CAPS title but still skips institution banners", () => {
    expect(
      firstLineTitle(
        "Published as a conference paper at ICLR 2024\n∗ Alice, Bob, Carol\nSPARSE AUTOENCODERS FIND HIGHLY INTERPRETABLE FEATURES IN LANGUAGE MODELS\nAbstract",
      ),
    ).toBe("SPARSE AUTOENCODERS FIND HIGHLY INTERPRETABLE FEATURES IN LANGUAGE MODELS");
  });

  it("ignores leaked heading markup when reading the title", () => {
    expect(firstLineTitle("## The Real Title\nbody")).toBe("The Real Title");
  });

  it("rejoins a title broken across a hyphenated line wrap", () => {
    expect(
      firstLineTitle("Sparse Autoencoders Find Highly Inter-\npretable Features"),
    ).toBe("Sparse Autoencoders Find Highly Interpretable Features");
  });
});

describe("looksLikeHeading", () => {
  it("tags numbered sections and canonical heading words", () => {
    expect(looksLikeHeading("1 Introduction")).toBe(true);
    expect(looksLikeHeading("3.2 Model Architecture")).toBe(true);
    expect(looksLikeHeading("Abstract")).toBe(true);
    expect(looksLikeHeading("References")).toBe(true);
  });
  it("does not tag prose, numbered list sentences, or document titles", () => {
    expect(looksLikeHeading("OpenAI o3 and o4-mini System Card")).toBe(false);
    expect(looksLikeHeading("1. We propose a new method that improves results.")).toBe(false);
    expect(looksLikeHeading("The models use tools in their chain of thought.")).toBe(false);
    expect(looksLikeHeading("number of shots")).toBe(false); // figure-axis label
  });
  it("does not tag de-laid-out author/affiliation lines that mimic sections", () => {
    expect(looksLikeHeading("2 Cornell Tech")).toBe(false);
    expect(looksLikeHeading("3 Stanford University")).toBe(false);
    expect(looksLikeHeading("123 Camille Chabot14 Betsy Popken1")).toBe(false);
    expect(looksLikeHeading("2 Sarah Shoker,1 Janet Egan,10 Robert Trager")).toBe(false);
  });
});

describe("authorsFromPdfText", () => {
  it("extracts a clean comma/and-separated byline before the abstract", () => {
    expect(
      authorsFromPdfText("A Great Title\nAlice Smith, Bob Jones and Carol Lee\nAbstract\nWe..."),
    ).toEqual(["Alice Smith", "Bob Jones", "Carol Lee"]);
  });

  it("rejects scrambled/affiliation/footnote lines (falls back to publisher)", () => {
    expect(authorsFromPdfText("Title\nCem Anil∗ Esin Durmus\nAbstract")).toEqual([]);
    expect(authorsFromPdfText("Title\nStanford University, Google Research\nAbstract")).toEqual([]);
    expect(authorsFromPdfText("Title\n123 Camille Chabot14\nAbstract")).toEqual([]);
    expect(
      authorsFromPdfText("Title\nA single body sentence that is not a byline.\nAbstract"),
    ).toEqual([]);
  });
});

describe("repeatedFurniture", () => {
  it("flags edge texts recurring on >= minRepeat pages (page numbers normalized)", () => {
    const perPage = [
      ["Center for Security | 1", "Intro", "body", "footer note"],
      ["Center for Security | 2", "More", "body", "footer note"],
      ["Center for Security | 3", "Yet more", "body", "footer note"],
    ];
    const f = repeatedFurniture(perPage, 3);
    expect(f.has("center for security |")).toBe(true);
    expect(f.has("footer note")).toBe(true);
    expect(f.has("intro")).toBe(false);
  });
});

describe("detectGutter", () => {
  const r = (x: number, w: number, y: number) => ({
    str: "x",
    transform: [10, 0, 0, 10, x, y] as number[],
    width: w,
    height: 10,
  });
  it("detects a central gutter on a two-column page", () => {
    // page width 600; left col ~50–250, right col ~310–510, ~60px gutter
    const lines = [80, 60, 40, 20].map((y) => ({ y, runs: [r(50, 200, y), r(310, 200, y)] }));
    const g = detectGutter(lines, 600);
    expect(g).not.toBeNull();
    expect(g as number).toBeGreaterThan(240);
    expect(g as number).toBeLessThan(320);
  });
  it("returns null for single-column text and when width is unknown", () => {
    const oneCol = [80, 60, 40, 20].map((y) => ({ y, runs: [r(50, 180, y), r(240, 180, y)] }));
    expect(detectGutter(oneCol, 600)).toBeNull(); // gap ~10px, not a gutter
    expect(detectGutter(oneCol, 0)).toBeNull();
  });
});

describe("extractPdf", () => {
  it("throws a friendly error on unreadable PDF bytes", async () => {
    const garbage = new TextEncoder().encode("this is plainly not a pdf").buffer;
    await expect(extractPdf(garbage, "https://example.org/a.pdf")).rejects.toThrow(
      /Could not read this PDF/,
    );
  });
});

describe("embedPdfImages", () => {
  const img = (n: number): PdfPageImage => ({
    png: Buffer.from(`png-${n}`),
    yTop: 0,
    width: 1,
    height: 1,
  });

  it("uploads each image and swaps placeholders for attachment embeds", async () => {
    const body = "Intro.\n\n![[__pdfimg_0__]]\n\nMiddle.\n\n![[__pdfimg_1__]]\n\nEnd.";
    const uploads: { path: string; bytes: Buffer }[] = [];
    const out = await embedPdfImages(body, [img(0), img(1)], "grey-x", async (p, png) => {
      uploads.push({ path: p, bytes: png });
    });
    expect(out).toContain("![[/attachments/grey-x-fig1-26eb0004.png]]");
    expect(out).toContain("![[/attachments/grey-x-fig2-686b585e.png]]");
    expect(out).not.toMatch(/__pdfimg_/);
    expect(uploads.map((u) => u.path)).toEqual([
      "/attachments/grey-x-fig1-26eb0004.png",
      "/attachments/grey-x-fig2-686b585e.png",
    ]);
    expect(uploads[0].bytes.toString()).toBe("png-0");
  });

  it("drops a figure whose upload fails, keeping the surrounding text", async () => {
    const body = "Before.\n\n![[__pdfimg_0__]]\n\nAfter.";
    const out = await embedPdfImages(body, [img(0)], "x", async () => {
      throw new Error("upload failed");
    });
    expect(out).not.toMatch(/__pdfimg_|attachments/);
    expect(out).toContain("Before.");
    expect(out).toContain("After.");
  });
});

describe("ocrSuspectWords", () => {
  // Prevents: silent model-OCR word substitutions on born-digital PDFs
  // ("satisfice" → "satiate" observed on CEV in the blind eval).
  it("flags provider words absent from the text layer", () => {
    const layer = "only enough to satisfice, said the paper about volition.";
    const provider = "only enough to satiate, said the paper about volition.";
    expect(ocrSuspectWords(provider, layer)).toEqual(["satiate"]);
  });

  it("ignores the provider's own figure captions", () => {
    const layer = "The measured accuracy improves with scale.";
    const provider =
      "The measured accuracy improves with scale.\n\n![[__pdfimg_0__]]\n\nMIRI logo: a stylized bird-like icon with wings spread.";
    expect(ocrSuspectWords(provider, layer)).toEqual([]);
  });

  it("returns empty when texts agree", () => {
    const t = "identical wording across both extraction paths here.";
    expect(ocrSuspectWords(t, t)).toEqual([]);
  });
});

describe("isJunkInfoTitle / derivePdfMeta junk titles", () => {
  // Prevents: "Microsoft Word - final_v2.docx" / "-----" winning as the title.
  it("prefers the body title over word-processor artifacts", () => {
    const body = "A Real Title Here\n\nOpening paragraph of the document body.";
    expect(
      derivePdfMeta({ Title: "Microsoft Word - final_v2.docx" }, body, "https://x.org/a.pdf").title,
    ).toBe("A Real Title Here");
    expect(derivePdfMeta({ Title: "-----" }, body, "https://x.org/a.pdf").title).toBe(
      "A Real Title Here",
    );
    expect(derivePdfMeta({ Title: "untitled" }, body, "https://x.org/a.pdf").title).toBe(
      "A Real Title Here",
    );
    // real Info titles still win
    expect(
      derivePdfMeta({ Title: "Robustness of Frontier Models" }, body, "https://x.org/a.pdf").title,
    ).toBe("Robustness of Frontier Models");
  });
});

describe("firstLineTitle — cover image then title", () => {
  // Prevents: a logo-then-title cover page taking the first body sentence.
  it("keeps a short title line after an image, skips caption-like lines", () => {
    expect(
      firstLineTitle(
        "![[__pdfimg_0__]]\n\nGreat Paper Title\n\nThis opening paragraph describes the study in detail.",
      ),
    ).toBe("Great Paper Title");
    expect(
      firstLineTitle(
        "![[__pdfimg_0__]]\n\nMIRI logo: a stylized bird-like icon with wings spread, followed by large bold letters and a subtitle underneath it.\n\nCoherent Extrapolated Volition\n\nBody.",
      ),
    ).toBe("Coherent Extrapolated Volition");
  });
});

describe("ocrSuspectWords — hyphenation", () => {
  // Prevents: end-of-line hyphenation wraps counting as OCR substitutions.
  it("de-hyphenates the text layer before comparing", () => {
    const layer = "The model is inter-\npretable and highly reli-\nable in tests.";
    const provider = "The model is interpretable and highly reliable in tests.";
    expect(ocrSuspectWords(provider, layer)).toEqual([]);
  });
});

describe("ocrSuspectWords — unicode coverage", () => {
  // Prevents: the OCR cross-check being silently blind on non-English PDFs.
  it("detects accented-word substitutions", () => {
    const layer = "le résumé complet était présenté clairement aujourd'hui.";
    const provider = "le résume complet était présenté clairement aujourd'hui.";
    expect(ocrSuspectWords(provider, layer)).toEqual(["résume"]);
  });
});

describe("embedPdfImages — content-hash attachment names (reviewer M1)", () => {
  // Prevents: two DISTINCT articles sharing a filename base silently aliasing
  // each other's figures via the relay's create-only attachment conflict.
  it("names attachments with a content-hash suffix; different bytes never collide", async () => {
    const mk = (s: string): PdfPageImage => ({ png: Buffer.from(s), yTop: 0, width: 10, height: 10 });
    const uploads: string[] = [];
    const up = async (p: string) => { uploads.push(p); };
    const outA = await embedPdfImages("![[__pdfimg_0__]]", [mk("article-A-figure")], "grey-introduction", up);
    const outB = await embedPdfImages("![[__pdfimg_0__]]", [mk("article-B-figure")], "grey-introduction", up);
    expect(uploads[0]).toMatch(/^\/attachments\/grey-introduction-fig1-[0-9a-f]{8}\.png$/);
    expect(uploads[1]).toMatch(/^\/attachments\/grey-introduction-fig1-[0-9a-f]{8}\.png$/);
    expect(uploads[0]).not.toBe(uploads[1]); // different content → different path
    expect(outA).toContain(uploads[0]);
    expect(outB).toContain(uploads[1]);
    // identical bytes → identical path (harmless blob dedup)
    const outC = await embedPdfImages("![[__pdfimg_0__]]", [mk("article-A-figure")], "grey-introduction", up);
    expect(uploads[2]).toBe(uploads[0]);
    expect(outC).toContain(uploads[0]);
  });
});
