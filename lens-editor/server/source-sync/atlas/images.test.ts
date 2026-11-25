import sharp from "sharp";
import { describe, expect, it } from "vitest";
import limits from "../../../shared/attachment-limits.json";
import { PermanentImageError } from "../types";
import { hostable, MAX_WIDTH, toWebp } from "./images";

const png = async (width: number) => new Uint8Array(await sharp({ create: { width, height: 40, channels: 3, background: "#3a7" } }).png().toBuffer());
const jpeg = async (width: number) => new Uint8Array(await sharp({ create: { width, height: 40, channels: 3, background: "#a37" } }).jpeg().toBuffer());

/** A 1x1 GIF of two frames: colour 0, then colour 1. */
function animatedGif(): Uint8Array {
  const frame = (lzw: number) => [0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x02, 0x02, lzw, 0x01, 0x00];
  const netscapeLoop = [0x21, 0xff, 0x0b, ...Buffer.from("NETSCAPE2.0"), 0x03, 0x01, 0x00, 0x00, 0x00];
  return Uint8Array.from([...Buffer.from("GIF89a"), 1, 0, 1, 0, 0x80, 0, 0, 0xff, 0, 0, 0, 0, 0xff, ...netscapeLoop, ...frame(0x44), ...frame(0x4c), 0x3b]);
}

const meta = (bytes: Uint8Array) => sharp(bytes, { animated: true }).metadata();

describe("toWebp", () => {
  it("makes PNG and JPEG WebP, no wider than MAX_WIDTH and never wider than they were", async () => {
    const wide = await toWebp(await png(2400), "image/png");
    expect(wide.mime).toBe("image/webp");
    expect(await meta(wide.bytes)).toMatchObject({ format: "webp", width: MAX_WIDTH, height: 27 });
    expect(await meta((await toWebp(await png(800), "image/png")).bytes)).toMatchObject({ format: "webp", width: 800 });
    expect(await meta((await toWebp(await jpeg(300), "image/jpeg")).bytes)).toMatchObject({ format: "webp", width: 300 });
  });

  it("keeps an animated GIF animated", async () => {
    const out = await toWebp(animatedGif(), "image/gif");
    expect(await meta(out.bytes)).toMatchObject({ format: "webp", pages: 2 });
  });

  it("gives the same bytes for the same image, so the relay stores it once", async () => {
    const image = await png(2000);
    expect(Buffer.from((await toWebp(image, "image/png")).bytes).equals(Buffer.from((await toWebp(image, "image/png")).bytes))).toBe(true);
  });

  it("leaves any other type as it is", async () => {
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>");
    expect(await toWebp(svg, "application/octet-stream")).toEqual({ bytes: svg, mime: "application/octet-stream" });
  });
});

describe("hostable", () => {
  const fails = async () => {
    throw new Error("VipsJpeg: premature end of input");
  };

  it("hosts the original when it cannot be converted but fits, and says so", async () => {
    const notes: string[] = [];
    const image = await png(10);
    expect(await hostable(image, fails, (note) => notes.push(note))).toBe(image);
    expect(notes).toEqual([`could not be made smaller (VipsJpeg: premature end of input); it is hosted as it is, 0.0 MB`]);
  });

  it("leaves out an image that cannot be made to fit, without failing the run", async () => {
    const huge = new Uint8Array(limits.max_bytes + 1);
    await expect(hostable(huge, fails, () => {})).rejects.toThrow(PermanentImageError);
    await expect(hostable(huge, fails, () => {})).rejects.toThrow("could not be made smaller (VipsJpeg: premature end of input), and at 20.0 MB it is over the relay's 20.0 MB limit");
    await expect(hostable(new Uint8Array(3), async () => ({ bytes: huge, mime: "image/webp" }), () => {})).rejects.toThrow("is 20.0 MB even as WebP, over the relay's 20.0 MB limit");
  });
});
