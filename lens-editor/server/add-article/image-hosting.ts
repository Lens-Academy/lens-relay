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
   *  never read whole) and when `signal` aborts. */
  fetchImage: (
    url: string,
    maxBytes: number,
    signal?: AbortSignal,
  ) => Promise<{ bytes: ArrayBuffer; contentType: string }>;
  upload: (
    inFolderPath: string,
    data: Buffer,
    mimetype: string,
  ) => Promise<unknown>;
  maxBytesPerImage?: number;
  /** Limits for the whole article. Pass one budget to every call for the
   *  same article (its review candidates) so they share it. */
  budget?: ImageBudget;
  /** Downloads ahead of the uploader, so at most this many images are held. */
  concurrency?: number;
  /** Ends the image phase: unfinished images stay external. */
  signal?: AbortSignal;
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

/** What one article may upload, and what it has used so far. */
export interface ImageBudget {
  maxImages: number;
  maxBytes: number;
  usedImages: number;
  usedBytes: number;
}

export function newImageBudget(maxImages = 30, maxBytes = 50 * 1024 * 1024): ImageBudget {
  return { maxImages, maxBytes, usedImages: 0, usedBytes: 0 };
}

const DEFAULT_MAX_BYTES_PER_IMAGE = 5 * 1024 * 1024;

export async function hostRemoteImages(
  body: string,
  slugBase: string,
  opts: HostImagesOptions,
): Promise<string> {
  const maxBytes = opts.maxBytesPerImage ?? DEFAULT_MAX_BYTES_PER_IMAGE;
  const budget = opts.budget ?? newImageBudget();
  const concurrency = Math.max(1, opts.concurrency ?? 4);
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

  const spent = () => budget.usedImages >= budget.maxImages || budget.usedBytes >= budget.maxBytes;
  const stopReason = () =>
    opts.signal?.aborted
      ? "image hosting time limit reached"
      : budget.usedImages >= budget.maxImages
        ? "over the article's image limit"
        : "over the article's byte budget";

  // Downloads run at most `concurrency` ahead of the uploader below, which
  // works in order of appearance (stable img<n> numbering). None start once
  // the budget is spent or the phase is over, and each is dropped after use,
  // so at most `concurrency` images are held at once.
  const toFetch = urls.filter((url) => !opts.cache?.has(url));
  const downloads = new Map<string, Promise<{ bytes: ArrayBuffer; contentType: string }>>();
  let started = 0;
  const fillWindow = () => {
    const room = () =>
      Math.min(concurrency, budget.maxImages - budget.usedImages) - downloads.size;
    while (started < toFetch.length && room() > 0 && !spent() && !opts.signal?.aborted) {
      const url = toFetch[started++];
      const p = Promise.resolve().then(() => opts.fetchImage(url, maxBytes, opts.signal));
      p.catch(() => {}); // awaited below; never an unhandled rejection
      downloads.set(url, p);
    }
  };

  let out = body;
  let hosted = 0;
  for (const url of urls) {
    let publicUrl = opts.cache?.get(url);
    if (!publicUrl) {
      fillWindow();
      const download = downloads.get(url);
      if (!download) {
        kept.push({ url, reason: stopReason() });
        continue;
      }
      try {
        const { bytes } = await download;
        downloads.delete(url);
        const image = sniffImage(new Uint8Array(bytes));
        if (!image) {
          kept.push({ url, reason: "not a png, jpeg, gif or webp image" });
          continue;
        }
        if (bytes.byteLength > maxBytes) {
          kept.push({ url, reason: `larger than ${maxBytes} bytes` });
          continue;
        }
        if (spent() || budget.usedBytes + bytes.byteLength > budget.maxBytes) {
          kept.push({ url, reason: stopReason() });
          continue;
        }
        // Content-hash suffix — same cross-article aliasing guard as the PDF
        // figure path (the slug base predates filename collision resolution).
        // Numbered by what this article has already hosted, so the second
        // candidate continues the first one's numbering.
        const n = budget.usedImages;
        const inFolderPath = await uploadWithHashSuffix(
          (h) => `/attachments/${slugBase}-img${n + 1}-${h}.${image.ext}`,
          Buffer.from(bytes),
          image.mime,
          opts.upload,
        );
        budget.usedImages += 1;
        budget.usedBytes += bytes.byteLength;
        publicUrl = opts.publicUrl?.(inFolderPath) ?? attachmentPublicUrl(folder, inFolderPath) ?? undefined;
        if (!publicUrl) {
          console.warn(`[add-article] no public URL for folder; keeping external: ${url}`);
          kept.push({ url, reason: `folder ${folder} has no public attachment URL` });
          continue;
        }
        opts.cache?.set(url, publicUrl);
      } catch (err) {
        downloads.delete(url);
        const reason = opts.signal?.aborted
          ? "image hosting time limit reached"
          : err instanceof Error ? err.message : String(err);
        console.warn(`[add-article] image rehost failed, keeping external: ${url} (${reason})`);
        kept.push({ url, reason });
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
  if (kept.length > 0) {
    console.warn(`[add-article] ${kept.length} image(s) left external (${hosted} hosted)`);
  }
  opts.onResult?.({ hosted, kept });
  return out;
}
