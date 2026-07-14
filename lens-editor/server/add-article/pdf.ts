import { createHash } from "node:crypto";
import { getDocumentProxy, getMeta, extractText } from "unpdf";
import { assessExtraction } from "./confidence";
import { dateFromUrl, yearFromUrl, isValidYmd } from "./fetch";
import {
  extractPageImages,
  repeatedImageHashes,
  type PdfPageImage,
} from "./pdf-images";
import { configuredPdfProvider, parsePdfWithProvider } from "./pdf-provider";
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

const MAX_PDF_PAGES = 300; // bound CPU/memory; longer docs still get a truncation note
const MAX_PDF_TEXT = 4_000_000; // ~4MB of extracted text — guards a decompression bomb
const MIN_IMAGE_REPEAT = 3; // identical raster on ≥3 pages ⇒ boilerplate, not a figure
const FURNITURE_REPEAT = 3; // a header/footer line on ≥3 pages ⇒ running furniture

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

interface PageBlock {
  /** Distance from the top of the page (smaller = higher up). */
  yTop: number;
  text: string;
  isImage?: boolean;
}

const GUTTER_MIN_FRAC = 0.08; // a central gap this wide (of page width) ⇒ column gutter
const GUTTER_LINE_FRAC = 0.3; // this fraction of lines split at the gutter ⇒ two-column

const runHeight = (r: PdfTextRun): number =>
  r.height || Math.abs(r.transform[3]) || 0;

/**
 * Whether a reconstructed line is a section heading. Pattern-based — numbered
 * sections ("3.2 Method") or canonical heading words ("Abstract", "References")
 * — rather than font size, which is too noisy across PDFs and over-tags
 * dramatically. High precision over recall: a false `##` on body text is worse
 * than a missed heading.
 */
export function looksLikeHeading(text: string): boolean {
  const t = text.trim();
  if (t.length < 3 || t.length > 70) return false;
  if (/[.;:]$/.test(t)) return false; // sentences / label lines
  const known =
    /^(abstract|introduction|background|related works?|methods?|methodology|experimental setup|experiments?|results?|evaluation|analysis|discussion|conclusions?|limitations?|future work|references|acknowledge?ments?|appendix|appendices|ethics statement)\s*$/i;
  if (known.test(t)) return true; // canonical heading words (whole-line)
  if (!/^\d+(\.\d+){0,3}\.?\s+[A-Z]/.test(t)) return false; // else a numbered section
  const rest = t.replace(/^\d+(\.\d+){0,3}\.?\s*/, "");
  // Reject de-laid-out author/affiliation/footnote lines that mimic a numbered
  // section ("2 Cornell Tech", "123 Camille Chabot14", "8 Smith, Jones, …").
  if (/[,\d]/.test(rest)) return false;
  if (
    /\b(University|Institut|College|Academy|Laborator|Department|Tech|School|Hospital)\b/i.test(
      rest,
    )
  )
    return false;
  // A heading is a short, mostly-capitalized phrase, not a numbered sentence.
  const words = rest.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 8) return false;
  const capitalized = words.filter((w) => /^[A-Z(]/.test(w)).length;
  return capitalized >= Math.ceil(words.length * 0.6);
}

/** Render one line's runs into text: x-ordered, with a space inserted across a
 *  horizontal gap (PDFs emit positioned glyph runs with no guaranteed separator). */
function lineToText(runs: PdfTextRun[], lineHeight: number): string {
  const sorted = [...runs].sort((a, b) => a.transform[4] - b.transform[4]);
  let text = "";
  let prevEndX: number | null = null;
  for (const r of sorted) {
    const x = r.transform[4];
    const needsSpace =
      prevEndX !== null &&
      x - prevEndX > lineHeight * 0.25 &&
      !text.endsWith(" ") &&
      !r.str.startsWith(" ");
    text += (needsSpace ? " " : "") + r.str;
    prevEndX = x + (r.width || 0);
  }
  return text;
}

/**
 * Detect a two-column gutter: the x-position of a consistent central gap. Returns
 * its x, or null when the page isn't confidently two-column (so single-column
 * pages are never reshuffled). A line is "split" when its widest inter-run gap is
 * wide AND sits near the page midline; enough such lines ⇒ two columns.
 */
