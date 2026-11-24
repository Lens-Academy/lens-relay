import { Hono } from "hono";
import type { ArticleJobQueue } from "./queue";
import {
  isArticleImportMode,
  type ArticleImportMode,
} from "../../shared/article-import-contract";
import type {
  ImportResultRow,
  JobLinkBack,
  SourceLinksCheckResponse,
} from "../../shared/source-links-contract";
import {
  requireEduShareToken,
  shareTokenPayload,
  tokenAllowsFolderName,
  tokenCoversAllFolders,
  EDU_FOLDER,
} from "../edit-share-auth";
import { dedupUrlVariants, normalizeImportKey, sameSource } from "./url-normalize";
import { extractVideoInput, isYouTubeUrl } from "../add-video/video-url";
import { linkRelaySource, resolveRelayDocIdByPath, RelayLinkError } from "../add-video/relay-docs";
import { sharedLibraryIndex, type LibraryEntry, type LibraryIndex } from "./library-index";
import { classifySourceLink } from "./link-classify";
import {
  folderOfPath,
  jobsBySource,
  pageMatcher,
  resolveLinkBack,
  sameSourceAsJob,
  sourceLinkStatus,
  swapOutcome,
  type LinkBackTemplate,
} from "./source-links";

export { EDU_FOLDER };
const MAX_URLS_PER_REQUEST = 20;
const MAX_LINKS_PER_CHECK = 300;
const MAX_CANCEL_IDS = 200;
/** How long a page's doc id is trusted: the offer polls, and a rename is rare. */
const PAGE_ID_TTL_MS = 30_000;

function validateUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.href;
}

/** One source a link-back request names, and the row it was answered with. */
interface RequestSource {
  /** The URLs that make it up, as sent and as `validateUrl` spells them. */
  members: string[];
  /** Every spelling to replace. */
  spellings: Set<string>;
  row?: ImportResultRow;
}

/**
 * A link-back request's URLs by source, under their import key. Spellings of one
 * page share one job or swap, so each gets replaced, while URLs that only share
 * a key stay apart. `sameSource` isn't transitive (`/view` matches both
 * `?ref=111` and `?ref=222`), so a URL joins a group only if it matches every
 * member. `validateUrl` can change a URL (`parsed.href`), so the spelling as
 * sent is kept: it is what the page holds, and a swap matches text. Variants are
 * filtered because the dedup form drops what tells some pages apart: without its
 * route, `/app#/b` is a link to `/app`.
 */
function requestSources(urls: unknown[]): Map<string, RequestSource[]> {
  const sources = new Map<string, RequestSource[]>();
  for (const raw of urls) {
    const url = typeof raw === "string" ? validateUrl(raw) : null;
    if (!url) continue;
    const sent = (raw as string).trim();
    const key = normalizeImportKey(url);
    const sameKey = sources.get(key) ?? [];
    sources.set(key, sameKey);
    let source = sameKey.find(({ members }) => members.every((member) => sameSource(url, member)));
    if (!source) {
      source = { members: [], spellings: new Set() };
      sameKey.push(source);
    }
    source.members.push(sent, url);
    for (const spelling of dedupUrlVariants(sent, url, extractVideoInput(url)?.url)) {
      if (sameSource(spelling, url)) source.spellings.add(spelling);
    }
  }
  // A spelling two sources could claim (the bare `/view` behind both refs) goes
  // to the one the page sent it for, or to neither: a swap must not guess.
  for (const sameKey of sources.values()) {
    const claims = new Map<string, number>();
    for (const { spellings } of sameKey) {
      for (const spelling of spellings) claims.set(spelling, (claims.get(spelling) ?? 0) + 1);
    }
    for (const source of sameKey) {
      for (const spelling of source.spellings) {
        if (claims.get(spelling)! > 1 && !source.members.includes(spelling)) source.spellings.delete(spelling);
      }
    }
  }
  return sources;
}

interface AddArticleRouteOptions {
  /** Default: the index the queue reports finished imports to. */
  library?: Pick<LibraryIndex, "ensureLoaded" | "lookup">;
  /** Default: the relay. */
  linkSource?: typeof linkRelaySource;
  resolveDocId?: (path: string) => Promise<string | null>;
}

/**
 * Routes for the Add Source page (/add-source). Unlike add-video there is no
 * bookmarklet and no cross-origin caller, so the page authenticates with
 * its regular edit share token directly — no token exchange needed.
 */
