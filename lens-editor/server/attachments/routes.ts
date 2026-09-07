import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createHash } from "node:crypto";
import limits from "../../shared/attachment-limits.json";
import {
  requireEduEditShareToken,
  shareTokenPayload,
  tokenAllowsFolderName,
} from "../edit-share-auth";
import { fetchRawBytes } from "../add-article/fetch";
import { SsrfError } from "../add-article/ssrf";
import {
  createRelayAttachment,
  findRelayAttachmentByHash,
  RelayAttachmentConflictError,
  type RelayAttachmentResult,
} from "../add-video/relay-docs";
import {
  ALLOWED_IMAGE_MIMES,
  MIME_BY_EXT,
  looksLikeSvg,
  pathExt,
  sniffImage,
  type ImageMime,
} from "./image-types";

/** Hard per-file cap (bytes); shared with the relay via
 *  `shared/attachment-limits.json`. */
export const MAX_ATTACHMENT_BYTES: number = limits.max_bytes;
/** Above this the upload succeeds with a warning. */
export const SOFT_ATTACHMENT_BYTES: number = limits.soft_bytes;
const MAX_STEM_LEN: number = limits.max_stem_len;
/** JSON body cap: a 20 MiB image is ~27 MiB of base64 plus the envelope.
 *  Matches the relay's /mcp body limit. */
export const MAX_REQUEST_BODY_BYTES = 30 * 1024 * 1024;
const STEM_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ATTACHMENT_PATH_RE = /^\/attachments\/([^/"]+)$/;

export interface AttachmentImportRequest {
  folder: string;
  url?: string;
  content_base64?: string;
  /** In-folder destination, `/attachments/<name>.<ext>`. */
  file_path?: string;
  stem?: string;
  mimetype?: string;
  overwrite?: boolean;
}

export interface AttachmentImportResponse {
  /** In-folder path of the hosted file, e.g. `/attachments/x-1a2b3c4d.png`. */
  path: string;
  uuid: string;
  doc_id: string;
  sha256: string;
  bytes: number;
  mimetype: ImageMime;
  created: boolean;
  overwritten: boolean;
  /** In-folder path of the pre-existing copy when nothing was uploaded. */
  deduplicated_from: string | null;
  warnings: string[];
}

/** Dependencies, injectable for tests. */
export interface AttachmentRouteDeps {
  fetchBytes: (
    url: string,
    signal?: AbortSignal,
  ) => Promise<{ bytes: ArrayBuffer; contentType: string }>;
  findByHash: typeof findRelayAttachmentByHash;
  upload: typeof createRelayAttachment;
  /** Overrides the relay's clock for tests; unused otherwise. */
  now?: () => number;
}

export function defaultAttachmentRouteDeps(): AttachmentRouteDeps {
  return {
    fetchBytes: (url, signal) =>
      fetchRawBytes(url, signal, {
        accept: "image/png,image/jpeg,image/gif,image/webp,image/*;q=0.8,*/*;q=0.5",
        // Stream-abort at the hard cap + slack instead of buffering 32 MiB.
        maxBytes: MAX_ATTACHMENT_BYTES + 1024,
      }),
    findByHash: findRelayAttachmentByHash,
    upload: createRelayAttachment,
  };
}

class RequestError extends Error {
  constructor(
    readonly status: 400 | 403 | 409 | 413 | 415 | 422 | 502,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RequestError";
  }
}

/** Strict base64 decode: whitespace tolerated, anything else rejected
 *  (Buffer.from(..., "base64") silently skips junk). */
export function decodeBase64Strict(input: string): Buffer {
  const compact = input.replace(/\s+/g, "");
  if (compact.length === 0) {
    throw new RequestError(400, "content_base64 is empty");
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new RequestError(400, "content_base64 is not valid base64");
  }
  return Buffer.from(compact, "base64");
}

/** Kebab-case stem from a URL's last path segment ("Fig_1 (final).PNG" ->
 *  "fig-1-final"), falling back to "image". */
export function stemFromUrl(url: string): string {
  let segment = "";
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    segment = decodeURIComponent(parts[parts.length - 1] ?? "");
  } catch {
    /* fall through */
  }
  segment = segment.replace(/\.[A-Za-z0-9]{1,5}$/, "");
  const kebab = segment
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_STEM_LEN)
    .replace(/-+$/, "");
  return kebab || "image";
}