export function detectGutter(
  lines: { y: number; runs: PdfTextRun[] }[],
  vpWidth: number,
): number | null {
  if (vpWidth <= 0) return null;
  const mid = vpWidth / 2;
  const minGap = vpWidth * GUTTER_MIN_FRAC;
  const gutters: number[] = [];
  let multiRun = 0;
  for (const ln of lines) {
    if (ln.runs.length < 2) continue;
    multiRun += 1;
    const sorted = [...ln.runs].sort((a, b) => a.transform[4] - b.transform[4]);
    let bestGap = 0;
    let bestMid = 0;
    for (let i = 1; i < sorted.length; i += 1) {
      const prevEnd = sorted[i - 1].transform[4] + (sorted[i - 1].width || 0);
      const gap = sorted[i].transform[4] - prevEnd;
      if (gap > bestGap) {
        bestGap = gap;
        bestMid = (prevEnd + sorted[i].transform[4]) / 2;
      }
    }
    if (bestGap >= minGap && Math.abs(bestMid - mid) < vpWidth * 0.2) {
      gutters.push(bestMid);
    }
  }
  if (multiRun >= 4 && gutters.length >= multiRun * GUTTER_LINE_FRAC) {
    gutters.sort((a, b) => a - b);
    return gutters[Math.floor(gutters.length / 2)];
  }
  return null;
}

/**
 * Group a page's glyph runs into visual lines (x-ordered, gap-spaced), each with
 * its distance from the page top. `vpHeight` maps PDF baselines (measured from
 * the bottom) to top-down `yTop`. When `vpWidth` is given and the page is
 * confidently two-column, runs are split at the gutter and the right column is
 * offset so it reads after the left (instead of braiding line-by-line). Lines
 * notably taller than the body median become `##` headings.
 */
function renderTextBlocks(
  items: unknown[],
  vpHeight: number,
  vpWidth = 0,
): { blocks: PageBlock[]; lineHeight: number } {
  const runs = items.filter(isTextRun);
  const lines: { y: number; runs: PdfTextRun[] }[] = [];
  let lineHeight = 10;
  for (const r of runs) {
    const y = r.transform[5];
    const h = runHeight(r) || lineHeight;
    if (h) lineHeight = h;
    const last = lines[lines.length - 1];
    if (last && Math.abs(y - last.y) <= lineHeight * 0.5) last.runs.push(r);
    else lines.push({ y, runs: [r] });
  }

  const gutter = detectGutter(lines, vpWidth);
  const blocks: PageBlock[] = [];
  const add = (lineRuns: PdfTextRun[], y: number, yOffset: number) => {
    if (lineRuns.length === 0) return;
    const text = lineToText(lineRuns, lineHeight);
    if (!text.trim()) return;
    blocks.push({
      yTop: vpHeight - y + yOffset,
      text: looksLikeHeading(text) ? `## ${text}` : text,
    });
  };

  for (const ln of lines) {
    const sorted = [...ln.runs].sort((a, b) => a.transform[4] - b.transform[4]);
    if (gutter !== null) {
      // Find a wide gap straddling the gutter; if present this is a two-column
      // line — emit left then (offset so it sorts after all left content) right.
      let splitIdx = -1;
      for (let i = 1; i < sorted.length; i += 1) {
        const prevEnd = sorted[i - 1].transform[4] + (sorted[i - 1].width || 0);
        if (
          sorted[i - 1].transform[4] < gutter &&
          sorted[i].transform[4] >= gutter &&
          sorted[i].transform[4] - prevEnd >= vpWidth * GUTTER_MIN_FRAC
        ) {
          splitIdx = i;
          break;
        }
      }
      if (splitIdx > 0) {
        add(sorted.slice(0, splitIdx), ln.y, 0);
        add(sorted.slice(splitIdx), ln.y, vpHeight);
        continue;
      }
      // Whole line: a right-only column line is offset; full-width / left stays.
      const startX = sorted[0].transform[4];
      const last = sorted[sorted.length - 1];
      const endX = last.transform[4] + (last.width || 0);
      const rightOnly = startX >= gutter && endX > gutter;
      add(sorted, ln.y, rightOnly ? vpHeight : 0);
      continue;
    }
    add(sorted, ln.y, 0);
  }
  return { blocks, lineHeight };
}

/** Join positioned blocks top-to-bottom, inserting a blank line on a large
 *  vertical gap (paragraph break) and around image blocks. */
