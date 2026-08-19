import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { ArticleImportMode, ArticleJob, ArticleMeta } from "./types";
import { fetchRawBytes } from "./fetch";
import { embedPdfImages } from "./pdf";
import { dedupUrlVariants } from "./url-normalize";
import { hostRemoteImages, ARXIV_IMAGE_HOSTS } from "./image-hosting";
import {
  ArticleReviewRejectedError,
  REVIEW_MODEL,
  REVIEW_VERSION,
  reviewArticle,
  type ReviewOutcome,
} from "./claude";
import { buildSourceEvidence, writeSourceEvidence } from "./source-evidence";
import { normalizeArticleBody } from "./normalize-article";
import { assertArticleValid, validateArticleDraft } from "./platform-validation";
import { articleReviewDigest } from "./review-digest";
import {
  createMemoryArticleReviewReporter,
  type ArticleReviewReporter,
} from "./review-report";
import {
  generateArticleMarkdown,
  generateArticleStubMarkdown,
  generateArticleFilenameBase,
  articleFilenameCandidates,
} from "./export";
import { parsePromotableArticleStub } from "./stub";
import {
  createRelayDoc,
  checkRelayDocsExist,
  checkRelayArticleUrls,
  createRelayAttachment,
  checkRelayVideoIds,
  relayTranscriptFolder,
  editorOpenUrl,
} from "../add-video/relay-docs";
import type { VideoInput } from "../add-video/video-url";
import { fetchYouTubeTranscript } from "../add-video/fetch-transcript";
import { importVideo } from "../add-video/pipeline";
import { maybeCreateLens } from "../lens-doc";

const WORK_BASE = "/tmp/articles";
const EVIDENCE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
let lastEvidencePrune = 0;

