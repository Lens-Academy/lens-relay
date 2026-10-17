/**
 * Make an Iliad figure hostable. The Lens attachment store takes png, jpeg,
 * gif and webp only (SVG is refused: it is served raw from a public repo),
 * and most Iliad figures are SVG: TikZ and matplotlib output, and a few
 * Excalidraw drawings. Raster figures pass through; SVG is drawn to PNG.
 *
 * The SVG comes from a public website this server does not control. It is
 * therefore drawn in a process of its own, which is killed past a time and a
 * memory limit, and only when it points at nothing outside itself and the
 * pictures inside it are of a sane size.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sniffImage, type ImageExt } from "../../attachments/image-types";
import { PermanentImageError } from "../types";

/**
 * Pixel width of a rasterised figure. iliad-intensive.org stretches every
 * figure to its text column (the SVGs carry their TeX size in pt, which is
 * far too small on a page), so one width for all is the faithful size, and
 * this one stays sharp in a 900 px column on a 2x screen.
 */
export const FIGURE_WIDTH = 1800;
/** A figure taller than this is fitted by height instead, so a portrait drawing cannot grow without bound. */
const FIGURE_MAX_HEIGHT = 2700;
/** The largest SVG that is drawn: four times the largest figure of the course (4 MB). */
export const MAX_SVG_BYTES = 16 * 1024 * 1024;
/**
 * How long one SVG may take to draw, the start of the process included. The
 * slowest figure of the course needs under half a second. One filter on a
 * few rectangles can need a minute, and resvg cannot be stopped from inside.
 */
export const DRAW_TIME_LIMIT_MS = 20_000;
/**
 * How much memory the renderer may use. Drawing a figure of the course takes
 * at most 124 MB. A filter region a few hundred times its shape takes 20 GB
 * in four seconds, so the renderer watches itself (see figures-render.mjs).
 */
export const DRAW_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;
/**
 * The most pixels the pictures inside one SVG may have together, decoded:
 * 16 million, 64 MB as RGBA. The figures of the course carry 0.1 million;
 * a 400 KB PNG can say it has 144 million, and resvg decodes it in full.
 */
export const MAX_EMBEDDED_PIXELS = 16_000_000;

const RENDERER = join(dirname(fileURLToPath(import.meta.url)), "figures-render.mjs");

export interface HostableImage {
  bytes: Uint8Array;
  /** The type of `bytes`, decided from its first bytes, never from the path. */
  ext: ImageExt;
  /** What the PNG does not carry over faithfully from the SVG, for the run's warnings; null when nothing. */
  warning: string | null;
}

export interface DrawOptions {
  /** For tests: a shorter limit than DRAW_TIME_LIMIT_MS. */
  timeLimitMs?: number;
  /** For tests: a lower limit than DRAW_MEMORY_LIMIT_BYTES. */
  memoryLimitBytes?: number;
  /** For tests: false draws as a machine with no font installed does. */
  systemFonts?: boolean;
}

/**
 * The figure as bytes the attachment store accepts. `sitePath` names the
 * figure in errors and warnings. It fails in two ways, which the caller
 * treats differently:
 *
 * - PermanentImageError: this figure cannot be hosted from this state of the
 *   site, and the lens links to it on the site instead. The bytes are no
 *   image, or one of a type the store does not take; or the SVG is over
 *   MAX_SVG_BYTES, points outside itself, carries pictures of more than
 *   MAX_EMBEDDED_PIXELS, cannot be drawn, or was not drawn within the time
 *   or memory limit. Iliad's next commit tries the figure again.
 * - Error: the run must fail. This machine cannot draw: it has no font for
 *   the figure's text, or the renderer does not start. Every figure with
 *   lettering would become a link, and the defect is ours to repair.
 */
