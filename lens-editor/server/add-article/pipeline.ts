import * as path from "node:path";
import type { ArticleJob, ArticleMeta } from "./types";
import { fetchFirstHtml, fetchRenderedHtml } from "./fetch";
import { extractArticle } from "./extract";
import { adapterContext, resolveFetchUrls } from "./adapters";
import { verifyAndRefine } from "./claude";
import {
  generateArticleMarkdown,
  generateArticleFilenameBase,
} from "./export";
import { createRelayDoc, checkRelayDocsExist } from "../add-video/relay-docs";

const WORK_BASE = "/tmp/articles";
// Below this the extraction almost certainly failed (empty/wrong container)
// rather than producing a real article body.
const MIN_ARTICLE_CHARS = 200;
// Below this, the raw fetch is likely a JS-only skeleton — try the render tier.
const RENDER_ESCALATE_CHARS = 1000;
// Assessment flags that route an extraction to the Claude QC pass. Calibrated
// against the 120-article verdicts: these are the precise signals (thin &
// low-consensus predict broken bodies; no-author/publisher-author flag metadata
// to repair). `no-date` is intentionally excluded — it's rarely fixable (the
// date usually isn't on the page) and would route many articles for no gain.
// `truncation` is also excluded: paywall teasers are short and already caught by
// `thin`, while a non-terminal ending alone is too noisy to route on.
const ROUTE_FLAGS = new Set([
  "thin",
  "low-consensus",
  "link-heavy",
  "no-author",
  "publisher-author",
]);

function relayArticleFolder(): string {
  return process.env.RELAY_ARTICLE_FOLDER || "Lens Edu/articles";
}

/**
 * Readable publisher from a URL host, e.g. "https://bluedot.org/x" → "Bluedot".
 * Uses the registrable label (the part before the public suffix) rather than the
 * left-most subdomain, so "plato.stanford.edu" → "Stanford", not "Plato".
 */
export function publisherFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const parts = host.split(".").filter(Boolean);
    if (parts.length === 0) return host;
    // second-to-last label is usually the site name; skip short ccTLD-ish labels
    // (co/com/org/gov/ac/etc.) so "bbc.co.uk" → "Bbc".
    let label = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    if (parts.length >= 3 && label.length <= 3) label = parts[parts.length - 3];
    return label ? label.charAt(0).toUpperCase() + label.slice(1) : host;
  } catch {
    return "";
  }
}

/**
 * The Lens Edu content schema requires non-empty title, author, source_url, and
 * published. Pages without a person byline or a publish date would otherwise
 * write empty fields that fail content validation. Fill them with real
 * fallbacks (never fabricated): the publication/site name for author, and the
 * import date as a last resort for published (a real timestamp the curator can
 * correct).
 */
export function ensureRequiredMeta(
  meta: ArticleMeta,
  siteName: string,
  createdDate: string,
): ArticleMeta {
  const author =
    meta.author.length > 0
      ? meta.author
      : [siteName.trim() || publisherFromUrl(meta.source_url)].filter(Boolean);
  return { ...meta, author, published: meta.published || createdDate };
}

/**
 * Import an article deterministically: fetch raw HTML, isolate the article and
 * convert HTML→Markdown with a fixed converter (no LLM in the body path), then
 * write the finished document straight to the relay. Because extraction is
 * effectively instant there is no placeholder doc — and therefore no
 * placeholder→final churn in git-sync. On any failure nothing is written and
 * the job is marked failed by the queue.
 */