function parseRequest(body: unknown): AttachmentImportRequest {
  if (!body || typeof body !== "object") {
    throw new RequestError(400, "JSON body required");
  }
  const b = body as Record<string, unknown>;
  const str = (key: string): string | undefined => {
    const v = b[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") throw new RequestError(400, `${key} must be a string`);
    return v.trim() === "" ? undefined : v;
  };
  const folder = str("folder");
  if (!folder || folder.includes("/")) {
    throw new RequestError(400, "folder (top-level relay folder name) is required");
  }
  const url = str("url")?.trim();
  const content_base64 = str("content_base64");
  if ((url ? 1 : 0) + (content_base64 ? 1 : 0) !== 1) {
    throw new RequestError(400, "Provide exactly one of url or content_base64");
  }
  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new RequestError(400, "url is not a valid URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new RequestError(400, "url must use http or https");
    }
  }
  const file_path = str("file_path");
  const stem = str("stem");
  if (file_path && stem) {
    throw new RequestError(400, "Provide either file_path or stem, not both");
  }
  if (file_path) {
    const m = file_path.match(ATTACHMENT_PATH_RE);
    const name = m?.[1];
    if (!name || name.startsWith(".")) {
      throw new RequestError(400, "file_path must be /attachments/<name>.<ext>");
    }
    const ext = pathExt(name);
    if (!(ext in MIME_BY_EXT)) {
      throw new RequestError(
        400,
        `file_path extension must be one of ${Object.keys(MIME_BY_EXT).join(", ")}`,
      );
    }
  }
  if (stem && (!STEM_RE.test(stem) || stem.length > MAX_STEM_LEN)) {
    throw new RequestError(400, "stem must be kebab-case ([a-z0-9] and single dashes)");
  }
  if (content_base64 && !file_path && !stem) {
    throw new RequestError(400, "stem or file_path is required with content_base64");
  }
  const overwriteRaw = b.overwrite;
  if (overwriteRaw !== undefined && overwriteRaw !== null && typeof overwriteRaw !== "boolean") {
    throw new RequestError(400, "overwrite must be a boolean");
  }
  return {
    folder,
    url,
    content_base64,
    file_path,
    stem,
    mimetype: str("mimetype"),
    overwrite: overwriteRaw === true,
  };
}

