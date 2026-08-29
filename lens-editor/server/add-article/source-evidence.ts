import * as fs from "node:fs/promises";
import * as path from "node:path";
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

const REVIEW_HTML_MAX_LINE_CHARS = 8_000;

export interface SourceEvidenceManifest {
  source_url: string;
  fetched_url: string;
  fetched_at: string;
  source_kind: "live" | "archive" | "fixture";
  media_type: "html" | "pdf";
  extraction_via: string;
  candidate_chars: number;
}

export interface SourceEvidence {
  extraction: ExtractResult;
  htmlCandidates?: {
    rendered?: ExtractResult;
    unrendered?: ExtractResult;
  };
  manifest: SourceEvidenceManifest;
  rawHtml?: string;
  renderedHtml?: string;
  nativeMarkdown?: string;
  pdf?: Buffer;
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

export async function buildSourceEvidence(
  sourceUrl: string,
  signal?: AbortSignal,
): Promise<SourceEvidence> {
  let extraction: ExtractResult | null = null;
  let rawError: unknown;
  let unrenderedError: unknown;
  let renderedError: unknown;
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
      }
    } else {
      const result = await fetchFirstHtml(candidates, signal);
      rawHtml = result.html;
      fetchedUrl = result.url;
    }
  } catch (error) {
    rawError = error;
    if (signal?.aborted) throw error;
  }

  const htmlCandidates: NonNullable<SourceEvidence["htmlCandidates"]> = {};

  // Preserve both interpretations. The reviewer chooses the editing base after
  // seeing both Markdown candidates; neither fetch path is globally superior.
  if (mediaType !== "pdf") {
    if (rawHtml !== undefined) {
      try {
        htmlCandidates.unrendered = await extractArticle(rawHtml, fetchedUrl, {
          sourceUrl,
          fetchText: fetchAuxiliaryText,
        });
      } catch (error) {
        unrenderedError = error;
        if (signal?.aborted) throw error;
      }
    }
    try {
      renderedHtml = await fetchRenderedHtml(rawHtml !== undefined ? fetchedUrl : sourceUrl, signal);
      htmlCandidates.rendered = await extractArticle(renderedHtml, fetchedUrl, {
        sourceUrl,
        fetchText: fetchAuxiliaryText,
      });
    } catch (error) {
      renderedError = error;
      if (signal?.aborted) throw error;
    }
    extraction = htmlCandidates.rendered ?? htmlCandidates.unrendered ?? null;
    if (!extraction) {
      throw new Error(
        `Could not extract article (direct fetch: ${rawError ?? "ok"}; ` +
        `direct extraction: ${unrenderedError ?? "unavailable"}; Jina: ${renderedError ?? "unavailable"})`,
      );
    }
  }
  if (!extraction) throw rawError instanceof Error ? rawError : new Error("Extraction failed");

  return {
    extraction,
    htmlCandidates: mediaType === "html" ? htmlCandidates : undefined,
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
      candidate_chars: extraction.body.length,
    },
  };
}

export async function writeSourceEvidence(workDir: string, evidence: SourceEvidence): Promise<void> {
  const dir = path.join(workDir, "evidence");
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(evidence.manifest, null, 2)),
    evidence.rawHtml ? fs.writeFile(path.join(dir, "source-unrendered.html"), formatHtmlForReview(evidence.rawHtml)) : Promise.resolve(),
    evidence.renderedHtml ? fs.writeFile(path.join(dir, "source-rendered.html"), formatHtmlForReview(evidence.renderedHtml)) : Promise.resolve(),
    evidence.nativeMarkdown ? fs.writeFile(path.join(dir, "source-native.md"), evidence.nativeMarkdown) : Promise.resolve(),
    evidence.pdf ? fs.writeFile(path.join(dir, "source.pdf"), evidence.pdf) : Promise.resolve(),
  ]);
  const evidenceFiles = await fs.readdir(dir);
  await Promise.all(evidenceFiles.map((file) => fs.chmod(path.join(dir, file), 0o400)));
}