export async function processArticle(job: ArticleJob): Promise<void> {
  console.log(`[add-article] Processing ${job.url}`);
  const createdDate = new Date().toISOString().slice(0, 10);

  // 1. Fetch raw HTML (SSRF-guarded) and extract deterministically. An adapter
  //    may redirect the fetch to a better source (e.g. arXiv abstract → ar5iv
  //    full text); we still cite the original URL as source_url.
  let ex: Awaited<ReturnType<typeof extractArticle>> | null = null;
  let rawErr: unknown = null;
  try {
    const candidates = resolveFetchUrls(adapterContext(job.url, ""));
    const { html, url: fetchedFrom } = await fetchFirstHtml(candidates);
    ex = await extractArticle(html, fetchedFrom, { sourceUrl: job.url });
  } catch (err) {
    rawErr = err;
    console.warn(`[add-article] Raw fetch/extract failed: ${err}`);
  }

  // 2. Escalate to RENDERED HTML (Jina browser engine) when the raw result is a
  //    JS-only skeleton or the raw fetch was blocked — Jina renders from its own
  //    network, so it also clears some bot-blocks. Skipped for link-outs (a
  //    short body that points elsewhere won't grow when rendered). Keep whichever
  //    extraction captured more.
  const needsRender =
    !ex || (!ex.linkedOut && ex.body.length < RENDER_ESCALATE_CHARS);
  if (needsRender) {
    try {
      const rendered = await fetchRenderedHtml(job.url);
      const exRendered = await extractArticle(rendered, job.url);
      if (!ex || exRendered.body.length > ex.body.length) {
        console.log(
          `[add-article] Used rendered HTML (${exRendered.body.length} chars vs raw ${ex?.body.length ?? 0})`,
        );
        ex = exRendered;
      }
    } catch (err) {
      if (!ex) {
        throw new Error(
          `Could not fetch article (raw: ${rawErr}; render: ${err})`,
        );
      }
      console.warn(`[add-article] Render fallback failed, keeping raw: ${err}`);
    }
  }

  if (!ex) {
    throw rawErr instanceof Error ? rawErr : new Error("Extraction failed");
  }

  // 3. Validate.
  if (!ex.meta.title) {
    throw new Error("Could not determine article title from page");
  }
  if (ex.linkedOut) {
    throw new Error(
      "This post is a link-out announcement (the article lives in an external Google Doc/arXiv/PDF). Import the linked source directly instead.",
    );
  }
  if (ex.body.length < MIN_ARTICLE_CHARS) {
    throw new Error(
      `Extracted article suspiciously short (${ex.body.length} chars) — aborting`,
    );
  }
  let meta = ensureRequiredMeta(ex.meta, ex.siteName, createdDate);
  let body = ex.body;

  // 3.5. Claude Sonnet QC pass — SELECTIVE. Calibration showed a source-blind
  //      confidence score can't reliably triage quality, but a few specific
  //      flags ARE precise (thin/low-consensus = likely-broken body;
  //      no-author/publisher-author = metadata to repair). We invoke Claude only
  //      on flagged extractions; clean ones pass deterministically (instant).
  //      The pass verifies + repairs metadata + gates paywalls/blocks +
  //      falls back on formatting; it degrades gracefully if the CLI is absent.
  const needsVerify = ex.assessment.flags.some((f) => ROUTE_FLAGS.has(f));
  if (process.env.ARTICLE_SKIP_VERIFY !== "1" && needsVerify) {
    const articleMd = generateArticleMarkdown(meta, body, createdDate);
    const outcome = await verifyAndRefine(
      path.join(WORK_BASE, job.id),
      articleMd,
      meta,
      body,
    );
    if (outcome.verdict) {
      const s = outcome.verdict.status;
      if (s === "paywalled") {
        throw new Error(
          "Content is paywalled — only a public preview is available, not the full article.",
        );
      }
      if (s === "blocked") {
        throw new Error(
          "Page is not publicly accessible (bot-verification / access denied).",
        );
      }
      if (s === "not_article") {
        throw new Error("URL does not point to a single article.");
      }
      if (s === "truncated") {
        throw new Error(
          "Article appears incomplete (truncated or paywalled) — the full text is not publicly available.",
        );
      }
      meta = outcome.meta;
      body = outcome.body;
    }
  }
  job.title = meta.title;

  // 4. Resolve relay path; refuse to overwrite an existing article.
  const filenameBase = generateArticleFilenameBase(meta.author, meta.title);
  if (!filenameBase) {
    throw new Error(`Could not derive filename from title: ${meta.title}`);
  }
  const mdPath = `${relayArticleFolder()}/${filenameBase}.md`;
  const editorBase =
    process.env.EDITOR_BASE_URL || "https://editor.lensacademy.org";
  job.relay_url = `${editorBase}/open/${encodeURI(mdPath)}`;
  job.updated_at = new Date().toISOString();

  const exists = await checkRelayDocsExist([mdPath]);
  if (exists[mdPath]) {
    throw new Error(`Document already exists: ${mdPath}`);
  }

  // 5. Write the final article directly.
  const finalMd = generateArticleMarkdown(meta, body, createdDate);
  await createRelayDoc(mdPath, finalMd);
  console.log(
    `[add-article] Wrote ${mdPath} (via ${ex.via}, ${body.length} chars)`,
  );
}
