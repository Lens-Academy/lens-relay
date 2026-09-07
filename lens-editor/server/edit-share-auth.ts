import type { Context, MiddlewareHandler } from "hono";
import { verifyShareToken, roleAtLeast, type ShareTokenPayload } from "./share-token";

/** The relay folder the importer and attachment routes serve. */
export const EDU_FOLDER = "ea4015da-24af-4d9d-ac49-8c902cb17121";
/** Display name of that folder (`folder_config.name` on the relay). */
export const EDU_FOLDER_NAME = "Lens Edu";
const ALL_FOLDERS = "00000000-0000-0000-0000-000000000000";

const CONTEXT_KEY = "shareTokenPayload";

/** The verified payload set by [`requireEduEditShareToken`]. */
export function shareTokenPayload(c: Context): ShareTokenPayload | undefined {
  return c.get(CONTEXT_KEY) as ShareTokenPayload | undefined;
}

/**
 * Whether a verified token may write to the relay folder called
 * `folderName`. Routes that take a folder name in the request body must call
 * this: the middleware only proves edit access to *one* folder, while the
 * relay server token the routes use afterwards can write anywhere.
 */
export function tokenAllowsFolderName(
  payload: ShareTokenPayload | undefined,
  folderName: string,
): boolean {
  if (!payload) return false;
  if (payload.folder === ALL_FOLDERS) return true;
  return payload.folder === EDU_FOLDER && folderName === EDU_FOLDER_NAME;
}

/**
 * Hono middleware: require a `share` token with at least edit role on the
 * Lens Edu folder (or an all-folders token). Shared by the add-article and
 * attachment routes; the relay MCP tools forward the caller's own share
 * token as the Bearer, so this is where role and folder are enforced.
 */
export function requireEduEditShareToken(): MiddlewareHandler {
  return async (c, next) => {
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
    c.set(CONTEXT_KEY, payload);
    return next();
  };
}