function joinBlocks(blocks: PageBlock[], lineHeight: number): string {
  const sorted = [...blocks].sort((a, b) => a.yTop - b.yTop);
  const out: string[] = [];
  let prevYTop: number | null = null;
  let prevImage = false;
  for (const b of sorted) {
    if (
      prevYTop !== null &&
      (b.isImage || prevImage || b.yTop - prevYTop > lineHeight * 1.7)
    ) {
      out.push(""); // paragraph gap, or separation around an image
    }
    out.push(b.text);
    prevYTop = b.yTop;
    prevImage = !!b.isImage;
  }
  return out.join("\n");
}

/** Normalize a header/footer line for cross-page comparison (page numbers vary
 *  per page, so strip digits before counting recurrences). */
function normalizeFurniture(s: string): string {
  return s.replace(/\d+/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** A page's header/footer candidates: its top-2 and bottom-2 text blocks. */
function pageEdgeTexts(blocks: PageBlock[]): string[] {
  const sorted = [...blocks]
    .filter((b) => !b.isImage)
    .sort((a, b) => a.yTop - b.yTop);
  return [...sorted.slice(0, 2), ...sorted.slice(-2)].map((b) => b.text);
}

/** Normalized edge texts that recur on >= minRepeat pages — running heads/footers
 *  to strip from the body (counted once per page). */
export function repeatedFurniture(
  perPageEdges: string[][],
  minRepeat: number,
): Set<string> {
  const counts = new Map<string, number>();
  for (const edges of perPageEdges) {
    const seen = new Set<string>();
    for (const t of edges) {
      const n = normalizeFurniture(t);
      if (n.length < 4 || seen.has(n)) continue;
      seen.add(n);
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
  }
  return new Set([...counts].filter(([, c]) => c >= minRepeat).map(([n]) => n));
}

/** Reconstruct one page's text from its positioned glyph runs (text only). */
export function pageText(items: unknown[]): string {
  const { blocks, lineHeight } = renderTextBlocks(items, 0);
  return joinBlocks(blocks, lineHeight);
}

/** Tidy reconstructed text: collapse intra-line whitespace, drop standalone
 *  page-number lines, and collapse blank-line runs. */
export function cleanPdfText(raw: string): string {
  return raw
    // Drop C0 control bytes (keep \t and \n). A broken font encoding can decode
    // a glyph to e.g. 0x0F (where an "ϵ" belonged); left in, it corrupts the
    // body and breaks rendering/copy-paste. Replace with a space so adjacent
    // tokens don't merge; the whitespace collapse below tidies the result.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B-\x1F]/g, " ")
    // The platform renders bodies with rehype-raw, so a literal `<word>` in
    // PDF prose would be parsed as an HTML tag and silently vanish — the same
    // failure the HTML path escapes in makeTurndown. This text is a plain
    // reconstructed text layer (never intentional HTML), so escape every
    // tag-opening `<`. Comparisons like "P<0.05" or "1 < 2" don't match.
    .replace(/<(?=[a-zA-Z/!?])/g, "\\<")
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

/** A line that is page furniture rather than a title: venue/publication
 *  banners, copyright/identifier lines. These often run as a header on page 1
 *  and were being mistaken for the title (e.g. "Published as a conference paper
 *  at ICLR 2024"). */
function isBannerLine(l: string): boolean {
  return /^(published\b|to appear\b|accepted (at|to|for)\b|under review\b|preprint\b|proceedings\b|in proceedings\b|workshop on\b|conference on\b|©|copyright\b|arxiv[:\s]|doi[:\s]|isbn\b|draft\b)/i.test(
    l,
  );
}

/** An ALL-CAPS line that is plausibly a real title rather than an institution
 *  banner: long, multi-word, and without org/venue keywords. Lets a paper whose
 *  title is typeset in caps survive (vs. "MACHINE INTELLIGENCE RESEARCH
 *  INSTITUTE", which is short-ish and keyword-flagged). */
function isLikelyAllCapsTitle(l: string): boolean {
  const words = l.split(/\s+/).filter(Boolean);
  return (
    l.length >= 25 &&
    words.length >= 5 &&
    !/\b(INSTITUTE|UNIVERSITY|LABORATOR|DEPARTMENT|PROCEEDINGS|CONFERENCE|WORKSHOP|JOURNAL|SOCIETY|FOUNDATION|REPORT|BULLETIN)\b/.test(
      l,
    )
  );
}

/** First "title-like" line: skip ALL-CAPS logo/institution banners, venue
 *  banners, and lines that are too short/long; take the first mixed-case line.
 *  Joins continuation lines when the title clearly wraps ("…and the" → next). */
export function firstLineTitle(text: string): string {
  const lines = text.split("\n").map((l) =>
    l
      .trim()
      .replace(/^#+\s*/, "")
      // Cover-page rules typeset around the title come through as dashes
      // ("--- Coherent Extrapolated Volition ---") — strip the decoration.
      .replace(/^[-–—]{2,}\s*/, "")
      .replace(/\s*[-–—]{2,}$/, ""),
  );
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.length < 6 || l.length > 200) continue;
    if (/^!\[/.test(l)) continue; // image embed/figure placeholder, not a title
    // The line after an image is usually its caption (hosted parsers emit
    // "<image>\n\nMIRI logo: a stylized bird…") — but a cover page can also be
    // logo-then-TITLE, so only skip it when it reads like a caption (longish
    // sentence with terminal punctuation), never when it looks like a title.
    const prev = lines.slice(0, i).filter(Boolean).pop() ?? "";
    if (/^!\[/.test(prev) && (l.length > 90 || /[.!?]$/.test(l))) continue;
    if (l.length > 80 && /[.!?]$/.test(l)) continue;
    if (/^[∗†‡§*•]/.test(l)) continue; // scrambled author/footnote line, not a title
    if (!/[a-z]/.test(l) && !isLikelyAllCapsTitle(l)) continue; // ALL-CAPS banner
    if (/^(abstract|introduction|contents|table of contents)$/i.test(l)) continue;
    if (/^by\s/i.test(l)) continue; // byline
    if (/^(vol\.?|volume|no\.?|issue|journal\b)/i.test(l)) continue; // journal metadata
    if (isBannerLine(l)) continue; // venue / copyright / identifier banner
    if (
      /^[A-Z][a-z]+ \d{1,2},? \d{4}$/.test(l) || // "January 15, 2004"
      /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(l) // "01/15/2004"
    )
      continue; // dates
    // A title that wraps ends mid-phrase on a function word ("…and the"); pull
    // in following lines until it no longer does, but never a byline/banner.
    let title = l;
    let j = i + 1;
    while (
      j < lines.length &&
      // continues if the title ends on a function word ("…and the") or a
      // hyphenated word-break ("…INTER-")
      /(\b(the|a|an|and|or|of|for|to|in|on|with|from|into|over|under|&)|[A-Za-z]-)$/i.test(title) &&
      lines[j].length >= 2 &&
      lines[j].length <= 200 &&
      /[A-Za-z]/.test(lines[j]) &&
      !/^(by\s|abstract$)/i.test(lines[j]) &&
      !isBannerLine(lines[j])
    ) {
      title = /[A-Za-z]-$/.test(title)
        ? title.slice(0, -1) + lines[j] // de-hyphenate a wrapped word
        : title + " " + lines[j];
      j += 1;
    }
    return title;
  }
  return "";
}

/**
 * Best-effort author names from a PDF's title page, used only when the Info dict
 * has no Author (otherwise the pipeline falls back to the publisher/host, which
 * is junk for CDN/repository hosts like "Googleapis"/"Openreview"). Deliberately
 * conservative: it accepts a clean byline — two or more Title-Case names,
 * comma/"and"-separated, before the abstract, with no digits, footnote symbols,
 * emails, or affiliation words — so a scrambled title page yields nothing rather
 * than garbage, and the existing fallback (or Claude QC) takes over.
 */
export function authorsFromPdfText(body: string): string[] {
  const lines = body.split("\n").map((l) => l.trim());
  const stop = lines.findIndex((l) =>
    /^(abstract|introduction|1\.?\s+introduction)\b/i.test(l),
  );
  const region = lines.slice(0, stop === -1 ? Math.min(lines.length, 25) : stop);
  const isName = (s: string) =>
    /^[A-Z][a-zA-Z'’.-]+(?:\s[A-Z][a-zA-Z'’.-]+){1,3}$/.test(s);
  const AFFILIATION =
    /\b(University|Institut|Department|Laborator|Labs?|Inc|LLC|Corporation|College|School|Center|Centre|Research|Foundation|Google|OpenAI|Microsoft|Meta|DeepMind|Anthropic)\b/;
  for (const l of region) {
    if (l.length < 6 || l.length > 150) continue;
    if (/[0-9∗†‡§@]/.test(l)) continue; // footnote markers, emails, affil digits
    if (AFFILIATION.test(l)) continue;
    const parts = l
      .split(/\s*,\s*|\s+and\s+|\s*&\s*/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length >= 2 && parts.length <= 12 && parts.every(isName)) {
      return parts;
    }
  }
  return [];
}

/** Title/author/date from the PDF Info dict + the reconstructed body text +
 *  the source URL — shared by the local and hosted-provider extraction paths. */
/** Info-dict titles that are file artifacts, not titles: word-processor
 *  prefixes ("Microsoft Word - final_v2.docx"), filenames, "untitled",
 *  all-punctuation strings. Extremely common in real-world PDFs. */
export function isJunkInfoTitle(t: string): boolean {
  if (t.length < 4) return true;
  if (!/[a-zA-Z]/.test(t)) return true; // "-----", "***"
  if (/^(microsoft (word|powerpoint)|untitled|document\d*|draft\d*|new document|印刷|presentation\d*)\b/i.test(t)) return true;
  if (/\.(docx?|pdf|te?x|indd|pages|pptx?|odt|rtf)\s*$/i.test(t)) return true;
  return false;
}

export function derivePdfMeta(
  info: Record<string, unknown>,
  body: string,
  sourceUrl: string,
): ArticleMeta {
  const rawInfoTitle = typeof info.Title === "string" ? info.Title.trim() : "";
  // Junk Info titles must never win over the reconstructed body title — and
  // never come back as a later fallback either.
  const infoTitle = isJunkInfoTitle(rawInfoTitle) ? "" : rawInfoTitle;
  // A short Info title ending on a function word is usually itself truncated
  // (e.g. "Computing Power and the") — prefer the reconstructed body title then.
  const infoTruncated = /\b(the|a|an|and|or|of|for|to|in|on|with)$/i.test(infoTitle);
  // The pipeline hard-requires a title; fall back through the document text and
  // finally the filename so a missing/garbled Info title doesn't fail the import
  // (Claude QC refines it afterward).
  const title =
    (infoTruncated ? "" : infoTitle) ||
    firstLineTitle(body) ||
    infoTitle ||
    filenameTitle(sourceUrl);

  const infoAuthor = typeof info.Author === "string" ? info.Author.trim() : "";
  const author = infoAuthor
    ? infoAuthor.split(/,| and |;/).map((a) => a.trim()).filter(Boolean)
    : authorsFromPdfText(body);

  // A date in the canonical source URL is more trustworthy than the PDF's
  // ModDate (often just a re-save timestamp — e.g. a PyPDF2 reprocessing long
  // after publication), but less authoritative than an explicit CreationDate
  // (the authoring date). A year-only URL segment (e.g. a proceedings
  // ".../2017/...") also beats ModDate; ModDate is only the last resort.
  const published =
    parsePdfDate(info.CreationDate) ||
    dateFromUrl(sourceUrl) ||
    yearFromUrl(sourceUrl) ||
    parsePdfDate(info.ModDate);

  return { title, author, source_url: sourceUrl, published, description: "" };
}

export async function extractPdf(
  bytes: ArrayBuffer,
  sourceUrl: string,
): Promise<ExtractResult> {
  let body: string;
  let info: Record<string, unknown>;
  const images: PdfPageImage[] = [];
  let truncated = false;
  let totalPages = 0;
  let processedPages = 0;
  try {
    // pdf.js takes ownership of (detaches) the passed buffer — callers must not
    // reuse `bytes` after this.
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    totalPages = pdf.numPages;
    const pageCount = Math.min(pdf.numPages, MAX_PDF_PAGES);
    if (pdf.numPages > pageCount) truncated = true;
    // Pass 1: per page, reconstruct text blocks and extract (already
    // decoration-filtered) figures, hashing each so cross-page repeats can be
    // dropped. Bounded by the page/text caps; long docs get a note below.
    const perPage: {
      blocks: PageBlock[];
      lineHeight: number;
      imgs: { img: PdfPageImage; hash: string }[];
    }[] = [];
    let total = 0;
    for (let i = 1; i <= pageCount; i += 1) {
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const { blocks, lineHeight } = renderTextBlocks(content.items, vp.height, vp.width);
      const imgs = (await extractPageImages(pdf, i).catch(() => [])).map((img) => ({
        img,
        hash: createHash("sha1").update(img.png).digest("hex"),
      }));
      perPage.push({ blocks, lineHeight, imgs });
      total += blocks.reduce((n, b) => n + b.text.length, 0);
      if (total > MAX_PDF_TEXT) {
        truncated = true;
        break; // guard a decompression bomb
      }
    }
    processedPages = perPage.length;
    // A figure that recurs across pages is boilerplate (logo, running header,
    // page background/template), not content — drop every instance.
    const repeated = repeatedImageHashes(
      perPage.flatMap((p) => p.imgs.map((x) => x.hash)),
      MIN_IMAGE_REPEAT,
    );
    // Running heads/footers that recur across pages — strip them from the body.
    const furniture = repeatedFurniture(
      perPage.map((p) => pageEdgeTexts(p.blocks)),
      FURNITURE_REPEAT,
    );
    // Pass 2: assemble the body, interleaving a placeholder at each surviving
    // figure's position; the pipeline uploads them and swaps in the real embed.
    const pages: string[] = [];
    for (const { blocks, lineHeight, imgs } of perPage) {
      // Drop furniture, but only where it sits at the page edge — a legitimate
      // mid-page heading that happens to match a running head is kept.
      const edges = new Set(pageEdgeTexts(blocks));
      const textBlocks = blocks.filter(
        (b) => !(edges.has(b.text) && furniture.has(normalizeFurniture(b.text))),
      );
      for (const { img, hash } of imgs) {
        if (repeated.has(hash)) continue;
        textBlocks.push({
          yTop: img.yTop,
          text: `![[__pdfimg_${images.length}__]]`,
          isImage: true,
        });
        images.push(img);
      }
      pages.push(joinBlocks(textBlocks, lineHeight));
    }
    body = cleanPdfText(pages.join("\n\n"));
    const meta = await getMeta(pdf).catch(() => null);
    info = (meta?.info ?? {}) as Record<string, unknown>;
  } catch {
    throw new Error(
      "Could not read this PDF — it may be corrupt, encrypted, or image-only.",
    );
  }

  // Make truncation visible rather than silently dropping the document's tail.
  if (truncated && processedPages < totalPages) {
    body +=
      `\n\n---\n\n*Note: this PDF has ${totalPages} pages; the importer processed ` +
      `the first ${processedPages} and omitted the rest (long documents are capped).*`;
  }

  const articleMeta = derivePdfMeta(info, body, sourceUrl);

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
    images,
  };
}

/**
 * Words present in a hosted parser's output but absent from the PDF's own
 * text layer. Model-based OCR can silently SUBSTITUTE words even in
 * born-digital PDFs (observed: "satisfice" → "satiate" — a load-bearing
 * technical term). The text layer is ground truth for such PDFs, so a small
 * set of provider-only words is a strong corruption signal. Image-caption
 * lines the provider *adds* (its own figure descriptions) are excluded.
 */
export function ocrSuspectWords(providerBody: string, layerText: string): string[] {
  // Drop figure embeds + the caption line the provider writes right after.
  const lines = providerBody.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^!\[\[/.test(lines[i].trim())) {
      while (i + 1 < lines.length && lines[i + 1].trim() === "") i += 1;
      i += 1; // skip the caption line too
      continue;
    }
    kept.push(lines[i]);
  }
  // Unicode letters, not just [a-z] — otherwise the cross-check is silently
  // blind on non-English PDFs (accented/CJK substitutions returned []).
  const words = (s: string) => new Set(s.toLowerCase().match(/\p{L}{5,}/gu) || []);
  // De-hyphenate the text layer's end-of-line word wraps ("inter-\npretable")
  // — providers re-join them, and every wrapped word would otherwise be a
  // false "substitution".
  const layer = words(layerText.replace(/-\s*\n\s*/g, ""));
  return [...words(kept.join("\n"))].filter((w) => !layer.has(w));
}

/**
 * Prefer the hosted PDF parser (Datalab/Mistral — real Markdown structure,
 * scanned-PDF OCR, in-flow figures) when one is configured; fall back to the
 * local unpdf extraction on provider errors or when no API key is set, so a
 * provider outage degrades quality instead of failing the import. Metadata
 * (title/author/date) always derives from the PDF itself + the parsed body,
 * identically on both paths.
 */
export async function extractPdfSmart(
  bytes: ArrayBuffer,
  sourceUrl: string,
  signal?: AbortSignal,
): Promise<ExtractResult> {
  const provider = configuredPdfProvider();
  if (provider) {
    try {
      const parsed = await parsePdfWithProvider(bytes, signal);
      // Info-dict metadata still comes from the PDF itself. Parse a COPY —
      // pdf.js detaches the buffer it is handed, and the local fallback (or a
      // retry) must be able to reuse `bytes`. The same parse yields the text
      // layer used for the OCR-corruption cross-check below.
      let info: Record<string, unknown> = {};
      let layerText = "";
      try {
        const pdf = await getDocumentProxy(new Uint8Array(bytes.slice(0)));
        const meta = await getMeta(pdf).catch(() => null);
        info = (meta?.info ?? {}) as Record<string, unknown>;
        const layer = await extractText(pdf, { mergePages: true }).catch(() => null);
        layerText = typeof layer?.text === "string" ? layer.text : "";
      } catch {
        /* unreadable metadata is fine — the body is already parsed */
      }
      const articleMeta = derivePdfMeta(info, parsed.body, sourceUrl);
      const assessment = assessExtraction({
        chosenBody: parsed.body,
        html: "",
        meta: articleMeta,
        siteName: "",
      });
      // Born-digital PDF (substantial text layer): cross-check the provider's
      // words against it. A handful of provider-only words = likely OCR
      // substitutions → surface loudly. A flood means figure transcriptions /
      // scanned pages, where the check has no signal — stay quiet.
      if (layerText.length > 4000) {
        const suspects = ocrSuspectWords(parsed.body, layerText);
        if (suspects.length > 0 && suspects.length <= 25) {
          console.warn(
            `[add-article] OCR cross-check: ${suspects.length} word(s) in the parsed body ` +
              `are absent from the PDF text layer (possible substitutions): ${suspects
                .slice(0, 10)
                .join(", ")}`,
          );
          assessment.flags.push("ocr-suspect");
        }
      }
      return {
        body: parsed.body,
        meta: articleMeta,
        siteName: "",
        via: `pdf-${parsed.provider}`,
        linkedOut: false,
        assessment,
        images: parsed.images,
      };
    } catch (err) {
      if (signal?.aborted) throw err; // job cancelled/timed out — stop here
      console.warn(
        `[add-article] PDF provider "${provider}" failed — falling back to local extraction: ${err}`,
      );
    }
  }
  return extractPdf(bytes, sourceUrl);
}

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/png": "png",
};

/**
 * Replace the `![[__pdfimg_N__]]` placeholders in a PDF-extracted body with real
 * attachment embeds, uploading each image first. Images that fail to upload are
 * dropped (the surrounding text stays). Returns the rewritten body.
 */
export async function embedPdfImages(
  body: string,
  images: PdfPageImage[],
  slugBase: string,
  upload: (inFolderPath: string, png: Buffer, mimetype: string) => Promise<void>,
): Promise<string> {
  let out = body;
  for (let i = 0; i < images.length; i += 1) {
    const placeholder = `![[__pdfimg_${i}__]]`;
    if (!out.includes(placeholder)) continue;
    const mime = images[i].mime || "image/png";
    const ext = MIME_EXT[mime] || "png";
    // Content-hash suffix: the slug base alone is computed BEFORE filename
    // collision resolution, so two DISTINCT articles sharing a base (every
    // Atlas chapter's "Introduction") would collide on `<base>-fig1` — and the
    // relay's create-only attachment endpoint treats the conflict as success,
    // silently embedding the FIRST article's figure in the second. Hashing the
    // bytes makes cross-article aliasing impossible (identical bytes deduping
    // onto one blob is correct).
    const h8 = createHash("sha1").update(images[i].png).digest("hex").slice(0, 8);
    const inFolderPath = `/attachments/${slugBase}-fig${i + 1}-${h8}.${ext}`;
    try {
      await upload(inFolderPath, images[i].png, mime);
      out = out.split(placeholder).join(`![[${inFolderPath}]]`);
    } catch {
      out = out.split(placeholder).join(""); // drop the figure, keep the text
    }
  }
  // Strip any unreplaced placeholders and tidy resulting blank-line runs.
  return out
    .replace(/!\[\[__pdfimg_\d+__\]\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
