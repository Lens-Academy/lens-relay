import { Hono } from "hono";
import type { ArticleJobQueue } from "./queue";
import { verifyShareToken } from "../share-token";

const EDU_FOLDER = "ea4015da-24af-4d9d-ac49-8c902cb17121";
const ALL_FOLDERS = "00000000-0000-0000-0000-000000000000";
const MAX_URLS_PER_REQUEST = 20;

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
    if (payload.role !== "edit") {
      return c.json({ error: "Edit access required" }, 403);
    }
    if (payload.folder !== EDU_FOLDER && payload.folder !== ALL_FOLDERS) {
      return c.json({ error: "Access denied: wrong folder scope" }, 403);
    }
    return next();
  });

  router.post("/", async (c) => {
    const body = await c.req.json<{ urls?: string[] }>().catch(() => null);
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
      if (seen.has(url)) continue;
      seen.add(url);

      const active = queue.findActive(url);
      if (active) {
        results.push({ url, status: "already_queued", id: active.id });
        continue;
      }
      const job = queue.add(url);
      results.push({ url, status: "queued", id: job.id });
    }

    return c.json({ results });
  });

  router.get("/status", (c) => {
    return c.json({ jobs: queue.status() });
  });

  return router;
}
