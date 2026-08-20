import { Hono } from "hono";
import type { ArticleJobQueue } from "./queue";
import {
  isArticleImportMode,
  type ArticleImportMode,
} from "../../shared/article-import-contract";
import { verifyShareToken, roleAtLeast } from "../share-token";
import { normalizeUrlForDedup } from "./url-normalize";
import { extractVideoInput } from "../add-video/fetch-transcript";

export const EDU_FOLDER = "ea4015da-24af-4d9d-ac49-8c902cb17121";
const ALL_FOLDERS = "00000000-0000-0000-0000-000000000000";
const MAX_URLS_PER_REQUEST = 20;
// Video jobs run Claude over a whole transcript (20-min ceiling of its own,
// plus up to 8 min waiting for a Claude slot) — the 12-min article deadline
// would kill every long video.
const VIDEO_JOB_TIMEOUT_MS = 35 * 60_000;
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

  router.use("/*", async (c, next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Authorization header required" }, 401);
    }
    const payload = verifyShareToken(authHeader.slice(7));
    if (!payload) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }
    if (payload.purpose !== "share") {
      return c.json({ error: "Share token required" }, 403);
    }
    if (!roleAtLeast(payload.role, "edit")) {
      return c.json({ error: "Edit access required" }, 403);
    }
    if (payload.folder !== EDU_FOLDER && payload.folder !== ALL_FOLDERS) {
      return c.json({ error: "Access denied: wrong folder scope" }, 403);
    }
    return next();
  });

  router.post("/", async (c) => {
    const body = await c.req
      .json<{
        urls?: string[];
        importMode?: unknown;
        createLens?: unknown;
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

    const results: Array<{
      url: string;
      status: "queued" | "invalid" | "already_queued";
      id?: string;
      error?: string;
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
      // Dedup within the request AND against active jobs by normalized URL, so
      // utm-tagged / trailing-slash / mirror-host variants of one article don't
      // spawn parallel jobs.
      const key = normalizeUrlForDedup(url);
      if (seen.has(key)) {
        // Emit an honest row — silently skipping left the client with no
        // result at all for that input line.
        results.push({ url, status: "already_queued" });
        continue;
      }
      seen.add(key);

      const active = queue.findActive(url, normalizeUrlForDedup);
      if (active) {
        results.push({ url, status: "already_queued", id: active.id });
        continue;
      }
      const video = extractVideoInput(url);
      if (video && importMode === "stub") {
        results.push({
          url,
          status: "invalid",
          error:
            'YouTube videos can\'t be imported as stubs — use "article" (imports the transcript) or "article-and-lens"',
        });
        continue;
      }
      const job = video
        ? queue.add(url, importMode, { timeoutMs: VIDEO_JOB_TIMEOUT_MS })
        : queue.add(url, importMode);
      results.push({ url, status: "queued", id: job.id });
    }

    return c.json({ results });
  });

  router.get("/status", (c) => {
    return c.json({ jobs: queue.status() });
  });

  // Cancel a queued/processing job. Aborts in-flight work; the job shows as
  // failed with "Cancelled by user". Stuck jobs no longer need a container
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
    if (job.status !== "failed") {
      return c.json({ error: "Only failed jobs can be retried" }, 400);
    }
    const active = queue.findActive(job.url, normalizeUrlForDedup);
    if (active) {
      return c.json({ error: "URL is already queued", id: active.id }, 409);
    }
    const retried = job.timeout_ms
      ? queue.add(job.url, job.importMode, { timeoutMs: job.timeout_ms })
      : queue.add(job.url, job.importMode);
    return c.json({ id: retried.id, status: "queued" });
  });

  return router;
}
