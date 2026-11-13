/**
 * The Atlas's figures made small before they are hosted. Every hosted byte
 * lands in the content repository that every platform server clones, and
 * the Docs hold 222 MB of images (13 Nov 2026): 15 GIFs are 149 MB of it,
 * and two are over the relay's 20 MiB limit, so those figures would have no
 * image at all. As WebP no more than 1600 px wide they come to 90 MB, none
 * over the limit (348 images in about 70 s on one core of a developer's
 * machine).
 */

import type sharpModule from "sharp";
import limits from "../../../shared/attachment-limits.json";
import { sniffImage } from "../../attachments/image-types";
import { PermanentImageError } from "../types";

type Sharp = typeof sharpModule;

/** Wider than Lens shows any figure; a smaller image is never enlarged. */
export const MAX_WIDTH = 1600;
/** WebP quality for a still image (PNG, JPEG, one-frame GIF), and for an animated GIF, where frames add up. */
const STILL_QUALITY = 85;
const ANIMATED_QUALITY = 70;

export interface ImageBytes {
  bytes: Uint8Array;
  mime: string;
}

/** Turn an image into what is hosted; the seam tests replace. */
export type ToWebp = (bytes: Uint8Array, mime: string) => Promise<ImageBytes>;

/**
 * Above sharp's default of 268 million pixels, which a 450-frame GIF of the
 * Docs (2048 x 1152 a frame, 1,062 million in all) passes; still a bound on
 * what one image may make the converter decode.
 */
const MAX_INPUT_PIXELS = 2_000_000_000;

/**
 * sharp, loaded on first use: a native module that fails to load then fails
 * the images it is asked for, never the server's start. Production runs the
 * relay on the same 2 vCPUs, and a busy box starves it: one conversion at a
 * time, on one thread, and no libvips cache held between conversions (a
 * first run's GIFs would otherwise peak near 1 GB).
 */
let loaded: Promise<Sharp> | null = null;
const loadSharp = () =>
  (loaded ??= import("sharp").then((module) => {
    const sharp = ((module as unknown as { default?: Sharp }).default ?? module) as Sharp;
    sharp.concurrency(1);
    sharp.cache(false);
    return sharp;
  }));
let queue: Promise<unknown> = Promise.resolve();

/** PNG and JPEG to WebP, an animated GIF to animated WebP, each at most MAX_WIDTH wide. Any other type as it is. */
export const toWebp: ToWebp = (bytes, mime) => {
  const converted = queue.then(() => convert(bytes, mime));
  queue = converted.catch(() => undefined);
  return converted;
};

async function convert(bytes: Uint8Array, mime: string): Promise<ImageBytes> {
  if (mime !== "image/png" && mime !== "image/jpeg" && mime !== "image/gif") return { bytes, mime };
  const sharp = await loadSharp();
  const image = sharp(bytes, { animated: mime === "image/gif", limitInputPixels: MAX_INPUT_PIXELS });
  const { pages = 1 } = await image.metadata();
  const out = await image
    .resize({ width: MAX_WIDTH, withoutEnlargement: true })
    .webp({ quality: pages > 1 ? ANIMATED_QUALITY : STILL_QUALITY })
    .toBuffer();
  return { bytes: new Uint8Array(out), mime: "image/webp" };
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/**
 * The bytes to host for an image of a Doc: converted, or, when conversion
 * fails, the original if the relay can take it. An image that cannot be
 * made to fit throws a PermanentImageError: the article is written without
 * it and the run warns, because one image never fails a run.
 */
export async function hostable(bytes: Uint8Array, convert: ToWebp, note: (warning: string) => void): Promise<Uint8Array> {
  const mime = sniffImage(bytes)?.mime ?? "application/octet-stream";
  let out: Uint8Array;
  try {
    out = (await convert(bytes, mime)).bytes;
  } catch (err) {
    const reason = (err as Error).message;
    if (bytes.length > limits.max_bytes) throw new PermanentImageError(`could not be made smaller (${reason}), and at ${mb(bytes.length)} it is over the relay's ${mb(limits.max_bytes)} limit`);
    note(`could not be made smaller (${reason}); it is hosted as it is, ${mb(bytes.length)}`);
    return bytes;
  }
  if (out.length > limits.max_bytes) throw new PermanentImageError(`is ${mb(out.length)} even as WebP, over the relay's ${mb(limits.max_bytes)} limit`);
  return out;
}
