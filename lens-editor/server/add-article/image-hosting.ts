/**
 * Rehost a converted article's remote figure images as relay attachments.
 *
 * ar5iv/arXiv figure URLs (…/assets/x1.png) are mirror-hosted hotlinks: the
 * blind eval docked every figure-bearing arXiv item for leaving them external
 * (they also rot when ar5iv regenerates). This walks the Markdown's
 * `![alt](https://…)` images, downloads the ones on allowed hosts, uploads
 * them through the same attachment endpoint the PDF path uses, and rewrites
 * the embed's destination to the attachment's public raw URL (the platform
 * renders only absolute image URLs). Any failure keeps the original external
 * URL — hosting is an upgrade, never a gate.
 *
 * Type detection, naming and the public URL come from `../attachments/`, the
 * same helpers the MCP import_attachment route uses.
 */

import { createHash } from "node:crypto";
import { RelayAttachmentConflictError } from "../add-video/relay-docs";
import { attachmentPublicUrl } from "../attachments/public-url";
import { extFor, MIME_BY_EXT } from "../attachments/image-types";

// URL may contain one level of balanced parentheses (Wikipedia "File:(x).png",
// signed CDN URLs) — a bare [^)]+ would truncate at the first ")" and leave a
// stray paren in the body.
const IMG_MD_RE = /!\[[^\]]*\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/g;

/** Folder the importer writes to when the caller does not say. */
const DEFAULT_FOLDER = "Lens Edu";

/**
 * Upload with the importer's content-hash naming. Names carry the first 8 hex
 * of the sha1 (`<base>.<ext>` -> `<base>-<h8>.<ext>`); on a 409 (a different
 * file already owns that name) the full 16-hex suffix is tried once before
 * giving up. Returns the in-folder path that was used.
 */
export async function uploadWithHashSuffix(
  makePath: (hashSuffix: string) => string,
  data: Buffer,
  mimetype: string,
  upload: (inFolderPath: string, data: Buffer, mimetype: string) => Promise<unknown>,
): Promise<string> {
  const sha1 = createHash("sha1").update(data).digest("hex");
  const attempts = [sha1.slice(0, 8), sha1.slice(0, 16)];
  let lastConflict: RelayAttachmentConflictError | null = null;
  for (const suffix of attempts) {
    const inFolderPath = makePath(suffix);
    try {
      await upload(inFolderPath, data, mimetype);
      return inFolderPath;
    } catch (err) {
      if (!(err instanceof RelayAttachmentConflictError)) throw err;
      lastConflict = err;
    }
  }
  throw lastConflict ?? new Error("attachment upload failed");
}

export interface HostImagesOptions {
  /** Hosts whose images get rehosted (match on hostname). */
  hostPattern: RegExp;
  /** Top-level relay folder the attachments land in (default "Lens Edu");
   *  decides the public URL. */
  folder?: string;
  fetchImage: (
    url: string,
  ) => Promise<{ bytes: ArrayBuffer; contentType: string }>;
  upload: (
    inFolderPath: string,
    data: Buffer,
    mimetype: string,
  ) => Promise<unknown>;
  maxImages?: number;
  maxBytesPerImage?: number;
  publicUrl?: (inFolderPath: string) => string;
}

export async function hostRemoteImages(
  body: string,
  slugBase: string,
  opts: HostImagesOptions,
): Promise<string> {
  const maxImages = opts.maxImages ?? 30;
  const maxBytes = opts.maxBytesPerImage ?? 5 * 1024 * 1024;

  // Unique matching URLs, in order of first appearance.
  const urls: string[] = [];
  for (const m of body.matchAll(IMG_MD_RE)) {
    const url = m[1];
    if (urls.includes(url)) continue;
    try {
      if (opts.hostPattern.test(new URL(url).hostname)) urls.push(url);
    } catch {
      /* unparseable URL — leave as-is */
    }
  }
  if (urls.length === 0) return body;
  if (urls.length > maxImages) {
    console.warn(
      `[add-article] ${urls.length} rehostable images; hosting the first ${maxImages}, leaving the rest external`,
    );
  }

  let out = body;
  let n = 0;
  for (const url of urls.slice(0, maxImages)) {
    try {
      const { bytes, contentType } = await opts.fetchImage(url);
      const ext = extFor(url, contentType);
      if (!ext || bytes.byteLength === 0 || bytes.byteLength > maxBytes) continue;
      const buf = Buffer.from(bytes);
      // Content-hash suffix — same cross-article aliasing guard as the PDF
      // figure path (the slug base predates filename collision resolution).
      const mime = MIME_BY_EXT[ext];
      const inFolderPath = await uploadWithHashSuffix(
        (h) => `/attachments/${slugBase}-img${n + 1}-${h}.${ext}`,
        buf,
        mime,
        opts.upload,
      );
      n += 1; // only successful uploads consume a number (no gaps)
      const publicUrl =
        opts.publicUrl?.(inFolderPath) ??
        attachmentPublicUrl(opts.folder ?? DEFAULT_FOLDER, inFolderPath);
      if (!publicUrl) {
        console.warn(`[add-article] no public URL for folder; keeping external: ${url}`);
        continue;
      }
      // Preserve each image's alt text while replacing its destination.
      out = out.replace(
        new RegExp(`(!\\[[^\\]]*\\]\\()${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\))`, "g"),
        `$1${publicUrl}$2`,
      );
    } catch (err) {
      console.warn(`[add-article] image rehost failed, keeping external: ${url} (${err})`);
    }
  }
  return out;
}

/** Hosts we rehost from: arXiv + ar5iv asset mirrors. */
export const ARXIV_IMAGE_HOSTS = /(^|\.)(arxiv\.org|ar5iv\.org|ar5iv\.labs\.arxiv\.org)$/i;