async function pruneExpiredEvidence(): Promise<void> {
  if (Date.now() - lastEvidencePrune < 24 * 60 * 60 * 1000) return;
  lastEvidencePrune = Date.now();
  for (const entry of await fs.readdir(WORK_BASE, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const full = path.join(WORK_BASE, entry.name);
    const stat = await fs.stat(full).catch(() => null);
    if (stat && stat.mtimeMs < Date.now() - EVIDENCE_RETENTION_MS) {
      await fs.rm(full, { recursive: true }).catch(() => {});
    }
  }
}
// Below this the extraction almost certainly failed (empty/wrong container)
// rather than producing a real article body.
const MIN_ARTICLE_CHARS = 200;

function relayArticleFolder(): string {
  return process.env.RELAY_ARTICLE_FOLDER || "Lens Edu/articles";
}

interface ExistingArticleMatch {
  path: string;
  stubContent?: string;
}

interface ArticleImportBehavior {
  stubOnly: boolean;
  createLens: boolean;
}

export function articleImportBehavior(
  mode: ArticleImportMode,
): ArticleImportBehavior {
  switch (mode) {
    case "stub":
      return { stubOnly: true, createLens: false };
    case "article":
      return { stubOnly: false, createLens: false };
    case "article-and-lens":
      return { stubOnly: false, createLens: true };
    default: {
      const exhaustive: never = mode;
      throw new Error(`Unhandled article import mode: ${exhaustive}`);
    }
  }
}

/**
 * Import a YouTube video's transcript: mint + fetch the transcript
 * server-side, then reuse the add-video pipeline (Claude formatting,
 * timestamp alignment, relay write, optional lens). importMode maps as
 * "article" → transcript only, "article-and-lens" → + lens; stubs don't
 * exist for videos.
 */
async function processYouTubeVideo(
  job: ArticleJob,
  video: VideoInput,
  behavior: ArticleImportBehavior,
  setStage: (stage: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  // Duplicate check by video id -- the same relay check the bookmarklet
  // endpoint uses. Degrades gracefully: a failed check must not block import.
  setStage("checking-duplicates");
  let existingPath: string | null | undefined;
  try {
    existingPath = (await checkRelayVideoIds([video.video_id], signal))[
      video.video_id
    ];
  } catch (err) {
    signal?.throwIfAborted();
    console.warn(`[add-article] video dedup check failed, proceeding: ${err}`);
  }
  if (existingPath) {
    const topFolder = relayTranscriptFolder().split("/")[0];
    job.relay_url = editorOpenUrl(topFolder + existingPath);
    throw new Error(
      `This video was already imported: ${topFolder}${existingPath}`,
    );
  }

  setStage("fetching-transcript");
  const payload = await fetchYouTubeTranscript(video, signal);
  job.title = payload.title;
  job.updated_at = new Date().toISOString();

  await importVideo(job.id, payload, job.created_at, {
    createLens: behavior.createLens,
    signal,
    onStage: setStage,
    // Surface the link as soon as the path is known -- the placeholder doc
    // exists during processing, and a later failure doc stays reachable.
    onRelayUrl: (relayUrl) => {
      job.relay_url = relayUrl;
      job.updated_at = new Date().toISOString();
    },
  });
  console.log(
    `[add-article] Imported video transcript for ${job.url} ("${payload.title}")`,
  );
}

async function findExistingArticle(
  urls: string[],
  signal?: AbortSignal,
): Promise<ExistingArticleMatch | null> {
  const variants = dedupUrlVariants(...urls);
  const result = await checkRelayArticleUrls(variants, signal);
  const path = variants.map((variant) => result.found[variant]).find(Boolean);
  if (!path) return null;
  const stub = variants
    .map((variant) => result.stubs[variant])
    .find((candidate) => candidate?.path === path);
  return { path, stubContent: stub?.content };
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

function markdownBody(markdown: string): string {
  const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  return (match ? markdown.slice(match[0].length) : markdown)
    .trim()
    .replace(/^%%\r?\n[\s\S]*?\r?\n%%\r?\n+/, "")
    .trim();
}

export function assertRequiredBodyPrefix(
  body: string,
  requiredPrefix?: string,
): void {
  if (!requiredPrefix) return;
  const trimmed = body.trimStart();
  const occurrences = trimmed.split(requiredPrefix).length - 1;
  if (
    occurrences !== 1 ||
    (trimmed !== requiredPrefix && !trimmed.startsWith(`${requiredPrefix}\n\n`))
  ) {
    throw new Error(
      "The mandatory source download links were removed, changed, moved, or duplicated during article processing",
    );
  }
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
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
  suppliedReporter?: ArticleReviewReporter,
): Promise<void> {
  console.log(`[add-article] Processing ${job.url}`);
  void pruneExpiredEvidence();
  const createdDate = new Date().toISOString().slice(0, 10);
  const folder = relayArticleFolder();
  const topFolder = folder.split("/")[0];
  const behavior = articleImportBehavior(job.importMode);
  const isStubOnly = behavior.stubOnly;
  const reporter = suppliedReporter ?? createMemoryArticleReviewReporter(job);
  const setStage = async (stage: string) => {
    // A cancelled/deadlined job must actually STOP — Promise.race in the queue
    // settles the job status but cannot kill this pipeline, so every stage
    // boundary re-checks the signal. Without this, a "cancelled" job kept
    // running and wrote its article minutes later (ghost writes; duplicates
    // after a retry).
    signal?.throwIfAborted();
    job.stage = stage;
    job.updated_at = new Date().toISOString();
    await reporter.stage(stage);
  };

  // YouTube URLs import the video's transcript through the video pipeline
  // instead of scraping the watch page as an "article". Non-video YouTube
  // URLs and stub mode were already rejected at submit time (routes.ts); the
  // classification was stored on the job at enqueue.
  if (job.video) {
    return processYouTubeVideo(job, job.video, behavior, setStage, signal);
  }

  // Reject the common duplicate case before downloading and parsing the page.
  // A matched stub is retained for a later full import to promote in place.
  let existingStub: ExistingArticleMatch | null = null;
  await setStage("checking-duplicates");
  try {
    const existing = await findExistingArticle([job.url], signal);
    if (existing) {
      if (!existing.stubContent) {
        throw new Error(
          `This URL was already imported: ${topFolder}${existing.path}`,
        );
      }
      if (isStubOnly) {
        throw new Error(
          `An article stub already exists for this URL: ${topFolder}${existing.path}`,
        );
      }
      existingStub = existing;
    }
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.startsWith("This URL was already imported:") ||
        err.message.startsWith("An article stub already exists"))
    ) {
      throw err;
    }
    console.warn(`[add-article] early source_url dedup check failed, proceeding: ${err}`);
  }

  // Fetch once and retain the source independently of the chosen extractor.
  // Claude reads only these local evidence files; it never fetches the source.
  await setStage("fetching-source-evidence");
  const workDir = path.join(WORK_BASE, job.id);
  const evidence = await buildSourceEvidence(job.url, signal);
  await writeSourceEvidence(workDir, evidence);
  const ex = evidence.extraction;
  await reporter.extraction({
    via: ex.via,
    linked_out: ex.linkedOut,
    assessment_flags: ex.assessment.flags,
    source_digest: evidence.manifest.source_digest,
    source_kind: evidence.manifest.source_kind,
    media_type: evidence.manifest.media_type,
    fetched_url: evidence.manifest.fetched_url,
    candidate_chars: ex.body.length,
    source_text_chars: evidence.manifest.source_text_chars,
    alignment: evidence.manifest.alignment,
  });

  // 3. Validate.
  if (!ex.meta.title) {
    throw new Error("Could not determine article title from page");
  }
  if (!isStubOnly && ex.linkedOut) {
    throw new Error(
      "This post is a link-out announcement (the article lives in an external Google Doc/arXiv/PDF). Import the linked source directly instead.",
    );
  }
  if (!isStubOnly && ex.body.length < MIN_ARTICLE_CHARS) {
    throw new Error(
      `Extracted article suspiciously short (${ex.body.length} chars) — aborting`,
    );
  }
  let meta = ensureRequiredMeta(ex.meta, ex.siteName, createdDate);
  let body = ex.body;
  const requiredBodyPrefix = ex.requiredBodyPrefixMarkdown;
  job.title = meta.title;

  // 4. Duplicate detection by SOURCE URL. The real duplicate signal is the
  //    source_url, not the filename (which is author+title and collides across
  //    distinct pages). Check every spelling of this article's identity — the
  //    submitted URL, the page's canonical URL, and their normalized forms
  //    (tracking params / trailing slash / mirror host stripped) — so the same
  //    article via a mirror or a utm-tagged link is refused too. Degrades
  //    gracefully: if the relay check errors, fall through to the filename
  //    guard below rather than blocking the import.
  await setStage("checking-duplicates");
  let filenameBase = generateArticleFilenameBase(meta.author, meta.title);
  if (!filenameBase) {
    throw new Error(`Could not derive filename from title: ${meta.title}`);
  }
  try {
    const existing = await findExistingArticle(
      [job.url, meta.source_url],
      signal,
    );
    if (existing) {
      if (!existing.stubContent) {
        throw new Error(
          `This URL was already imported: ${topFolder}${existing.path}`,
        );
      }
      if (isStubOnly) {
        throw new Error(
          `An article stub already exists for this URL: ${topFolder}${existing.path}`,
        );
      }
      if (existingStub && existingStub.path !== existing.path) {
        throw new Error(
          `Multiple article stubs match this URL (${topFolder}${existingStub.path} and ${topFolder}${existing.path}). Resolve the duplicate stubs before importing the full article.`,
        );
      }
      existingStub = existing;
    }
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.startsWith("This URL was already imported:") ||
        err.message.startsWith("An article stub already exists") ||
        err.message.startsWith("Multiple article stubs match"))
    ) {
      throw err;
    }
    console.warn(`[add-article] source_url dedup check failed, proceeding: ${err}`);
  }

  // 4.5. Host + embed any PDF figure images: upload each to the folder's
  //      /attachments/ and replace its placeholder with the embed. Images that
  //      fail to upload are dropped (the text stays); never fails the import.
  if (!isStubOnly && ex.images?.length) {
    await setStage("uploading-images");
    const beforeImages = body;
    body = await embedPdfImages(body, ex.images, filenameBase, (p, png, mime) =>
      createRelayAttachment(topFolder, p, png, mime, signal),
    );
    await reporter.programmatic({
      code: "programmatic.pdf-images-hosted",
      count: ex.images.filter((_, index) => beforeImages.includes(`![[__pdfimg_${index}__]]`)).length,
      before: beforeImages,
      after: body,
    });
  }

  // 4.6. Rehost arXiv/ar5iv figure hotlinks as attachments — mirror-hosted
  //      asset URLs rot, and the library should be self-contained. Failures
  //      keep the external URL (an upgrade, never a gate).
  if (!isStubOnly && ex.via === "arxiv") {
    await setStage("uploading-images");
    const beforeImages = body;
    body = await hostRemoteImages(body, filenameBase, {
      hostPattern: ARXIV_IMAGE_HOSTS,
      fetchImage: async (u) => {
        const r = await fetchRawBytes(u, signal);
        return { bytes: r.bytes, contentType: r.contentType };
      },
      upload: (p, data, mime) =>
        createRelayAttachment(topFolder, p, data, mime, signal),
    });
    if (body !== beforeImages) {
      await reporter.programmatic({
        code: "programmatic.arxiv-images-hosted",
        count: Math.max(
          1,
          occurrences(body, "raw.githubusercontent.com/Lens-Academy/lens-edu-staging") -
            occurrences(beforeImages, "raw.githubusercontent.com/Lens-Academy/lens-edu-staging"),
        ),
        before: beforeImages,
        after: body,
      });
    }
  }

  // Safe normalization happens before validation. The first validation's
  // warnings and errors are review evidence; hybrid errors are repairable by
  // Claude, while the second validation is the hard gate.
  let reviewed = false;
  if (!isStubOnly) {
    await setStage("normalizing");
    const normalized = normalizeArticleBody(body, meta.source_url || job.url);
    body = normalized.body;
    assertRequiredBodyPrefix(body, requiredBodyPrefix);
    if (normalized.changes.length) {
      console.log(`[add-article] Applied normalizations: ${JSON.stringify(normalized.changes)}`);
      for (const change of normalized.changes) {
        await reporter.programmatic({
          code: change.code,
          count: change.count,
          before: change.samples[0]?.before,
          after: change.samples[0]?.after,
          detail: { samples: change.samples },
        });
      }
    }

    await setStage("validating-draft");
    let draft = generateArticleMarkdown(meta, body, createdDate);
    let validationStarted = Date.now();
    let validation = await validateArticleDraft(
      `articles/${filenameBase}.md`,
      draft,
      { signal },
    );
    await reporter.validation("initial", validation, Date.now() - validationStarted);

    await setStage("source-review");
    let reviewStarted = Date.now();
    const metaBeforeReview = meta;
    let outcome: ReviewOutcome;
    try {
      outcome = await reviewArticle(workDir, draft, meta, validation.issues, 0, signal);
      await reporter.llm(
        0,
        outcome.review,
        validation.issues.map((issue) => issue.code).filter((code): code is string => !!code),
        metaBeforeReview,
        outcome.meta,
        Date.now() - reviewStarted,
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof ArticleReviewRejectedError) {
        await reporter.llmRejected(
          0,
          error.review,
          validation.issues.map((issue) => issue.code).filter((code): code is string => !!code),
          metaBeforeReview,
          Date.now() - reviewStarted,
        );
      } else {
        await reporter.llmFailure(0, error, Date.now() - reviewStarted);
      }
      throw error;
    }
    meta = outcome.meta;
    body = markdownBody(outcome.markdown);
    assertRequiredBodyPrefix(body, requiredBodyPrefix);
    filenameBase = generateArticleFilenameBase(meta.author, meta.title);
    draft = generateArticleMarkdown(meta, body, createdDate);

    await setStage("validating-repair");
    validationStarted = Date.now();
    validation = await validateArticleDraft(`articles/${filenameBase}.md`, draft, { signal });
    await reporter.validation("post-review", validation, Date.now() - validationStarted);
    if (!validation.valid) {
      await setStage("repair-review");
      reviewStarted = Date.now();
      const metaBeforeRepair = meta;
      try {
        outcome = await reviewArticle(workDir, draft, meta, validation.issues, 1, signal);
        await reporter.llm(
          1,
          outcome.review,
          validation.issues.map((issue) => issue.code).filter((code): code is string => !!code),
          metaBeforeRepair,
          outcome.meta,
          Date.now() - reviewStarted,
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof ArticleReviewRejectedError) {
          await reporter.llmRejected(
            1,
            error.review,
            validation.issues.map((issue) => issue.code).filter((code): code is string => !!code),
            metaBeforeRepair,
            Date.now() - reviewStarted,
          );
        } else {
          await reporter.llmFailure(1, error, Date.now() - reviewStarted);
        }
        throw error;
      }
      meta = outcome.meta;
      body = markdownBody(outcome.markdown);
      assertRequiredBodyPrefix(body, requiredBodyPrefix);
      filenameBase = generateArticleFilenameBase(meta.author, meta.title);
      draft = generateArticleMarkdown(meta, body, createdDate);
      validationStarted = Date.now();
      validation = await validateArticleDraft(`articles/${filenameBase}.md`, draft, { signal });
      await reporter.validation("post-repair-review", validation, Date.now() - validationStarted);
    }
    assertArticleValid(validation);
    reviewed = true;
    job.title = meta.title;
  }

  // 5. Resolve a unique filename — disambiguating DISTINCT pages that share a
  //    base name (e.g. each Atlas chapter's "Introduction") — and write it,
  //    serialized so two concurrent imports can't pick the same name and
  //    overwrite each other.
  await setStage("writing");
  const candidatePaths = articleFilenameCandidates(
    filenameBase,
    meta.source_url || job.url,
  ).map((b) => `${folder}/${b}.md`);
  const mdPath = await withArticleWriteLock(async () => {
    // Last line of defense against post-abort ghost writes: the job may have
    // been cancelled while queued behind this lock.
    signal?.throwIfAborted();
    if (existingStub) {
      const refreshed = await findExistingArticle(
        [job.url, meta.source_url],
        signal,
      );
      if (!refreshed || refreshed.path !== existingStub.path || !refreshed.stubContent) {
        throw new Error(
          `The article stub changed or disappeared while importing: ${topFolder}${existingStub.path}. No changes were written; inspect the stub and retry.`,
        );
      }
      const parsed = parsePromotableArticleStub(
        refreshed.stubContent,
        `${topFolder}${refreshed.path}`,
      );
      const promotedBase = generateArticleMarkdown(
        meta,
        body,
        parsed.created || createdDate,
        {
          discussionBlocks: parsed.discussionBlocks,
          extraTags: parsed.extraTags,
        },
      );
      const promotedPath = `${topFolder}${refreshed.path}`;
      const promotedMd = reviewed
        ? generateArticleMarkdown(meta, body, parsed.created || createdDate, {
            discussionBlocks: parsed.discussionBlocks,
            extraTags: parsed.extraTags,
            review: {
              reviewed: createdDate,
              version: REVIEW_VERSION,
              model: REVIEW_MODEL,
              digest: articleReviewDigest(promotedBase),
              sourceDigest: evidence.manifest.source_digest,
              sourceFetched: evidence.manifest.fetched_at.slice(0, 10),
              sourceKind: evidence.manifest.source_kind,
            },
          })
        : promotedBase;
      const finalValidationStarted = Date.now();
      const finalValidation = await validateArticleDraft(refreshed.path.replace(/^\//, ""), promotedMd, { signal });
      await reporter.validation("final", finalValidation, Date.now() - finalValidationStarted);
      assertArticleValid(finalValidation);
      await reporter.finalDocument(promotedMd);
      await createRelayDoc(promotedPath, promotedMd, signal);
      return promotedPath;
    }

    const existing = await checkRelayDocsExist(candidatePaths, signal);
    const chosen = candidatePaths.find((p) => !existing[p]);
    if (!chosen) {
      throw new Error(`Document already exists: ${candidatePaths[0]}`);
    }
    const baseMarkdown = isStubOnly
      ? generateArticleStubMarkdown(meta, createdDate)
      : generateArticleMarkdown(meta, body, createdDate);
    const markdown = reviewed
      ? generateArticleMarkdown(meta, body, createdDate, {
          review: {
            reviewed: createdDate,
            version: REVIEW_VERSION,
            model: REVIEW_MODEL,
            digest: articleReviewDigest(baseMarkdown),
            sourceDigest: evidence.manifest.source_digest,
            sourceFetched: evidence.manifest.fetched_at.slice(0, 10),
            sourceKind: evidence.manifest.source_kind,
          },
        })
      : baseMarkdown;
    if (reviewed) {
      const finalValidationStarted = Date.now();
      const finalValidation = await validateArticleDraft(chosen.replace(`${topFolder}/`, ""), markdown, { signal });
      await reporter.validation("final", finalValidation, Date.now() - finalValidationStarted);
      assertArticleValid(finalValidation);
    }
    await reporter.finalDocument(markdown);
    await createRelayDoc(chosen, markdown, signal);
    return chosen;
  });
  job.relay_url = editorOpenUrl(mdPath);
  job.relay_path = mdPath;
  job.updated_at = new Date().toISOString();
  console.log(
    `[add-article] Wrote ${mdPath} (via ${ex.via}, ${body.length} chars)`,
  );

  // 6. The "full article + lens" mode wraps the article so it can be dropped
  //    straight into a module. A lens failure must not fail the import — the
  //    article is already saved.
  if (behavior.createLens) {
    await setStage("creating-lens");
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
