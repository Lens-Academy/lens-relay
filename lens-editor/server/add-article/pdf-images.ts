import zlib from "node:zlib";
import { extractImages, getResolvedPDFJS, getDocumentProxy } from "unpdf";

/**
 * Raster-image extraction for the PDF importer. `unpdf`/pdf.js gives raw pixel
 * data (no encoding, no position), so this module: (1) encodes raw pixels to PNG
 * with a dependency-free encoder (Node `zlib`), and (2) recovers each image's
 * on-page vertical position by tracking the CTM through the page operator list,
 * so the caller can place the figure where it actually sits in the text.
 */

// --- dependency-free PNG encoder (raw 8-bit pixels → PNG) ---

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Encode raw 8-bit pixels (channels: 1=grayscale, 3=RGB, 4=RGBA) as a PNG. */
export function encodePng(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  channels: 1 | 3 | 4,
): Buffer {
  const colorType = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  const stride = width * channels;
  const src = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // per-scanline filter byte: none
    src.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- per-page image extraction with positions ---

export interface PdfPageImage {
  /** Image bytes, ready to upload. PNG for locally-extracted figures; hosted
   *  PDF parsers may hand back JPEG/WebP (see `mime`). */
  png: Buffer;
  /** MIME type of `png`'s bytes; absent ⇒ image/png. */
  mime?: string;
  /** Distance from the top of the page (smaller = higher); for ordering.
   *  0 when unknown (provider-extracted images are already positioned in the
   *  markdown flow, so ordering by position is unnecessary). */
  yTop: number;
  width: number;
  height: number;
}

const MIN_FIGURE_PX = 64; // below this in either dimension ⇒ icon/glyph/bullet
const MAX_FIGURE_ASPECT = 12; // wider/taller than this ⇒ rule/divider/banner strip
const MAX_PAGE_COVERAGE = 0.9; // placed area this fraction of the page ⇒ background/cover

/**
 * Heuristic: is this raster page decoration rather than a content figure?
 * Designed documents (system cards, policy reports) embed full-page background
 * scans, logos, header rules and tiny glyphs as images; hosting every one of
 * them produces dozens of junk embeds. We drop rasters that are tiny (icons),
 * extreme-aspect (rules/dividers), or near page-sized (backgrounds/covers).
 * `placed*`/`page*` are in page units (from the CTM); when unknown, the
 * page-coverage test is skipped. Dimensions come from the image metadata, so
 * this runs before the (costlier) PNG encode.
 */
export function isLikelyDecorative(opts: {
  width: number;
  height: number;
  placedWidth?: number;
  placedHeight?: number;
  pageWidth?: number;
  pageHeight?: number;
}): boolean {
  const { width, height, placedWidth, placedHeight, pageWidth, pageHeight } = opts;
  if (width < MIN_FIGURE_PX || height < MIN_FIGURE_PX) return true;
  if (Math.max(width, height) / Math.min(width, height) > MAX_FIGURE_ASPECT) return true;
  if (placedWidth && placedHeight && pageWidth && pageHeight) {
    const coverage = (placedWidth * placedHeight) / (pageWidth * pageHeight);
    if (coverage > MAX_PAGE_COVERAGE) return true;
  }
  return false;
}

/** Image hashes occurring at least `minRepeat` times. An identical raster
 *  repeated across many pages is boilerplate (logo, running header, page
 *  background/template), not a figure — the caller drops every instance. */
export function repeatedImageHashes(hashes: string[], minRepeat: number): Set<string> {
  const counts = new Map<string, number>();
  for (const h of hashes) counts.set(h, (counts.get(h) ?? 0) + 1);
  return new Set(
    [...counts].filter(([, c]) => c >= minRepeat).map(([h]) => h),
  );
}

type Matrix = [number, number, number, number, number, number];

// Multiply two 2-D affine matrices (pdf.js [a,b,c,d,e,f] form).
const mul = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];

type PdfDoc = Awaited<ReturnType<typeof getDocumentProxy>>;

/**
 * Extract a page's raster images (PNG-encoded) with their on-page vertical
 * position. Position is recovered by replaying the operator list with a CTM
 * stack and reading the translation at each `paintImageXObject`. Images whose
 * position can't be determined sort to the end of the page.
 */
export async function extractPageImages(
  pdf: PdfDoc,
  pageNum: number,
): Promise<PdfPageImage[]> {
  const images = await extractImages(pdf, pageNum).catch(() => []);
  if (images.length === 0) return [];

  const { OPS } = await getResolvedPDFJS();
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1 });
  const ops = await page.getOperatorList();

  const stack: Matrix[] = [];
  let m: Matrix = [1, 0, 0, 1, 0, 0];
  const yTopByKey = new Map<string, number>();
  const sizeByKey = new Map<string, { w: number; h: number }>();
  for (let i = 0; i < ops.fnArray.length; i += 1) {
    const fn = ops.fnArray[i];
    if (fn === OPS.save) stack.push([...m]);
    else if (fn === OPS.restore) m = stack.pop() ?? m;
    else if (fn === OPS.transform) m = mul(m, ops.argsArray[i] as Matrix);
    // paintJpegXObject exists at runtime but is missing from pdf.js's OPS types.
    else if (
      fn === OPS.paintImageXObject ||
      fn === (OPS as Record<string, number>).paintJpegXObject
    ) {
      const key = (ops.argsArray[i] as unknown[])[0] as string;
      if (key && !yTopByKey.has(key)) {
        yTopByKey.set(key, Math.round(viewport.height - m[5]));
        // Placed size on the page = the CTM's column magnitudes (the image is
        // drawn in a unit square transformed by m).
        sizeByKey.set(key, { w: Math.hypot(m[0], m[1]), h: Math.hypot(m[2], m[3]) });
      }
    }
  }

  // Drop page decoration (backgrounds, logos, rules, glyphs) before encoding.
  return images
    .filter((img) => {
      const sz = sizeByKey.get(img.key);
      return !isLikelyDecorative({
        width: img.width,
        height: img.height,
        placedWidth: sz?.w,
        placedHeight: sz?.h,
        pageWidth: viewport.width,
        pageHeight: viewport.height,
      });
    })
    .map((img) => ({
      png: encodePng(img.data, img.width, img.height, img.channels as 1 | 3 | 4),
      yTop: yTopByKey.get(img.key) ?? Number.MAX_SAFE_INTEGER,
      width: img.width,
      height: img.height,
    }));
}
