import { getDocumentProxy, getMeta } from "unpdf";
import { assessExtraction } from "./confidence";
import { dateFromUrl } from "./fetch";
import type { ArticleMeta } from "./types";
import type { ExtractResult } from "./extract";

/**
 * PDF → Markdown for the article importer. A submitted `.pdf` URL has no HTML to
 * parse, so the generic Defuddle/Readability path fails ("Could not determine
 * article title"). This module fetches nothing — the caller passes the bytes —
 * and returns the SAME `ExtractResult` the HTML path produces, so every
 * downstream step (Claude QC, filename, lens, dedup) is reused unchanged.
 *
 * Text is reconstructed position-aware (PDFs emit positioned glyph runs with no
 * guaranteed separators): a horizontal gap between runs becomes a space, a
 * baseline drop a newline, and a large vertical gap a paragraph break. Markdown
 * structure (headings/columns/math) is largely not recoverable from a text
 * layer — paragraph-level fidelity is the bar. Scanned/image PDFs have no text
 * layer and yield an empty body (the pipeline's min-length guard rejects them).
 */

const MAX_PDF_PAGES = 100; // bound CPU/memory on pathological inputs

interface PdfTextRun {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

function isTextRun(item: unknown): item is PdfTextRun {
  const it = item as Partial<PdfTextRun>;
  return typeof it?.str === "string" && Array.isArray(it.transform);
}

/** Reconstruct one page's text from its positioned glyph runs. */
export function pageText(items: unknown[]): string {
  const lines: string[] = [];
  let line = "";
  let prevEndX: number | null = null;
  let prevY: number | null = null;
  let lineHeight = 10;

  for (const item of items) {
    if (!isTextRun(item)) continue;
    const { str } = item;
    const x = item.transform[4];
    const y = item.transform[5];
    const h = item.height || Math.abs(item.transform[3]) || lineHeight;
    if (h) lineHeight = h;

    if (prevY === null) {
      line = str;
    } else if (Math.abs(y - prevY) > lineHeight * 0.5) {
      lines.push(line); // baseline moved → new line
      if (prevY - y > lineHeight * 1.7) lines.push(""); // big drop → paragraph break
      line = str;
    } else {
      const gap = prevEndX === null ? 0 : x - prevEndX;
      const needsSpace =
        gap > lineHeight * 0.25 && !line.endsWith(" ") && !str.startsWith(" ");
      line += (needsSpace ? " " : "") + str;
    }

    prevEndX = x + (item.width || 0);
    prevY = y;
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

/** Tidy reconstructed text: collapse intra-line whitespace, drop standalone
 *  page-number lines, and collapse blank-line runs. */
export function cleanPdfText(raw: string): string {
  return raw
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trimEnd())
    .filter((l) => !/^\d{1,4}$/.test(l.trim())) // bare page numbers
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** PDF Info date ("D:YYYYMMDD…") → "YYYY-MM-DD". */
export function parsePdfDate(value: unknown): string {
  if (typeof value !== "string") return "";
  const m = value.match(/D:(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

/** Last URL path segment, de-extensioned and spaced — a last-resort title. */
export function filenameTitle(url: string): string {
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(seg)
      .replace(/\.pdf$/i, "")
      .replace(/[-_]+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

/** First "title-like" line: skip ALL-CAPS logo/institution banners and lines
 *  that are too short/long; take the first mixed-case line. */
export function firstLineTitle(text: string): string {
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    if (l.length < 6 || l.length > 200) continue;
    if (!/[a-z]/.test(l)) continue; // skip ALL-CAPS banners
    if (/^(abstract|introduction|contents|table of contents)$/i.test(l)) continue;
    return l;
  }
  return "";
}

export async function extractPdf(
  bytes: ArrayBuffer,
  sourceUrl: string,
): Promise<ExtractResult> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const pageCount = Math.min(pdf.numPages, MAX_PDF_PAGES);
  const pages: string[] = [];
  for (let i = 1; i <= pageCount; i += 1) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(pageText(content.items));
  }
  const body = cleanPdfText(pages.join("\n\n"));

  const meta = await getMeta(pdf).catch(() => null);
  const info = (meta?.info ?? {}) as Record<string, unknown>;

  const infoTitle = typeof info.Title === "string" ? info.Title.trim() : "";
  // The pipeline hard-requires a title; fall back through the document text and
  // finally the filename so a missing Info title doesn't fail the import (Claude
  // QC refines it afterward).
  const title = infoTitle || firstLineTitle(body) || filenameTitle(sourceUrl);

  const infoAuthor = typeof info.Author === "string" ? info.Author.trim() : "";
  const author = infoAuthor
    ? infoAuthor.split(/,| and |;/).map((a) => a.trim()).filter(Boolean)
    : [];

  const published =
    parsePdfDate(info.CreationDate) ||
    parsePdfDate(info.ModDate) ||
    dateFromUrl(sourceUrl);

  const articleMeta: ArticleMeta = {
    title,
    author,
    source_url: sourceUrl,
    published,
    description: "",
  };

  const assessment = assessExtraction({
    chosenBody: body,
    html: "",
    meta: articleMeta,
    siteName: "",
  });

  return {
    body,
    meta: articleMeta,
    siteName: "",
    via: "pdf",
    linkedOut: false,
    assessment,
  };
}