export async function toHostableImage(bytes: Uint8Array, sitePath: string, options: DrawOptions = {}): Promise<HostableImage> {
  const raster = sniffImage(bytes);
  if (raster) return { bytes, ext: raster.ext, warning: null };
  if (!rootIsSvg(new TextDecoder().decode(bytes.subarray(0, 64 * 1024)))) {
    throw new PermanentImageError(`${sitePath} is not a png, jpeg, gif, webp or svg image`);
  }
  if (bytes.byteLength > MAX_SVG_BYTES) {
    throw new PermanentImageError(`${sitePath} is an SVG of ${bytes.byteLength} bytes; the largest that is drawn has ${MAX_SVG_BYTES}`);
  }
  const svg = new TextDecoder().decode(bytes);
  const outside = outsideReference(svg);
  if (outside !== null) {
    throw new PermanentImageError(`${sitePath} points at something outside itself (${outside.slice(0, 80)}); such an SVG is not drawn`);
  }
  const pixels = embeddedPixels(svg);
  if (pixels === null) throw new PermanentImageError(`${sitePath} has a picture inside it whose size cannot be read; such an SVG is not drawn`);
  if (pixels > MAX_EMBEDDED_PIXELS) {
    throw new PermanentImageError(`${sitePath} has pictures of ${pixels} pixels inside it; the most that is drawn is ${MAX_EMBEDDED_PIXELS}`);
  }

  const hasText = /<(?:[\w.-]+:)?text[\s>]/.test(svg);
  const timeLimitMs = options.timeLimitMs ?? DRAW_TIME_LIMIT_MS;
  const drawn = await oneAtATime(() =>
    draw(svg, timeLimitMs, {
      width: FIGURE_WIDTH,
      maxHeight: FIGURE_MAX_HEIGHT,
      // The SVGs are transparent with dark lettering; the source site puts
      // white behind them, and a Lens page is not always white.
      background: "#ffffff",
      // TikZ and most matplotlib figures carry their lettering as outlines.
      // The rest have real <text>, drawn with a font of this machine.
      systemFonts: options.systemFonts ?? true,
      hasText,
      memoryLimitBytes: options.memoryLimitBytes ?? DRAW_MEMORY_LIMIT_BYTES,
      // The renderer ends itself then, in case this process is no longer there to kill it.
      giveUpAfterMs: timeLimitMs + 2000,
    }),
  );

  if (drawn.timedOut) throw new PermanentImageError(`${sitePath} was not drawn within ${timeLimitMs / 1000} s`);
  if (drawn.code === 3) {
    throw new Error(`${sitePath} has text, and this machine has no font to draw it with (install a font package, e.g. DejaVu)`);
  }
  // Exit 2 is resvg refusing the SVG. A signal is the renderer stopped by its memory limit, or resvg crashing.
  if (drawn.code === 2 || drawn.signal) throw new PermanentImageError(`${sitePath} could not be drawn: ${drawn.stderr || drawn.signal}`);
  if (drawn.code !== 0) throw new Error(`${sitePath}: the SVG renderer did not run (exit ${drawn.code}): ${drawn.stderr.slice(0, 300)}`);
  return {
    bytes: new Uint8Array(drawn.png),
    ext: "png",
    // Excalidraw embeds its hand-drawn font as @font-face data, which resvg does not read.
    warning: hasText && svg.includes("@font-face") ? `${sitePath}: text drawn in a substitute font (the SVG embeds its own)` : null,
  };
}

/**
 * The pixels of all pictures carried inside an SVG as `data:` URIs, read
 * from their headers; null when a picture's size cannot be read. resvg
 * decodes such a picture in full whatever size it is drawn at. Only PNG,
 * JPEG, GIF and WebP are decoded by resvg, so only they count; the type is
 * read from the bytes, as resvg does, not from the URI.
 */