async function obtainBytes(
  req: AttachmentImportRequest,
  deps: AttachmentRouteDeps,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; declaredType: string }> {
  if (req.content_base64) {
    return { bytes: decodeBase64Strict(req.content_base64), declaredType: req.mimetype ?? "" };
  }
  try {
    const { bytes, contentType } = await deps.fetchBytes(req.url!, signal);
    return { bytes: Buffer.from(bytes), declaredType: contentType || req.mimetype || "" };
  } catch (err) {
    if (err instanceof SsrfError) {
      throw new RequestError(400, `Refusing to fetch url: ${err.message}`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (/too large/i.test(msg)) {
      throw new RequestError(
        413,
        `Image is larger than the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MiB hard limit`,
      );
    }
    throw new RequestError(502, `Could not fetch url: ${msg}`);
  }
}

/**
 * The whole import minus HTTP: validate, obtain bytes, sniff, dedup, upload.
 * Exported so the pipeline could reuse it; the route is a thin wrapper.
 */
export async function importAttachment(
  body: unknown,
  deps: AttachmentRouteDeps,
  isFolderAllowed: (folderName: string) => boolean,
  signal?: AbortSignal,
): Promise<AttachmentImportResponse> {
  const req = parseRequest(body);
  // The share token proves edit access to one folder; the relay server token
  // used below can write to any. Bind the two before doing anything else.
  if (!isFolderAllowed(req.folder)) {
    throw new RequestError(403, `Access denied: this token cannot write to folder '${req.folder}'`);
  }
  const { bytes, declaredType } = await obtainBytes(req, deps, signal);
  const warnings: string[] = [];

  if (bytes.byteLength === 0) {
    throw new RequestError(422, "The image is empty (0 bytes)");
  }
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new RequestError(
      413,
      `Image is ${bytes.byteLength} bytes; the hard limit is ${MAX_ATTACHMENT_BYTES} bytes (${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MiB). Downscale it.`,
    );
  }
  const sniffed = sniffImage(bytes);
  if (!sniffed) {
    const hint = looksLikeSvg(bytes)
      ? "SVG is not accepted; rasterise it to PNG first"
      : `content is not a recognised image (declared type: ${declaredType || "none"})`;
    throw new RequestError(
      415,
      `Only ${ALLOWED_IMAGE_MIMES.join(", ")} are accepted: ${hint}`,
    );
  }
  const advisory = (req.mimetype ?? "").split(";")[0].trim().toLowerCase();
  if (advisory && advisory !== sniffed.mime) {
    warnings.push(`Declared mimetype ${advisory} ignored; the bytes are ${sniffed.mime}.`);
  }
  if (bytes.byteLength > SOFT_ATTACHMENT_BYTES) {
    warnings.push(
      `Image is ${bytes.byteLength} bytes, above the ${SOFT_ATTACHMENT_BYTES / (1024 * 1024)} MiB soft limit; consider downscaling.`,
    );
  }

  if (req.file_path) {
    const ext = pathExt(req.file_path);
    if (MIME_BY_EXT[ext] !== sniffed.mime) {
      throw new RequestError(
        400,
        `file_path extension .${ext} does not match the image type ${sniffed.mime} (use .${sniffed.ext})`,
      );
    }
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");

  // Dedup by content, unless the caller explicitly wants these bytes at this
  // path (overwrite) — then the path is the intent, not the bytes.
  const wantsOverwrite = Boolean(req.overwrite && req.file_path);
  if (!wantsOverwrite) {
    const existing = await deps.findByHash(req.folder, sha256, signal);
    if (existing) {
      console.log(
        `[attachments] dedup ${req.folder}${existing.path} sha256=${sha256} bytes=${bytes.byteLength}`,
      );
      return {
        path: existing.path,
        uuid: existing.uuid,
        doc_id: existing.doc_id,
        sha256,
        bytes: bytes.byteLength,
        mimetype: sniffed.mime,
        created: false,
        overwritten: false,
        deduplicated_from: existing.path,
        warnings,
      };
    }
  }

  const stem = req.stem ?? (req.url ? stemFromUrl(req.url) : "image");
  const inFolderPath = req.file_path ?? `/attachments/${stem}-${sha256.slice(0, 8)}.${sniffed.ext}`;

  let result: RelayAttachmentResult;
  try {
    result = await deps.upload(req.folder, inFolderPath, bytes, sniffed.mime, signal, {
      overwrite: req.overwrite,
    });
  } catch (err) {
    if (err instanceof RelayAttachmentConflictError) {
      throw new RequestError(
        409,
        `${req.folder}${inFolderPath} already holds different bytes (sha256 ${err.existingHash}). Pass overwrite:true to replace them or choose another name.`,
        { existing_hash: err.existingHash, path: inFolderPath },
      );
    }
    throw err;
  }
  console.log(
    `[attachments] ${result.overwritten ? "overwrote" : result.created ? "created" : "unchanged"} ${req.folder}${inFolderPath} sha256=${sha256} bytes=${bytes.byteLength} ${sniffed.mime}`,
  );
  return {
    path: inFolderPath,
    uuid: result.uuid,
    doc_id: result.doc_id,
    sha256,
    bytes: bytes.byteLength,
    mimetype: sniffed.mime,
    created: result.created,
    overwritten: result.overwritten,
    // Same bytes already sat at exactly this path: report it as the source.
    deduplicated_from: !result.created && !result.overwritten ? inFolderPath : null,
    warnings,
  };
}

/**
 * `POST /api/attachments/import` — the server side of the relay MCP
 * `import_attachment` tool. Same auth as add-article: the caller's edit
 * share token as Bearer.
 */
export function createAttachmentRoutes(
  deps: AttachmentRouteDeps = defaultAttachmentRouteDeps(),
  opts: { maxBodyBytes?: number } = {},
): Hono {
  const router = new Hono();
  router.use("/*", requireEduEditShareToken());
  router.use(
    "/*",
    bodyLimit({
      maxSize: opts.maxBodyBytes ?? MAX_REQUEST_BODY_BYTES,
      onError: (c) =>
        c.json({ error: `Request body exceeds ${opts.maxBodyBytes ?? MAX_REQUEST_BODY_BYTES} bytes` }, 413),
    }),
  );

  router.post("/import", async (c) => {
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch (err) {
      // Streamed bodies over the cap surface here; let bodyLimit turn the
      // error into its 413 (content-length'd bodies are rejected earlier).
      if (err instanceof Error && err.name === "BodyLimitError") throw err;
    }
    const payload = shareTokenPayload(c);
    try {
      const result = await importAttachment(
        body,
        deps,
        (folderName) => tokenAllowsFolderName(payload, folderName),
        c.req.raw.signal,
      );
      return c.json(result);
    } catch (err) {
      if (err instanceof RequestError) {
        return c.json({ error: err.message, ...err.extra }, err.status);
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[attachments] import failed: ${msg}`);
      return c.json({ error: `Attachment import failed: ${msg}` }, 500);
    }
  });

  return router;
}
