/**
 * Rehost a converted article's remote images as relay attachments.
 *
 * Hotlinked images rot: ar5iv regenerates its assets, sites redesign, CDNs
 * expire (the blind eval docked every figure-bearing arXiv item for leaving
 * them external), and the library should be self-contained. This walks the
 * Markdown's `![alt](https://…)` images, downloads them (any host unless
 * `hostPattern` narrows it; images already on the folder's public attachment
 * URL are left alone), uploads them through the same attachment endpoint the
 * PDF path uses, and rewrites the embed's destination to the attachment's
 * public raw URL (the platform renders only absolute image URLs). Any failure
 * keeps the original external URL — hosting is an upgrade, never a gate —
 * and is reported through `onResult`.
 *
 * Type detection, naming and the public URL come from `../attachments/`, the
 * same helpers the MCP import_attachment route uses.
 */

import { createHash } from "node:crypto";
import { RelayAttachmentConflictError } from "../add-video/relay-docs";
import { attachmentPublicUrl, publicBaseUrlForFolder } from "../attachments/public-url";
import { sniffImage } from "../attachments/image-types";

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
  /** Only rehost images on these hosts (match on hostname). Default: any host. */
  hostPattern?: RegExp;
  /** Top-level relay folder the attachments land in (default "Lens Edu");
   *  decides the public URL. */
  folder?: string;
  /** Download an image; must give up past `maxBytes` (oversized files are
   *  never read whole). */
  fetchImage: (
    url: string,
    maxBytes: number,
  ) => Promise<{ bytes: ArrayBuffer; contentType: string }>;
  upload: (
    inFolderPath: string,
    data: Buffer,
    mimetype: string,
  ) => Promise<unknown>;
  maxImages?: number;
  maxBytesPerImage?: number;
  /** Stop hosting once this many bytes are uploaded; the rest stay external. */
  maxTotalBytes?: number;
  /** Downloads in flight at once. */
  concurrency?: number;
  publicUrl?: (inFolderPath: string) => string;
  /** url -> hosted URL, shared between calls (the rendered and unrendered
   *  candidates of one import) so an image is downloaded and uploaded once. */
  cache?: Map<string, string>;
  /** What happened: images hosted, and each image left external with why. */
  onResult?: (result: HostImagesResult) => void;
}

export interface HostImagesResult {
  hosted: number;
  kept: { url: string; reason: string }[];
}

const DEFAULT_MAX_BYTES_PER_IMAGE = 5 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export async function hostRemoteImages(
  body: string,
  slugBase: string,
  opts: HostImagesOptions,
): Promise<string> {
  const maxImages = opts.maxImages ?? 30;
  const maxBytes = opts.maxBytesPerImage ?? DEFAULT_MAX_BYTES_PER_IMAGE;
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const folder = opts.folder ?? DEFAULT_FOLDER;
  const ownBase = publicBaseUrlForFolder(folder);
  const kept: HostImagesResult["kept"] = [];

  // Unique matching URLs, in order of first appearance.
  const urls: string[] = [];
  for (const m of body.matchAll(IMG_MD_RE)) {
    const url = m[1];
    if (urls.includes(url)) continue;
    if (ownBase && url.startsWith(`${ownBase}/`)) continue; // already ours
    try {
      const host = new URL(url).hostname;
      if (!opts.hostPattern || opts.hostPattern.test(host)) urls.push(url);
    } catch {
      /* unparseable URL — leave as-is */
    }
  }
  if (urls.length === 0) {
    opts.onResult?.({ hosted: 0, kept });
    return body;
  }
  if (urls.length > maxImages) {
    console.warn(
      `[add-article] ${urls.length} rehostable images; hosting the first ${maxImages}, leaving the rest external`,
    );
    for (const url of urls.slice(maxImages)) kept.push({ url, reason: `over the ${maxImages}-image limit` });
  }
  const todo = urls.slice(0, maxImages);

  // Download a few at a time (each fetch has its own timeout), upload in
  // order of appearance so the img<n> numbering stays stable.
  const downloads = new Map<string, Promise<{ bytes: ArrayBuffer; contentType: string }>>();
  const pending = todo.filter((url) => !opts.cache?.has(url));
  let next = 0;
  const gates: Promise<void>[] = [];
  const startNext = (): Promise<void> | undefined => {
    if (next >= pending.length) return undefined;
    const url = pending[next++];
    const p = opts.fetchImage(url, maxBytes);
    downloads.set(url, p);
    return p.then(
      () => startNext(),
      () => startNext(),
    );
  };
  for (let i = 0; i < Math.max(1, opts.concurrency ?? 4); i++) {
    const gate = startNext();
    if (gate) gates.push(gate);
  }

  let out = body;
  let n = 0;
  let hosted = 0;
  let totalBytes = 0;
  for (const url of todo) {
    let publicUrl = opts.cache?.get(url);
    if (!publicUrl) {
      try {
        const { bytes } = await downloads.get(url)!;
        const data = new Uint8Array(bytes);
        const image = sniffImage(data);
        if (!image) {
          kept.push({ url, reason: "not a png, jpeg, gif or webp image" });
          continue;
        }
        if (bytes.byteLength > maxBytes) {
          kept.push({ url, reason: `larger than ${maxBytes} bytes` });
          continue;
        }
        if (totalBytes + bytes.byteLength > maxTotalBytes) {
          kept.push({ url, reason: `over the ${maxTotalBytes}-byte budget for one article` });
          continue;
        }
        // Content-hash suffix — same cross-article aliasing guard as the PDF
        // figure path (the slug base predates filename collision resolution).
        const inFolderPath = await uploadWithHashSuffix(
          (h) => `/attachments/${slugBase}-img${n + 1}-${h}.${image.ext}`,
          Buffer.from(bytes),
          image.mime,
          opts.upload,
        );
        n += 1; // only successful uploads consume a number (no gaps)
        totalBytes += bytes.byteLength;
        publicUrl = opts.publicUrl?.(inFolderPath) ?? attachmentPublicUrl(folder, inFolderPath) ?? undefined;
        if (!publicUrl) {
          console.warn(`[add-article] no public URL for folder; keeping external: ${url}`);
          kept.push({ url, reason: `folder ${folder} has no public attachment URL` });
          continue;
        }
        opts.cache?.set(url, publicUrl);
      } catch (err) {
        console.warn(`[add-article] image rehost failed, keeping external: ${url} (${err})`);
        kept.push({ url, reason: err instanceof Error ? err.message : String(err) });
        continue;
      }
    }
    hosted += 1;
    // Preserve each image's alt text while replacing its destination.
    out = out.replace(
      new RegExp(`(!\\[[^\\]]*\\]\\()${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\))`, "g"),
      `$1${publicUrl}$2`,
    );
  }
  await Promise.all(gates);
  opts.onResult?.({ hosted, kept });
  return out;
}

/** Hosts we rehost from: arXiv + ar5iv asset mirrors. */
export const ARXIV_IMAGE_HOSTS = /(^|\.)(arxiv\.org|ar5iv\.org|ar5iv\.labs\.arxiv\.org)$/i;
