import * as fs from "node:fs/promises";
import * as path from "node:path";
import { JSDOM } from "jsdom";
import { extractArticle, type ExtractResult } from "./extract";
import {
  fetchFirstHtml,
  fetchRawBytes,
  fetchRawHtml,
  fetchRenderedHtml,
  looksLikePdf,
} from "./fetch";
import { adapterContext, resolveFetchUrls } from "./adapters";
import { extractPdfSmart } from "./pdf";
import { sourceReviewDigest } from "./review-digest";

const RENDER_ESCALATE_CHARS = 1000;
const REVIEW_HTML_MAX_LINE_CHARS = 8_000;

export interface SourceEvidenceManifest {
  source_url: string;
  fetched_url: string;
  fetched_at: string;
  source_kind: "live" | "archive" | "fixture";
  media_type: "html" | "pdf";
  extraction_via: string;
  source_digest: string;
  source_text_chars: number;
  candidate_chars: number;
  alignment: { candidate_token_coverage: number };
}

export interface SourceEvidence {
  extraction: ExtractResult;
  manifest: SourceEvidenceManifest;
  sourceText: string;
  rawHtml?: string;
  renderedHtml?: string;
  nativeMarkdown?: string;
  pdf?: Buffer;
}

export function conservativeHtmlText(html: string): string {
  const document = new JSDOM(html).window.document;
  for (const el of document.querySelectorAll("script,style,noscript,svg")) el.remove();
  return (document.body?.textContent ?? "")
    .replace(/\u00ad/g, "")
    .replace(/[\t \f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Claude's Read tool paginates by line and cannot inspect a minified HTML line
 * that exceeds its token limit. Keep the original bytes separately for
 * provenance, and give the reviewer a losslessly line-bounded derivative.
 */
export function formatHtmlForReview(html: string): string {
  const tagSeparated = html.replace(/></g, ">\n<");
  const lines: string[] = [];
  for (const sourceLine of tagSeparated.split("\n")) {
    if (!sourceLine.length) {
      lines.push("");
      continue;
    }
    for (let offset = 0; offset < sourceLine.length; offset += REVIEW_HTML_MAX_LINE_CHARS) {
      lines.push(sourceLine.slice(offset, offset + REVIEW_HTML_MAX_LINE_CHARS));
    }
  }
  return lines.join("\n");
}

function tokenCoverage(candidate: string, source: string): number {
  const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  const sourceWords = new Set(words(source));
  const candidateWords = words(candidate);
  if (!candidateWords.length) return 0;
  return candidateWords.filter((word) => sourceWords.has(word)).length / candidateWords.length;
}

export async function buildSourceEvidence(
  sourceUrl: string,
  signal?: AbortSignal,
): Promise<SourceEvidence> {
  let extraction: ExtractResult | null = null;
  let rawError: unknown;
  let rawHtml: string | undefined;
  let renderedHtml: string | undefined;
  let nativeMarkdown: string | undefined;
  let pdf: Buffer | undefined;
  let fetchedUrl = sourceUrl;
  let mediaType: "html" | "pdf" = "html";
  const candidates = resolveFetchUrls(adapterContext(sourceUrl, ""));
  const fetchAuxiliaryText = async (url: string) => {
    const text = await fetchRawHtml(url, signal);
    if (/\.md(?:\?|$)/i.test(url) || /^\s*---\s*$/m.test(text.slice(0, 500))) {
      nativeMarkdown = text;
    }
    return text;
  };

  try {
    if (candidates.length === 1) {
      const result = await fetchRawBytes(candidates[0], signal);
      fetchedUrl = result.finalUrl;
      if (looksLikePdf(result.contentType, result.bytes)) {
        mediaType = "pdf";
        // Buffer.from(ArrayBuffer) is only a view. pdf.js takes ownership of and
        // detaches its input, which used to turn the retained evidence into an
        // empty source.pdf. Make two independent byte-for-byte copies: one is
        // immutable provenance, the other belongs to the extraction stack.
        pdf = Buffer.from(new Uint8Array(result.bytes));
        const extractionBytes = Uint8Array.from(pdf).buffer;
        extraction = await extractPdfSmart(extractionBytes, sourceUrl, signal);
      } else {
        rawHtml = new TextDecoder("utf-8").decode(result.bytes);
        extraction = await extractArticle(rawHtml, fetchedUrl, {
          sourceUrl,
          fetchText: fetchAuxiliaryText,
        });
      }
    } else {
      const result = await fetchFirstHtml(candidates, signal);
      rawHtml = result.html;
      fetchedUrl = result.url;
      extraction = await extractArticle(rawHtml, fetchedUrl, {
        sourceUrl,
        fetchText: fetchAuxiliaryText,
      });
    }
  } catch (error) {
    rawError = error;
    if (signal?.aborted) throw error;
  }

  if (mediaType !== "pdf" && (!extraction || (!extraction.linkedOut && extraction.body.length < RENDER_ESCALATE_CHARS))) {
    try {
      renderedHtml = await fetchRenderedHtml(sourceUrl, signal);
      const renderedExtraction = await extractArticle(renderedHtml, sourceUrl, {
        sourceUrl,
        fetchText: fetchAuxiliaryText,
      });
      if (!extraction || renderedExtraction.body.length > extraction.body.length) extraction = renderedExtraction;
    } catch (error) {
      if (!extraction) throw new Error(`Could not fetch article (raw: ${rawError}; render: ${error})`);
    }
  }
  if (!extraction) throw rawError instanceof Error ? rawError : new Error("Extraction failed");

  // For PDFs, provider/local extracted text is the only conservative textual
  // representation; the original binary remains available for visual checks.
  const sourceText = mediaType === "pdf"
    ? extraction.body
    : nativeMarkdown ?? conservativeHtmlText(renderedHtml ?? rawHtml ?? "");
  const sourceBytes = pdf ?? Buffer.from(nativeMarkdown ?? renderedHtml ?? rawHtml ?? sourceText);
  return {
    extraction,
    sourceText,
    rawHtml,
    renderedHtml,
    nativeMarkdown,
    pdf,
    manifest: {
      source_url: sourceUrl,
      fetched_url: fetchedUrl,
      fetched_at: new Date().toISOString(),
      source_kind: "live",
      media_type: mediaType,
      extraction_via: extraction.via,
      source_digest: sourceReviewDigest(sourceBytes),
      source_text_chars: sourceText.length,
      candidate_chars: extraction.body.length,
      alignment: { candidate_token_coverage: tokenCoverage(extraction.body, sourceText) },
    },
  };
}

export async function writeSourceEvidence(workDir: string, evidence: SourceEvidence): Promise<void> {
  const dir = path.join(workDir, "evidence");
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(evidence.manifest, null, 2)),
    fs.writeFile(path.join(dir, "source.txt"), evidence.sourceText),
    evidence.rawHtml ? fs.writeFile(path.join(dir, "source.html"), formatHtmlForReview(evidence.rawHtml)) : Promise.resolve(),
    evidence.rawHtml ? fs.writeFile(path.join(dir, "source-original.html"), evidence.rawHtml) : Promise.resolve(),
    evidence.renderedHtml ? fs.writeFile(path.join(dir, "source-rendered.html"), formatHtmlForReview(evidence.renderedHtml)) : Promise.resolve(),
    evidence.renderedHtml ? fs.writeFile(path.join(dir, "source-rendered-original.html"), evidence.renderedHtml) : Promise.resolve(),
    evidence.nativeMarkdown ? fs.writeFile(path.join(dir, "source-native.md"), evidence.nativeMarkdown) : Promise.resolve(),
    evidence.pdf ? fs.writeFile(path.join(dir, "source.pdf"), evidence.pdf) : Promise.resolve(),
  ]);
}
