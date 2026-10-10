import * as fs from "node:fs/promises";
import * as path from "node:path";
import { extractArticle, type ExtractResult } from "./extract";
import {
  BotWallError,
  fetchRawBytes,
  fetchRawHtml,
  fetchRenderedHtml,
  looksLikeBlockPage,
  looksLikeBotWall,
  looksLikePdf,
  MIN_ARTICLE_CHARS,
  visibleText,
} from "./fetch";
import {
  acceptsFetchedHtml,
  acceptsFetchedUrl,
  adapterContext,
  convertFetched,
  fetchAcceptFor,
  resolveFetchUrls,
} from "./adapters";
import { extractPdfSmart } from "./pdf";

const REVIEW_HTML_MAX_LINE_CHARS = 8_000;
/** `ExtractResult.via` of the fallbacks used when no adapter took the page. */
const GENERIC_EXTRACTORS = new Set(["defuddle", "readability"]);

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
  // Set when an adapter built the page from a structured source (an arXiv
  // e-print's LaTeX, a forum API answer): that page is the source itself, and
  // Jina rendering the API endpoint or archive would only add a broken twin.
  let structured = false;
  let structuredExtraction: ExtractResult | undefined;
  let fetchedUrl = sourceUrl;
  let mediaType: "html" | "pdf" = "html";
  const fetchContext = adapterContext(sourceUrl, "");
  const candidates = resolveFetchUrls(fetchContext);
  const fetchAuxiliaryText = async (url: string) => {
    const text = await fetchRawHtml(url, signal);
    if (/\.md(?:\?|$)/i.test(url) || /^\s*---\s*$/m.test(text.slice(0, 500))) {
      nativeMarkdown = text;
    }
    return text;
  };

  // Try the adapter's candidates in order (or just the source URL). A
  // candidate counts as failed when it errors, when it redirects to a page
  // the adapter vetoes (e.g. ar5iv falling back to the arXiv abstract), or
  // when it answers 200 with a bot wall (LessWrong does this to datacenter IPs,
  // and the GreaterWrong mirror is the next candidate).
  const botWalled: string[] = [];
  for (const candidate of candidates) {
    try {
      const accept = fetchAcceptFor(fetchContext, candidate);
      const result = accept
        ? await fetchRawBytes(candidate, signal, { accept })
        : await fetchRawBytes(candidate, signal);
      if (!acceptsFetchedUrl(fetchContext, result.finalUrl)) {
        rawError = new Error(`${candidate} redirected to ${result.finalUrl}`);
        continue;
      }
      const converted = await convertFetched(fetchContext, result, signal);
      fetchedUrl = result.finalUrl;
      if (converted) {
        if (visibleText(converted.html).length < MIN_ARTICLE_CHARS) {
          rawError = new Error(`${candidate} converted to an empty page`);
          continue;
        }
        // Extract here, not after the loop: a converted page that will not
        // extract must fail its candidate so the fallbacks still get a turn.
        const images = converted.images?.length ? converted.images : undefined;
        try {
          structuredExtraction = await extractArticle(converted.html, result.finalUrl, {
            sourceUrl,
            fetchText: fetchAuxiliaryText,
            sourceImages: images,
          });
        } catch (error) {
          if (signal?.aborted) throw error;
          rawError = error;
          continue;
        }
        // A conversion that kept almost nothing (a class pandoc cannot read
        // past the title block), so that the adapter declined it and a generic
        // extractor scraped the leftovers, is no better than a failed one.
        if (
          structuredExtraction.body.length < MIN_ARTICLE_CHARS ||
          GENERIC_EXTRACTORS.has(structuredExtraction.via)
        ) {
          structuredExtraction = undefined;
          rawError = new Error(`${candidate} converted to an empty article`);
          continue;
        }
        rawHtml = converted.html;
        structured = true;
      } else if (looksLikePdf(result.contentType, result.bytes)) {
        mediaType = "pdf";
        // Buffer.from(ArrayBuffer) is only a view. pdf.js takes ownership of and
        // detaches its input, which used to turn the retained evidence into an
        // empty source.pdf. Make two independent byte-for-byte copies: one is
        // immutable provenance, the other belongs to the extraction stack.
        pdf = Buffer.from(new Uint8Array(result.bytes));
        const extractionBytes = Uint8Array.from(pdf).buffer;
        extraction = await extractPdfSmart(extractionBytes, sourceUrl, signal);
      } else {
        const html = new TextDecoder("utf-8").decode(result.bytes);
        if (looksLikeBotWall(html)) {
          botWalled.push(candidate);
          rawError = new BotWallError([candidate]);
          continue;
        }
        if (!acceptsFetchedHtml(fetchContext, html)) {
          rawError = new Error(`${candidate} returned an incomplete page`);
          continue;
        }
        rawHtml = html;
      }
      rawError = undefined;
      break;
    } catch (error) {
      rawError = error;
      if (signal?.aborted) throw error;
    }
  }

  const htmlCandidates: NonNullable<SourceEvidence["htmlCandidates"]> = {};

  // Preserve both interpretations. The reviewer chooses the editing base after
  // seeing both Markdown candidates; neither fetch path is globally superior.
  if (mediaType !== "pdf") {
    if (structuredExtraction) {
      htmlCandidates.unrendered = structuredExtraction;
    } else if (rawHtml !== undefined) {
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
    if (!structured) {
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
    }
    extraction = htmlCandidates.rendered ?? htmlCandidates.unrendered ?? null;
    // Every direct fetch was walled and the renderer answered no better: say
    // so, rather than letting the wall pass as a "suspiciously short" article.
    // If the renderer itself failed (outage, timeout), the error below says so.
    if (
      rawHtml === undefined &&
      botWalled.length > 0 &&
      renderedHtml !== undefined &&
      (!extraction || extraction.body.length < MIN_ARTICLE_CHARS || looksLikeBlockPage(extraction.body))
    ) {
      throw new BotWallError(botWalled);
    }
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
