/**
 * Image type handling shared by every attachment writer (the MCP
 * import_attachment route, PDF figure hosting, arXiv rehosting).
 *
 * The allowlist is deliberately small: png, jpeg, gif, webp. SVG is rejected
 * because the file is served raw from a public repo (scripts, external
 * references); agents rasterise instead. Types are decided from magic bytes,
 * never from a declared content type or a URL extension.
 */

export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export type ImageExt = "png" | "jpg" | "gif" | "webp";

export const EXT_BY_MIME: Record<ImageMime, ImageExt> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export const MIME_BY_EXT: Record<string, ImageMime> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export const ALLOWED_IMAGE_MIMES = Object.keys(EXT_BY_MIME) as ImageMime[];

/** Normalised extension for a declared content type / URL, or null when it is
 *  not an allowed raster type (svg and unknown types stay external). */
export function extFor(url: string, contentType: string): ImageExt | null {
  const mime = contentType.split(";")[0].trim().toLowerCase();
  if (mime in EXT_BY_MIME) return EXT_BY_MIME[mime as ImageMime];
  const m = url.toLowerCase().match(/\.(png|jpe?g|gif|webp)(\?|$)/);
  if (m) return m[1] === "jpeg" ? "jpg" : (m[1] as ImageExt);
  return null;
}

/** Extension (lower-case, without dot) of a path's last segment, or "". */
export function pathExt(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  return sig.every((b, i) => bytes[offset + i] === b);
}

/**
 * Identify an image from its first bytes. Returns null for anything that is
 * not one of the allowed raster types (including SVG, PDF, HTML error pages
 * served with an image content type, etc.).
 */
export function sniffImage(
  bytes: Uint8Array,
): { mime: ImageMime; ext: ImageExt } | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: "image/png", ext: "png" };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  // "GIF87a" / "GIF89a"
  if (
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return { mime: "image/gif", ext: "gif" };
  }
  // "RIFF" <size> "WEBP"
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}

/** True when the first non-whitespace bytes look like SVG/XML markup — used
 *  only to give a clearer rejection message than "unknown type". */
export function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder("latin1")
    .decode(bytes.subarray(0, 512))
    .trimStart()
    .toLowerCase();
  return head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"));
}
