import type { ArticleMeta } from "./types";

/**
 * Deterministic extraction-quality assessment — decides, WITHOUT an LLM, whether
 * an extraction is trustworthy or should be routed to the Claude QC step. Uses
 * classic content-extraction signals (cross-extractor consensus, link density,
 * coverage, truncation, structure) — all language-agnostic and char-based so
 * they work on non-English articles too.
 */

export interface ExtractionSignals {
  consensus: number | null; // agreement between Defuddle & Readability (0-1), null if single candidate
  lengthRatio: number | null;
  overlap: number | null; // char-4gram Jaccard
  linkDensity: number; // anchor-text chars / total chars (high = boilerplate)
  coverage: number; // body chars / full-page visible-text chars
  paragraphs: number;
  endsClean: boolean;
  teaser: boolean;
  chars: number;
}

export interface Assessment {
  confidence: number; // 0-1 (body quality)
  signals: ExtractionSignals;
  flags: string[]; // body flags: truncation, link-heavy, low-consensus, thin; meta flags: no-author, publisher-author, no-date
}

const TEASER_RE =
  /(subscribe to (keep|continue) reading|keep reading with a|read the (full|rest)|this post is for paid|become a (paid )?subscriber|sign up to (keep )?read|to keep reading this post)/i;
const TERMINAL = /[.!?…"'”’)\]》」。！？]$/;
const clamp = (x: number) => Math.max(0, Math.min(1, x));

function char4grams(s: string): Set<string> {
  const t = s.toLowerCase().replace(/\s+/g, " ").trim();
  const set = new Set<string>();
  for (let i = 0; i + 4 <= t.length; i += 1) set.add(t.slice(i, i + 4));
  return set;
}

/** Char-4gram Jaccard similarity — language-agnostic text overlap. */
function jaccard(a: string, b: string): number {
  const A = char4grams(a);
  const B = char4grams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  const [small, big] = A.size < B.size ? [A, B] : [B, A];
  for (const g of small) if (big.has(g)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/** Fraction of body chars that are inside markdown link text (excludes images). */
function linkDensity(md: string): number {
  let linkChars = 0;
  for (const m of md.matchAll(/(?<!!)\[([^\]]*)\]\([^)]*\)/g)) linkChars += m[1].length;
  const textChars = md.replace(/\s+/g, "").length || 1;
  return Math.min(1, linkChars / textChars);
}

function visibleTextLength(html: string): number {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}

function isPublisherish(author: string, siteName: string, url: string): boolean {
  const a = author.toLowerCase().replace(/\s+/g, "");
  if (!a) return false;
  if (siteName && a === siteName.toLowerCase().replace(/\s+/g, "")) return true;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const parts = host.split(".");
    const label = (parts.length >= 2 ? parts[parts.length - 2] : parts[0]) || "";
    return !!label && a === label.toLowerCase();
  } catch {
    return false;
  }
}

export function assessExtraction(args: {
  chosenBody: string;
  defuddleBody?: string;
  readabilityBody?: string;
  html: string;
  meta: ArticleMeta;
  siteName: string;
}): Assessment {
  const { chosenBody, defuddleBody, readabilityBody, html, meta, siteName } = args;
  const chars = chosenBody.length;

  let consensus: number | null = null;
  let lengthRatio: number | null = null;
  let overlap: number | null = null;
  if (defuddleBody && readabilityBody && defuddleBody.length && readabilityBody.length) {
    lengthRatio =
      Math.min(defuddleBody.length, readabilityBody.length) /
      Math.max(defuddleBody.length, readabilityBody.length);
    overlap = jaccard(defuddleBody, readabilityBody);
    consensus = 0.5 * lengthRatio + 0.5 * overlap;
  }

  const ld = linkDensity(chosenBody);
  const vis = visibleTextLength(html);
  const coverage = vis > 0 ? Math.min(1, chars / vis) : 0;
  const paragraphs = chosenBody.split(/\n{2,}/).filter((p) => p.trim().length > 0).length;
  const trimmed = chosenBody.trim();
  const endsClean = TERMINAL.test(trimmed);
  const teaser = TEASER_RE.test(chosenBody);

  // per-signal goodness (0-1)
  const gLink = clamp(1 - ld / 0.4);
  const gCov = coverage < 0.05 ? coverage / 0.05 : coverage > 0.95 ? 0.7 : 1;
  const gTrunc = teaser ? 0 : endsClean ? 1 : 0.4;
  const gProse = clamp(paragraphs / 4);
  const gThin = clamp(chars / 800);

  const W = { consensus: 0.4, link: 0.18, cov: 0.12, trunc: 0.15, prose: 0.08, thin: 0.07 };
  const bodyTerms = W.link * gLink + W.cov * gCov + W.trunc * gTrunc + W.prose * gProse + W.thin * gThin;
  let confidence: number;
  if (consensus != null) {
    confidence = W.consensus * consensus + bodyTerms;
  } else {
    const restWeight = W.link + W.cov + W.trunc + W.prose + W.thin;
    confidence = bodyTerms / restWeight; // redistribute consensus weight
  }
  confidence = clamp(confidence);

  const flags: string[] = [];
  if (teaser || !endsClean) flags.push("truncation");
  if (ld > 0.45) flags.push("link-heavy");
  if (consensus != null && consensus < 0.55) flags.push("low-consensus");
  if (chars < 800) flags.push("thin");
  if (meta.author.length === 0) flags.push("no-author");
  else if (
    meta.author.length === 1 &&
    isPublisherish(meta.author[0], siteName, meta.source_url)
  )
    flags.push("publisher-author");
  if (!meta.published) flags.push("no-date");

  return {
    confidence,
    signals: { consensus, lengthRatio, overlap, linkDensity: ld, coverage, paragraphs, endsClean, teaser, chars },
    flags,
  };
}
