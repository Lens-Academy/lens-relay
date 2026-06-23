import { describe, it, expect } from "vitest";
import {
  extractPdf,
  embedPdfImages,
  pageText,
  cleanPdfText,
  parsePdfDate,
  filenameTitle,
  firstLineTitle,
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
    expect(out).toContain("![[/attachments/grey-x-fig1.png]]");
    expect(out).toContain("![[/attachments/grey-x-fig2.png]]");
    expect(out).not.toMatch(/__pdfimg_/);
    expect(uploads.map((u) => u.path)).toEqual([
      "/attachments/grey-x-fig1.png",
      "/attachments/grey-x-fig2.png",
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
