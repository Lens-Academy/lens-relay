import { Hono } from "hono";
import type { ArticleJobQueue } from "./queue";
import {
  isArticleImportMode,
  type ArticleImportMode,
} from "../../shared/article-import-contract";
import { requireEduShareToken, EDU_FOLDER } from "../edit-share-auth";
import { normalizeUrlForDedup } from "./url-normalize";
import { extractVideoInput, isYouTubeUrl } from "../add-video/video-url";

export { EDU_FOLDER };
const MAX_URLS_PER_REQUEST = 20;
const MAX_CANCEL_IDS = 200;

/** Dedup key: the video id for YouTube videos (youtu.be / watch / shorts
 *  spellings of one video must collapse to one job -- they'd all write the
 *  same relay path), the normalized URL otherwise. */
function normalizeImportKey(url: string): string {
  const video = extractVideoInput(url);
  return video ? `yt:${video.video_id}` : normalizeUrlForDedup(url);
}
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

/**
 * Routes for the /add-article feature. Unlike add-video there is no
 * bookmarklet and no cross-origin caller, so the page authenticates with
 * its regular edit share token directly — no token exchange needed.
 */
export function createAddArticleRoutes(queue: ArticleJobQueue): Hono {
  const router = new Hono();

  router.use("/*", requireEduShareToken({ minRole: "edit" }));

  router.post("/", async (c) => {
    const body = await c.req
      .json<{
        urls?: string[];
        importMode?: unknown;
        createLens?: unknown;
        replaceExisting?: unknown;
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

    const results: Array<{
      url: string;
      status: "queued" | "invalid" | "already_queued";
      id?: string;
      error?: string;
      queue_position?: number;
      eta_minutes?: number;
    }> = [];

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
      // YouTube-shape judgments are static -- settle them at submit time
      // instead of queueing a job that can only fail minutes later.
      const video = extractVideoInput(url);
      if (!video && isYouTubeUrl(url)) {
        results.push({
          url,
          status: "invalid",
          error:
            "This YouTube URL doesn't point to a single video. Submit a watch/shorts/youtu.be link",
        });
        continue;
      }
      if (replaceExisting && !video) {
        results.push({
          url,
          status: "invalid",
          error: "replaceExisting re-imports YouTube videos only; articles can't be re-imported this way",
        });
        continue;
      }
      if (video && importMode === "stub") {
        results.push({
          url,
          status: "invalid",
          error:
            'YouTube videos can\'t be imported as stubs. Use "article" (imports the transcript) or "article-and-lens"',
        });
        continue;
      }

      // Dedup within the request AND against active jobs, so utm-tagged /
      // trailing-slash / mirror-host / youtu.be-vs-watch variants of one
      // document don't spawn parallel jobs.
      const key = normalizeImportKey(url);
      if (seen.has(key)) {
        // Emit an honest row — silently skipping left the client with no
        // result at all for that input line.
        results.push({ url, status: "already_queued" });
        continue;
      }
      seen.add(key);

      const active = queue.findActive(url, normalizeImportKey);
      if (active) {
        results.push({ url, status: "already_queued", id: active.id });
        continue;
      }
      const job = queue.add(url, importMode, undefined, { replaceExisting });
      results.push({ url, status: "queued", id: job.id });
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
    return c.json({ queue: queue.summary(), jobs: jobs.map((job) => queue.view(job)) });
  });

  // Remove several jobs at once (the import_cancel MCP tool): queued jobs
  // leave the queue, running ones are stopped. Per-id results, never a 404
  // for the whole batch because one id was already finished.
  router.post("/cancel", async (c) => {
    const body = await c.req.json<{ ids?: unknown }>().catch(() => null);
    const ids = body?.ids;
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "string")) {
      return c.json({ error: "ids must be a non-empty array of job ids" }, 400);
    }
    if (ids.length > MAX_CANCEL_IDS) {
      return c.json({ error: `At most ${MAX_CANCEL_IDS} ids per request` }, 400);
    }
    const results = (ids as string[]).map((id) => {
      const job = queue.get(id);
      if (!job) return { id, cancelled: false, error: "No such job" };
      const before = job.status;
      if (!queue.cancel(id)) {
        return { id, cancelled: false, error: `Already finished (${job.status})` };
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
    const active = queue.findActive(job.url, normalizeImportKey);
    if (active) {
      return c.json({ error: "URL is already queued", id: active.id }, 409);
    }
    const retried = queue.add(job.url, job.importMode, job.id, {
      replaceExisting: job.replaceExisting,
    });
    return c.json({ id: retried.id, status: "queued" });
  });

  return router;
}
