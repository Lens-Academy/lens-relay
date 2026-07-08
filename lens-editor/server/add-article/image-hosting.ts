/**
 * Rehost a converted article's remote figure images as relay attachments.
 *
 * ar5iv/arXiv figure URLs (…/assets/x1.png) are mirror-hosted hotlinks: the
 * blind eval docked every figure-bearing arXiv item for leaving them external
 * (they also rot when ar5iv regenerates). This walks the Markdown's
 * `![alt](https://…)` images, downloads the ones on allowed hosts, uploads
 * them through the same attachment endpoint the PDF path uses, and rewrites
 * the embed to `![[/attachments/…]]`. Any failure keeps the original external
 * URL — hosting is an upgrade, never a gate.
 */

// URL may contain one level of balanced parentheses (Wikipedia "File:(x).png",
// signed CDN URLs) — a bare [^)]+ would truncate at the first ")" and leave a
// stray paren in the body.
import { createHash } from "node:crypto";

const IMG_MD_RE = /!\[[^\]]*\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/g;

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

function extFor(url: string, contentType: string): string | null {
  const mime = contentType.split(";")[0].trim().toLowerCase();
  if (EXT_BY_MIME[mime]) return EXT_BY_MIME[mime];
  const m = url.toLowerCase().match(/\.(png|jpe?g|gif|webp)(\?|$)/);
  if (m) return m[1] === "jpeg" ? "jpg" : m[1];
  return null; // svg/unknown — leave external
}

export interface HostImagesOptions {
  /** Hosts whose images get rehosted (match on hostname). */
  hostPattern: RegExp;
  fetchImage: (
    url: string,
  ) => Promise<{ bytes: ArrayBuffer; contentType: string }>;
  upload: (
    inFolderPath: string,
    data: Buffer,
    mimetype: string,
  ) => Promise<void>;
  maxImages?: number;
  maxBytesPerImage?: number;
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
      const h8 = createHash("sha1").update(buf).digest("hex").slice(0, 8);
      const inFolderPath = `/attachments/${slugBase}-img${n + 1}-${h8}.${ext}`;
      const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      await opts.upload(inFolderPath, buf, mime);
      n += 1; // only successful uploads consume a number (no gaps)
      // Replace every embed of this URL; alt text doesn't survive a wikilink
      // embed (platform convention, same as the PDF figure path).
      out = out.replace(
        new RegExp(`!\\[[^\\]]*\\]\\(${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`, "g"),
        `![[${inFolderPath}]]`,
      );
    } catch (err) {
      console.warn(`[add-article] image rehost failed, keeping external: ${url} (${err})`);
    }
  }
  return out;
}

/** Hosts we rehost from: arXiv + ar5iv asset mirrors. */
export const ARXIV_IMAGE_HOSTS = /(^|\.)(arxiv\.org|ar5iv\.org|ar5iv\.labs\.arxiv\.org)$/i;
