import { getDocumentProxy, getMeta } from "unpdf";
import { assessExtraction } from "./confidence";
import { dateFromUrl, isValidYmd } from "./fetch";
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
const MAX_PDF_TEXT = 4_000_000; // ~4MB of extracted text — guards a decompression bomb

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

/**
 * Reconstruct one page's text from its positioned glyph runs. Runs are grouped
 * into lines by baseline, then ordered left-to-right WITHIN each line (PDF
 * generators can emit runs out of visual order) and joined with gap-based
 * spaces; a large vertical gap becomes a paragraph break. Known limitation:
 * multi-column layouts group by baseline across columns, so the columns
 * interleave (like the scanned-PDF case, accepted for v1).
 */
export function pageText(items: unknown[]): string {
  const runs = items.filter(isTextRun);
  const lines: { y: number; runs: PdfTextRun[] }[] = [];
  let lineHeight = 10;
  for (const r of runs) {
    const y = r.transform[5];
    const h = r.height || Math.abs(r.transform[3]) || lineHeight;
    if (h) lineHeight = h;
    const last = lines[lines.length - 1];
    if (last && Math.abs(y - last.y) <= lineHeight * 0.5) last.runs.push(r);
    else lines.push({ y, runs: [r] });
  }

  const out: string[] = [];
  let prevY: number | null = null;
  for (const ln of lines) {
    ln.runs.sort((a, b) => a.transform[4] - b.transform[4]); // visual left-to-right
    let text = "";
    let prevEndX: number | null = null;
    for (const r of ln.runs) {
      const x = r.transform[4];
      const needsSpace =
        prevEndX !== null &&
        x - prevEndX > lineHeight * 0.25 &&
        !text.endsWith(" ") &&
        !r.str.startsWith(" ");
      text += (needsSpace ? " " : "") + r.str;
      prevEndX = x + (r.width || 0);
    }
    if (prevY !== null && prevY - ln.y > lineHeight * 1.7) out.push(""); // paragraph gap
    out.push(text);
    prevY = ln.y;
  }
  return out.join("\n");
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
  // Validate before formatting — a corrupt CreationDate (e.g. D:20049999) must
  // not become an invalid unquoted YAML date like "2004-99-99".
  return m && isValidYmd(m[1], m[2], m[3]) ? `${m[1]}-${m[2]}-${m[3]}` : "";
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
    if (/^by\s/i.test(l)) continue; // byline
    if (/^(vol\.?|volume|no\.?|issue|journal\b)/i.test(l)) continue; // journal metadata
    if (
      /^[A-Z][a-z]+ \d{1,2},? \d{4}$/.test(l) || // "January 15, 2004"
      /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(l) // "01/15/2004"
    )
      continue; // dates
    return l;
  }
  return "";
}

export async function extractPdf(
  bytes: ArrayBuffer,
  sourceUrl: string,
): Promise<ExtractResult> {
  let body: string;
  let info: Record<string, unknown>;
  try {
    // pdf.js takes ownership of (detaches) the passed buffer — callers must not
    // reuse `bytes` after this.
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const pageCount = Math.min(pdf.numPages, MAX_PDF_PAGES);
    const pages: string[] = [];
    let total = 0;
    for (let i = 1; i <= pageCount; i += 1) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const text = pageText(content.items);
      pages.push(text);
      total += text.length;
      if (total > MAX_PDF_TEXT) break; // guard a decompression bomb
    }
    body = cleanPdfText(pages.join("\n\n"));
    const meta = await getMeta(pdf).catch(() => null);
    info = (meta?.info ?? {}) as Record<string, unknown>;
  } catch {
    throw new Error(
      "Could not read this PDF — it may be corrupt, encrypted, or image-only.",
    );
  }

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
