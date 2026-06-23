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
  /** PNG bytes, ready to upload. */
  png: Buffer;
  /** Distance from the top of the page (smaller = higher); for ordering. */
  yTop: number;
  width: number;
  height: number;
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
  const viewportHeight = page.getViewport({ scale: 1 }).height;
  const ops = await page.getOperatorList();

  const stack: Matrix[] = [];
  let m: Matrix = [1, 0, 0, 1, 0, 0];
  const yTopByKey = new Map<string, number>();
  for (let i = 0; i < ops.fnArray.length; i += 1) {
    const fn = ops.fnArray[i];
    if (fn === OPS.save) stack.push([...m]);
    else if (fn === OPS.restore) m = stack.pop() ?? m;
    else if (fn === OPS.transform) m = mul(m, ops.argsArray[i] as Matrix);
    else if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject) {
      const key = (ops.argsArray[i] as unknown[])[0] as string;
      if (key && !yTopByKey.has(key)) {
        yTopByKey.set(key, Math.round(viewportHeight - m[5]));
      }
    }
  }

  return images.map((img) => ({
    png: encodePng(img.data, img.width, img.height, img.channels as 1 | 3 | 4),
    yTop: yTopByKey.get(img.key) ?? Number.MAX_SAFE_INTEGER,
    width: img.width,
    height: img.height,
  }));
}