export function createAddArticleRoutes(
  queue: ArticleJobQueue,
  options: AddArticleRouteOptions = {},
): Hono {
  const router = new Hono();
  const library = options.library ?? sharedLibraryIndex();
  const linkSource = options.linkSource ?? linkRelaySource;
  const resolveDocId = options.resolveDocId ?? ((path: string) => resolveRelayDocIdByPath(path));

  // A page's link-backs, found by its doc id so a page renamed since still
  // matches, and by path when the relay can't say. The lookup is cached, failures
  // too, so the offer's polling costs no relay calls and a hung relay no waits.
  const pageIds = new Map<string, { at: number; id: Promise<string | null | undefined> }>();
  const pageLinks = async (path: string) => {
    const now = Date.now();
    let cached = pageIds.get(path);
    if (!cached || now - cached.at >= PAGE_ID_TTL_MS) {
      if (pageIds.size > 1_000) {
        for (const [key, entry] of pageIds) if (now - entry.at >= PAGE_ID_TTL_MS) pageIds.delete(key);
      }
      cached = {
        at: now,
        id: resolveDocId(path).catch((error) => {
          console.warn(`[add-article] could not look up ${path}, matching its link-backs by path: ${error}`);
          return undefined;
        }),
      };
      pageIds.set(path, cached);
    }
    return pageMatcher(path, await cached.id);
  };

  router.use("/*", requireEduShareToken({ minRole: "edit" }));

  // Where each of a page's links stands, for the editor's offer. Only sources
  // come back. A status read, so it never queues anything.
  router.post("/links/check", async (c) => {
    const body = await c.req.json<{ urls?: unknown; path?: unknown }>().catch(() => null);
    if (!Array.isArray(body?.urls)) {
      return c.json({ error: "urls array is required" }, 400);
    }
    if (body.urls.length > MAX_LINKS_PER_CHECK) {
      return c.json({ error: `At most ${MAX_LINKS_PER_CHECK} URLs per request` }, 400);
    }
    const page = body.path;
    if (page !== undefined && typeof page !== "string") {
      return c.json({ error: "path must be a full relay path" }, 400);
    }
    if (page !== undefined && !tokenAllowsFolderName(shareTokenPayload(c), folderOfPath(page))) {
      return c.json({ error: "Access denied: this token can't see that folder" }, 403);
    }
    const forPage = page === undefined ? undefined : await pageLinks(page);
    const ready = library.ensureLoaded();
    const jobs = jobsBySource(queue.status());
    const urls = new Set(body.urls.filter((url): url is string => typeof url === "string"));
    const links = [...urls].flatMap((url) => {
      const kind = classifySourceLink(url);
      if (!kind) return [];
      const sourceJobs = (jobs.get(normalizeImportKey(url)) ?? []).filter((job) => sameSourceAsJob(url, job));
      return [sourceLinkStatus(url, kind, library.lookup(url), sourceJobs, (job) => queue.view(job), forPage)];
    });
    const { workers, avg_job_minutes, queued, processing } = queue.summary();
    const response: SourceLinksCheckResponse = {
      ready,
      links,
      queue: { workers, avg_job_minutes, queued, processing },
    };
    return c.json(response);
  });

  router.post("/", async (c) => {
    const body = await c.req
      .json<{
        urls?: string[];
        importMode?: unknown;
        createLens?: unknown;
        replaceExisting?: unknown;
        linkBack?: unknown;
      }>()
      .catch(() => null);
    if (!body?.urls || !Array.isArray(body.urls) || body.urls.length === 0) {
      return c.json(
        { error: "urls array is required and must not be empty" },
        400,
      );
    }
    if (body.urls.length > MAX_URLS_PER_REQUEST) {
      return c.json(
        { error: `At most ${MAX_URLS_PER_REQUEST} URLs per request` },
        400,
      );
    }
    if (body.createLens !== undefined) {
      return c.json(
        { error: "createLens is not supported; importMode is required" },
        400,
      );
    }
    if (!isArticleImportMode(body.importMode)) {
      return c.json(
        {
          error:
            "importMode is required and must be one of: stub, article, article-and-lens",
        },
        400,
      );
    }
    const importMode: ArticleImportMode = body.importMode;
    if (body.replaceExisting !== undefined && typeof body.replaceExisting !== "boolean") {
      return c.json({ error: "replaceExisting must be a boolean" }, 400);
    }
    const replaceExisting = body.replaceExisting === true;

    let linkBack: LinkBackTemplate | null = null;
    if (body.linkBack !== undefined) {
      const resolved = await resolveLinkBack(body.linkBack, shareTokenPayload(c), resolveDocId);
      if ("status" in resolved) return c.json({ error: resolved.error }, resolved.status);
      linkBack = resolved;
      library.ensureLoaded();
    }
    const sources = linkBack ? requestSources(body.urls) : null;
    // One relay failure answers for the rest of the request, so a hung relay
    // costs one timeout rather than twenty. A missing target is that link's own.
    let relayFailure: string | undefined;

    const swapNow = async (
      url: string,
      source: RequestSource,
      entry: LibraryEntry,
      template: LinkBackTemplate,
    ): Promise<ImportResultRow> => {
      const row = { url, path: entry.path, title: entry.title };
      if (relayFailure) return { ...row, status: "link_failed", error: relayFailure };
      try {
        const { state, error } = swapOutcome(
          await linkSource({
            docId: template.doc_id,
            urls: [...source.spellings].filter((spelling) => sameSource(spelling, entry.sourceUrl)),
            target: entry.path,
            title: entry.title,
            actor: template.actor,
            author: template.author,
            protectHuman: template.protect_human,
          }),
        );
        if (state === "linked" || state === "suggested") {
          return { ...row, status: state, ...(error ? { error } : {}) };
        }
        return {
          ...row,
          status: "link_failed",
          error: error ?? "The link is no longer on the page",
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!(err instanceof RelayLinkError && err.code === "target_missing")) relayFailure = message;
        return { ...row, status: "link_failed", error: message };
      }
    };

    const results: ImportResultRow[] = [];

    const seen = new Set<string>();
    for (const raw of body.urls) {
      const url = typeof raw === "string" ? validateUrl(raw) : null;
      if (!url) {
        results.push({
          url: String(raw),
          status: "invalid",
          error: "Not a valid http(s) URL",
        });
        continue;
      }
      // With a link-back, rows name the URL as sent: the caller is matching
      // them against the text of a page.
      const shownUrl = linkBack ? raw : url;
      // YouTube-shape judgments are static -- settle them at submit time
      // instead of queueing a job that can only fail minutes later.
      const video = extractVideoInput(url);
      if (!video && isYouTubeUrl(url)) {
        results.push({
          url: shownUrl,
          status: "invalid",
          error:
            "This YouTube URL doesn't point to a single video. Submit a watch/shorts/youtu.be link",
        });
        continue;
      }
      if (replaceExisting && !video) {
        results.push({
          url: shownUrl,
          status: "invalid",
          error: "replaceExisting re-imports YouTube videos only; articles can't be re-imported this way",
        });
        continue;
      }

      // Dedup within the request AND against active jobs, so utm-tagged /
      // trailing-slash / mirror-host / youtu.be-vs-watch variants of one
      // document don't spawn parallel jobs.
      const key = normalizeImportKey(url);
      const source = sources?.get(key)?.find(({ members }) => members.includes(url));
      if (source?.row) {
        // That one job or swap covers every spelling of the source.
        const { row } = source;
        const status = row.status === "queued" ? "already_queued" : row.status;
        results.push({ ...row, url: shownUrl, status });
        continue;
      }
      if (!source && seen.has(key)) {
        // Emit an honest row — silently skipping left the client with no
        // result at all for that input line.
        results.push({ url, status: "already_queued" });
        continue;
      }
      seen.add(key);

      // replaceExisting asks for a new import of what the library already has.
      const entry = linkBack && !replaceExisting ? library.lookup(url) : undefined;
      if (linkBack && source && entry && !entry.stub) {
        source.row = await swapNow(shownUrl, source, entry, linkBack);
        results.push(source.row);
        continue;
      }

      const link: JobLinkBack | undefined = linkBack && source
        ? { ...linkBack, urls: [...source.spellings], state: "waiting" }
        : undefined;
      // A link only joins a job for its own page: whatever that job imports is
      // what the link becomes.
      const active = queue.findActive(
        url,
        normalizeImportKey,
        link ? (job) => link.urls.every((spelling) => sameSourceAsJob(spelling, job)) : undefined,
      );
      if (active) {
        if (link) queue.attachLinkBack(active.id, link);
        const row: ImportResultRow = { url: shownUrl, status: "already_queued", id: active.id };
        if (source) source.row = row;
        results.push(row);
        continue;
      }
      const job = queue.add(
        url,
        importMode,
        undefined,
        link ? { replaceExisting, linkBack: [link], startedBy: link.doc_id } : { replaceExisting },
      );
      const row: ImportResultRow = { url: shownUrl, status: "queued", id: job.id };
      if (source) source.row = row;
      results.push(row);
    }

    // Positions once every job of this request is in, so they are final.
    for (const result of results) {
      const job = result.id ? queue.get(result.id) : undefined;
      if (!job) continue;
      const view = queue.view(job);
      if (view.queue_position !== undefined) result.queue_position = view.queue_position;
      if (view.eta_minutes !== undefined) result.eta_minutes = view.eta_minutes;
    }
    return c.json({ results, queue: queue.summary() });
  });

  // Optional filter: repeat `id` and/or `url` to get only those jobs (a job
  // matching any of them). A url matches its dedup variants too (utm tags,
  // trailing slash, youtu.be vs watch), the same rule that dedups submissions.
  // Any id/url param switches filtering on; one that names no job (or an
  // unparseable url) matches nothing rather than widening to every job.
  router.get("/status", (c) => {
    const idParams = c.req.queries("id") ?? [];
    const urlParams = c.req.queries("url") ?? [];
    let jobs = queue.status();
    if (idParams.length > 0 || urlParams.length > 0) {
      const ids = new Set(idParams);
      const urlKeys = new Set(
        urlParams.flatMap((raw) => {
          const url = validateUrl(raw);
          return url ? [normalizeImportKey(url)] : [];
        }),
      );
      jobs = jobs.filter(
        (job) => ids.has(job.id) || urlKeys.has(normalizeImportKey(job.url)),
      );
    }
    const allFolders = tokenCoversAllFolders(shareTokenPayload(c));
    const views = jobs.map((job) => {
      const view = queue.view(job);
      if (allFolders) return view;
      // Link-backs name pages in folders this token can't see.
      const { link_back: _links, started_by: _starter, ...visible } = view;
      return visible;
    });
    return c.json({ queue: queue.summary(), jobs: views });
  });

  // Remove several jobs at once (the import_cancel MCP tool): queued jobs
  // leave the queue, running ones are stopped. Per-id results, never a 404
  // for the whole batch because one id was already finished. With `path`, a
  // page stops only its own interest: it cancels a job it started that nobody
  // else has joined, and otherwise leaves the job running without it.
  router.post("/cancel", async (c) => {
    const body = await c.req.json<{ ids?: unknown; path?: unknown }>().catch(() => null);
    const ids = body?.ids;
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "string")) {
      return c.json({ error: "ids must be a non-empty array of job ids" }, 400);
    }
    if (ids.length > MAX_CANCEL_IDS) {
      return c.json({ error: `At most ${MAX_CANCEL_IDS} ids per request` }, 400);
    }
    const page = body?.path;
    if (page !== undefined && typeof page !== "string") {
      return c.json({ error: "path must be a full relay path" }, 400);
    }
    if (page !== undefined && !tokenAllowsFolderName(shareTokenPayload(c), folderOfPath(page))) {
      return c.json({ error: "Access denied: this token can't write to that folder" }, 403);
    }
    const forPage = page === undefined ? undefined : await pageLinks(page);
    const results = (ids as string[]).map((id) => {
      const job = queue.get(id);
      if (!job) return { id, cancelled: false, error: "No such job" };
      const before = job.status;
      const stopped = forPage ? queue.stopForPage(id, forPage) : "unchanged";
      if (stopped === "cancelled") return { id, cancelled: true, was: before };
      if (stopped === "detached") return { id, cancelled: false, detached: true };
      if (!queue.cancel(id)) {
        return {
          id,
          cancelled: false,
          error: job.status === "processing"
            ? "Already imported; the job is closing its report"
            : `Already finished (${job.status})`,
        };
      }
      return { id, cancelled: true, was: before };
    });
    return c.json({ results, queue: queue.summary() });
  });

  // Cancel a queued/processing job. Aborts in-flight work; the job shows as
  // "cancelled". Stuck jobs no longer need a container
  // restart to clear.
  router.delete("/:id", (c) => {
    const ok = queue.cancel(c.req.param("id"));
    if (!ok) {
      return c.json({ error: "Job not found or already finished" }, 404);
    }
    return c.json({ ok: true });
  });

  // Re-queue a failed job's URL as a fresh job.
  router.post("/:id/retry", (c) => {
    const job = queue.get(c.req.param("id"));
    if (!job) return c.json({ error: "Job not found" }, 404);
    if (job.status !== "failed" && job.status !== "cancelled") {
      return c.json({ error: "Only failed or cancelled jobs can be retried" }, 400);
    }
    const waiting = job.link_back?.length ? queue.takeLinkBacks(job.id) : [];
    const active = queue.findActive(
      job.url,
      normalizeImportKey,
      waiting.length > 0
        ? (other) => waiting.every((link) => link.urls.every((spelling) => sameSourceAsJob(spelling, other)))
        : undefined,
    );
    if (active) {
      for (const link of waiting) queue.attachLinkBack(active.id, link);
      return c.json({ error: "URL is already queued", id: active.id }, 409);
    }
    // The page that started the job still started the retry, if it is still
    // waiting on it; a page that pressed Stop is gone from `waiting`.
    const startedBy = waiting.some((link) => link.doc_id === job.started_by) ? job.started_by : undefined;
    const retried = queue.add(job.url, job.importMode, job.id, {
      replaceExisting: job.replaceExisting,
      ...(waiting.length > 0 ? { linkBack: waiting } : {}),
      ...(startedBy ? { startedBy } : {}),
    });
    return c.json({ id: retried.id, status: "queued" });
  });

  return router;
}
