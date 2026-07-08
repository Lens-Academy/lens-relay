import * as path from "node:path";
import type { ArticleJob, ArticleMeta } from "./types";
import {
  fetchFirstHtml,
  fetchRawHtml,
  fetchRenderedHtml,
  fetchRawBytes,
  looksLikePdf,
} from "./fetch";
import { extractArticle } from "./extract";
import { extractPdfSmart, embedPdfImages } from "./pdf";
import { adapterContext, resolveFetchUrls } from "./adapters";
import { dedupUrlVariants } from "./url-normalize";
import { normalizeMetaWithLlm } from "./meta-normalize";
import { hostRemoteImages, ARXIV_IMAGE_HOSTS } from "./image-hosting";
import { verifyAndRefine } from "./claude";
import {
  generateArticleMarkdown,
  generateArticleFilenameBase,
  articleFilenameCandidates,
} from "./export";
import {
  createRelayDoc,
  checkRelayDocsExist,
  checkRelayArticleUrls,
  createRelayAttachment,
} from "../add-video/relay-docs";
import { maybeCreateLens } from "../lens-doc";

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

// Serializes the resolve-filename → write step across concurrently-running jobs
// (the queue fires jobs in parallel). Without it, two distinct pages that share
// a filename base could both see the same candidate free and overwrite each
// other (the relay upsert replaces on conflict). Process-local; cross-process
// safety would need a relay create-only upsert (deferred to the relay PR).
let articleWriteChain: Promise<unknown> = Promise.resolve();
function withArticleWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = articleWriteChain.then(fn, fn);
  articleWriteChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
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
export async function processArticle(
  job: ArticleJob,
  signal?: AbortSignal,
): Promise<void> {
  console.log(`[add-article] Processing ${job.url}`);
  const createdDate = new Date().toISOString().slice(0, 10);
  const setStage = (stage: string) => {
    // A cancelled/deadlined job must actually STOP — Promise.race in the queue
    // settles the job status but cannot kill this pipeline, so every stage
    // boundary re-checks the signal. Without this, a "cancelled" job kept
    // running and wrote its article minutes later (ghost writes; duplicates
    // after a retry).
    signal?.throwIfAborted();
    job.stage = stage;
    job.updated_at = new Date().toISOString();
  };

  // 1. Fetch raw HTML (SSRF-guarded) and extract deterministically. An adapter
  //    may redirect the fetch to a better source (e.g. arXiv abstract → ar5iv
  //    full text, LessWrong → the GreaterWrong mirror when LW rate-limits us);
  //    the cited source_url stays canonical.
  setStage("fetching");
  let ex: Awaited<ReturnType<typeof extractArticle>> | null = null;
  let rawErr: unknown = null;
  let detectedPdf = false;
  try {
    const candidates = resolveFetchUrls(adapterContext(job.url, ""));
    if (candidates.length === 1) {
      // Single candidate (no multi-source adapter): fetch bytes once so we can
      // detect a PDF; non-PDF bytes decode to HTML with no second fetch.
      const { bytes, contentType, finalUrl } = await fetchRawBytes(
        candidates[0],
        signal,
      );
      if (looksLikePdf(contentType, bytes)) {
        detectedPdf = true;
        setStage("parsing-pdf");
        ex = await extractPdfSmart(bytes, job.url, signal);
      } else {
        const html = new TextDecoder("utf-8").decode(bytes);
        ex = await extractArticle(html, finalUrl, {
          sourceUrl: job.url,
          fetchText: (u) => fetchRawHtml(u, signal),
        });
      }
    } else {
      // Multiple HTML candidates (e.g. arXiv html → ar5iv) — never PDFs.
      const { html, url: fetchedFrom } = await fetchFirstHtml(candidates, signal);
      ex = await extractArticle(html, fetchedFrom, {
        sourceUrl: job.url,
        fetchText: (u) => fetchRawHtml(u, signal),
      });
    }
  } catch (err) {
    rawErr = err;
    if (signal?.aborted) throw err; // cancelled/timed out — no render fallback
    console.warn(`[add-article] Raw fetch/extract failed: ${err}`);
  }

  // 2. Escalate to RENDERED HTML (Jina browser engine) when the raw result is a
  //    JS-only skeleton or the raw fetch was blocked — Jina renders from its own
  //    network, so it also clears some bot-blocks. Skipped for link-outs (a
  //    short body that points elsewhere won't grow when rendered). Keep whichever
  //    extraction captured more.
  // Skip the render tier for PDFs — Jina would just re-fetch the binary.
  const needsRender =
    !detectedPdf &&
    (!ex || (!ex.linkedOut && ex.body.length < RENDER_ESCALATE_CHARS));
  if (needsRender) {
    setStage("rendering");
    try {
      const rendered = await fetchRenderedHtml(job.url, signal);
      // Same opts as the raw path: without fetchText, an arXiv page arriving
      // via the render tier silently skips the abs-page metadata enrichment,
      // and an Atlas .md fetch would ignore the job's cancel signal.
      const exRendered = await extractArticle(rendered, job.url, {
        sourceUrl: job.url,
        fetchText: (u) => fetchRawHtml(u, signal),
      });
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
  const authorIsFallback = ex.meta.author.length === 0;
  const dateIsFallback = !ex.meta.published;
  let meta = ensureRequiredMeta(ex.meta, ex.siteName, createdDate);
  let body = ex.body;

  // 3.2. ALWAYS-ON metadata normalizer — one cheap tool-less LLM read of the
  //      body's first/last chunks. Fixes what the deterministic readers can't
  //      see (dates printed only in the text, publisher-as-author on PDFs)
  //      uniformly on every import, under strict anti-fabrication merge rules.
  //      No-op on any failure (e.g. no claude CLI in local dev).
  {
    setStage("metadata");
    meta = await normalizeMetaWithLlm({
      meta,
      siteName: ex.siteName,
      createdDate,
      authorIsFallback,
      dateIsFallback,
      dateFromPdfInfo: ex.via.startsWith("pdf"),
      bodyStart: body.slice(0, 5000),
      bodyEnd: body.slice(-1500),
    });
  }

  // 3.5. Claude Sonnet QC pass — SELECTIVE. Calibration showed a source-blind
  //      confidence score can't reliably triage quality, but a few specific
  //      flags ARE precise (thin/low-consensus = likely-broken body;
  //      no-author/publisher-author = metadata to repair). We invoke Claude only
  //      on flagged extractions; clean ones pass deterministically (instant).
  //      The pass verifies + repairs metadata + gates paywalls/blocks +
  //      falls back on formatting; it degrades gracefully if the CLI is absent.
  const needsVerify = ex.assessment.flags.some((f) => ROUTE_FLAGS.has(f));
  if (process.env.ARTICLE_SKIP_VERIFY !== "1" && needsVerify) {
    setStage("quality-check");
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

  // 4. Duplicate detection by SOURCE URL. The real duplicate signal is the
  //    source_url, not the filename (which is author+title and collides across
  //    distinct pages). Check every spelling of this article's identity — the
  //    submitted URL, the page's canonical URL, and their normalized forms
  //    (tracking params / trailing slash / mirror host stripped) — so the same
  //    article via a mirror or a utm-tagged link is refused too. Degrades
  //    gracefully: if the relay check errors, fall through to the filename
  //    guard below rather than blocking the import.
  setStage("checking-duplicates");
  const filenameBase = generateArticleFilenameBase(meta.author, meta.title);
  if (!filenameBase) {
    throw new Error(`Could not derive filename from title: ${meta.title}`);
  }
  const folder = relayArticleFolder();
  let existingByUrl: string | null = null;
  try {
    const variants = dedupUrlVariants(job.url, meta.source_url);
    const found = await checkRelayArticleUrls(variants, signal);
    existingByUrl = variants.map((v) => found[v]).find(Boolean) ?? null;
  } catch (err) {
    console.warn(`[add-article] source_url dedup check failed, proceeding: ${err}`);
  }
  if (existingByUrl) {
    throw new Error(
      `This URL was already imported: ${folder.split("/")[0]}${existingByUrl}`,
    );
  }

  // 4.5. Host + embed any PDF figure images: upload each to the folder's
  //      /attachments/ and replace its placeholder with the embed. Images that
  //      fail to upload are dropped (the text stays); never fails the import.
  const topFolder = folder.split("/")[0];
  if (ex.images?.length) {
    setStage("uploading-images");
    body = await embedPdfImages(body, ex.images, filenameBase, (p, png, mime) =>
      createRelayAttachment(topFolder, p, png, mime, signal),
    );
  }

  // 4.6. Rehost arXiv/ar5iv figure hotlinks as attachments — mirror-hosted
  //      asset URLs rot, and the library should be self-contained. Failures
  //      keep the external URL (an upgrade, never a gate).
  if (ex.via === "arxiv") {
    setStage("uploading-images");
    body = await hostRemoteImages(body, filenameBase, {
      hostPattern: ARXIV_IMAGE_HOSTS,
      fetchImage: async (u) => {
        const r = await fetchRawBytes(u, signal);
        return { bytes: r.bytes, contentType: r.contentType };
      },
      upload: (p, data, mime) =>
        createRelayAttachment(topFolder, p, data, mime, signal),
    });
  }

  // 5. Resolve a unique filename — disambiguating DISTINCT pages that share a
  //    base name (e.g. each Atlas chapter's "Introduction") — and write it,
  //    serialized so two concurrent imports can't pick the same name and
  //    overwrite each other.
  setStage("writing");
  const candidatePaths = articleFilenameCandidates(
    filenameBase,
    meta.source_url || job.url,
  ).map((b) => `${folder}/${b}.md`);
  const finalMd = generateArticleMarkdown(meta, body, createdDate);
  const mdPath = await withArticleWriteLock(async () => {
    // Last line of defense against post-abort ghost writes: the job may have
    // been cancelled while queued behind this lock.
    signal?.throwIfAborted();
    const existing = await checkRelayDocsExist(candidatePaths, signal);
    const chosen = candidatePaths.find((p) => !existing[p]);
    if (!chosen) {
      throw new Error(`Document already exists: ${candidatePaths[0]}`);
    }
    await createRelayDoc(chosen, finalMd, signal);
    return chosen;
  });
  const editorBase =
    process.env.EDITOR_BASE_URL || "https://editor.lensacademy.org";
  job.relay_url = `${editorBase}/open/${encodeURI(mdPath)}`;
  job.updated_at = new Date().toISOString();
  console.log(
    `[add-article] Wrote ${mdPath} (via ${ex.via}, ${body.length} chars)`,
  );

  // 6. Auto-create a lens wrapping the article so it can be dropped straight
  //    into a module (Asana 1215689584721257). Opt out with createLens=false.
  //    A lens failure must not fail the import — the article is already saved.
  if (job.createLens !== false) {
    setStage("creating-lens");
    try {
      const lensPath = await maybeCreateLens({
        docPath: mdPath,
        title: meta.title,
        segment: "Article",
      });
      console.log(
        lensPath
          ? `[add-article] Created lens ${lensPath}`
          : `[add-article] Lens already exists for ${mdPath}, skipped`,
      );
    } catch (err) {
      console.warn(`[add-article] Lens creation failed (article saved): ${err}`);
    }
  }
}