function embeddedPixels(svg: string): number | null {
  let total = 0;
  for (const [, base64, payload] of svg.matchAll(/data:[^,"')\s]*?(;base64)?,([^"')]*)/gi)) {
    const data = base64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponentSafe(payload), "latin1");
    if (!sniffImage(data)) continue;
    const size = pictureSize(data);
    if (!size) return null;
    total += size.width * size.height;
  }
  return total;
}

function decodeURIComponentSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Width and height from the header of a PNG, JPEG, GIF or WebP picture; null when the header does not say. */
function pictureSize(data: Buffer): { width: number; height: number } | null {
  const at = (offset: number, length: number) => (data.length >= offset + length ? data : null);
  // PNG: the IHDR chunk comes first.
  if (data[0] === 0x89) return at(16, 8) && { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  // GIF: the logical screen.
  if (data[0] === 0x47) return at(6, 4) && { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  // WebP: a lossy, lossless or extended first chunk.
  if (data[0] === 0x52) {
    const chunk = data.toString("latin1", 12, 16);
    if (chunk === "VP8 ") return at(26, 4) && { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") return at(21, 4) && { width: 1 + (data.readUInt32LE(21) & 0x3fff), height: 1 + ((data.readUInt32LE(21) >>> 14) & 0x3fff) };
    if (chunk === "VP8X") return at(24, 6) && { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
    return null;
  }
  // JPEG: the first start-of-frame segment, after any others.
  for (let offset = 2; offset + 9 < data.length; ) {
    if (data[offset] !== 0xff) return null;
    const marker = data[offset + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) };
    }
    offset += 2 + data.readUInt16BE(offset + 2);
  }
  return null;
}

/**
 * Whether the document's root element is `<svg>`, or `<svg:svg>` with a
 * namespace prefix. An XML declaration, comments and a DOCTYPE may come
 * before it. A page of HTML is not SVG, also when it has an `<svg>` inside.
 */
function rootIsSvg(text: string): boolean {
  let at = 0;
  /** Move to after the next `close` that comes at or after `from`. */
  const moveAfter = (close: string, from: number) => {
    const end = text.indexOf(close, from);
    at = end < 0 ? text.length : end + close.length;
  };
  for (;;) {
    while (at < text.length && /[\s\uFEFF]/.test(text[at])) at++;
    if (text.startsWith("<?", at)) moveAfter("?>", at + 2);
    else if (text.startsWith("<!--", at)) moveAfter("-->", at + 4);
    else if (/^<!DOCTYPE/i.test(text.slice(at, at + 9))) {
      // A DOCTYPE ends at ">", after its "[...]" of declarations when it has one.
      const declarations = text.indexOf("[", at);
      const hasDeclarations = declarations >= 0 && declarations < text.indexOf(">", at);
      moveAfter(">", hasDeclarations ? Math.max(text.indexOf("]", declarations), declarations) : at);
    } else return /^<(?:[\w.-]+:)?svg[\s>]/.test(text.slice(at, at + 64));
  }
}

/** What an SVG may point at: a part of itself ("#id"), or data it carries. */
const INSIDE = /^\s*(#|data:)/i;

/**
 * The first thing in an SVG that points outside the file, or null. resvg
 * reads an `<image href>` that is a file path from this server's disk and
 * draws it into the PNG, and it has no switch for that. So every `href` and
 * every CSS `url()` must point inside, and the constructs that bring in
 * another document are refused whole. A value written with character
 * references or CSS escapes does not start with "#" or "data:" as text, so
 * it is refused too.
 */
function outsideReference(svg: string): string | null {
  for (const [, double, single] of svg.matchAll(/[\s"'](?:[\w.-]+:)?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    if (!INSIDE.test(double ?? single)) return double ?? single;
  }
  for (const [, , target] of svg.matchAll(/url\(\s*(["']?)([^)]*?)\1\s*\)/gi)) {
    if (!INSIDE.test(target)) return `url(${target})`;
  }
  return /@import|<!ENTITY|<\?xml-stylesheet/i.exec(svg)?.[0] ?? null;
}

let last: Promise<unknown> = Promise.resolve();

/** Draw one figure at a time: the production server has two CPUs, and it also serves the editor. */
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = last.then(work, work);
  last = run.catch(() => undefined);
  return run;
}

interface Drawn {
  png: Buffer;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

/** Run figures-render.mjs on one SVG, and kill it when it takes longer than `timeLimitMs`. */
function draw(svg: string, timeLimitMs: number, options: Record<string, unknown>): Promise<Drawn> {
  return new Promise((resolve, reject) => {
    // `node` itself, not the command this server was started with.
    const child = spawn(process.execPath, [RENDERER, JSON.stringify(options)], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeLimitMs);

    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    // A child that ends early closes its stdin; its exit says why.
    child.stdin.on("error", () => undefined);
    child.on("error", (cause) => {
      clearTimeout(timer);
      reject(new Error(`the SVG renderer did not start: ${cause.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ png: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8").trim(), code, signal: timedOut ? null : signal, timedOut });
    });
    child.stdin.end(svg);
  });
}
