import { spawn } from "node:child_process";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { PermanentImageError } from "../types";
import { DRAW_MEMORY_LIMIT_BYTES, DRAW_TIME_LIMIT_MS, FIGURE_WIDTH, MAX_EMBEDDED_PIXELS, MAX_SVG_BYTES, toHostableImage } from "./figures";

const bytesOf = (text: string) => new TextEncoder().encode(text);
const svgText = (width: number, height: number, inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${inner}</svg>`;
const svg = (width: number, height: number, inner: string) => bytesOf(svgText(width, height, inner));
const LINE = '<path d="M2 2 L50 18" stroke="#000" fill="none"/>';
/** A 1x1 PNG, as an SVG carries a picture inside itself. */
const DOT = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Size from a PNG's IHDR chunk, and its top-left pixel (resvg writes 8-bit RGBA). */
function png(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const data: Uint8Array[] = [];
  for (let at = 8; at < bytes.length; at += 12 + view.getUint32(at)) {
    if (String.fromCharCode(...bytes.subarray(at + 4, at + 8)) === "IDAT") data.push(bytes.subarray(at + 8, at + 8 + view.getUint32(at)));
  }
  // Byte 0 of a row is its filter; in the first row every filter leaves the first pixel as it is.
  return { width: view.getUint32(16), height: view.getUint32(20), corner: [...inflateSync(Buffer.concat(data)).subarray(1, 5)] };
}

/** How a call fails: the error, so a test can tell the two kinds apart. */
const failure = (work: Promise<unknown>): Promise<Error> =>
  work.then(
    () => {
      throw new Error("it did not fail");
    },
    (err: Error) => err,
  );

describe("toHostableImage", () => {
  it("returns raster images unchanged, typed by their first bytes", async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

    // The path's extension is not believed: this "svg" is a PNG.
    const image = await toHostableImage(pngBytes, "/uploads/aixi/roadmap.svg");
    expect(image).toEqual({ bytes: pngBytes, ext: "png", warning: null });
    expect(image.bytes).toBe(pngBytes);
    expect((await toHostableImage(jpeg, "/uploads/a/photo.jpeg")).ext).toBe("jpg");
    expect((await toHostableImage(bytesOf("GIF89a..."), "/uploads/a/loop.gif")).ext).toBe("gif");
    expect((await toHostableImage(bytesOf("RIFF1234WEBPVP8 "), "/uploads/a/plot.webp")).ext).toBe("webp");
  });

  it("draws an SVG to an opaque PNG as wide as the text column, the same bytes every time", async () => {
    const figure = svg(258.632, 206.295, LINE);
    const image = await toHostableImage(figure, "/uploads/aixi/tikz-4dc0e19d14b9.svg");
    expect(image).toMatchObject({ ext: "png", warning: null });
    // The SVG is transparent there; the PNG is white, so dark lettering shows on any page.
    expect(png(image.bytes)).toEqual({ width: FIGURE_WIDTH, height: 1436, corner: [255, 255, 255, 255] });
    // The lens embeds the image by a hash of its bytes: other bytes would be a change to write.
    expect(Buffer.from((await toHostableImage(figure, "/uploads/aixi/tikz-4dc0e19d14b9.svg")).bytes).equals(Buffer.from(image.bytes))).toBe(true);
  });

  it("fits a tall SVG by height", async () => {
    const image = await toHostableImage(svg(100, 400, LINE), "/uploads/a/tall.svg");
    expect(png(image.bytes)).toMatchObject({ width: 675, height: 2700 });
  });

  it("draws what the course's SVGs are made of: a prolog, a DOCTYPE, parts used by id, a picture and a font as data", async () => {
    const figure = bytesOf(
      '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' +
        svgText(
          60,
          20,
          `<defs><style>@font-face { font-family: Hand; src: url(data:font/woff2;base64,AAAA); }</style><clipPath id="clip"><rect width="60" height="20"/></clipPath><path id="glyph" d="M0 0 L4 8"/></defs>` +
            `<g clip-path="url(#clip)"><use xlink:href="#glyph" x="5" y="5"/><image width="10" height="10" xlink:href="${DOT}"/></g>`,
        ),
    );
    expect(png((await toHostableImage(figure, "/uploads/qft/zipf.svg")).bytes).width).toBe(FIGURE_WIDTH);
  });

  it("draws several figures asked for at once", async () => {
    const images = await Promise.all([1, 2, 3, 4].map((n) => toHostableImage(svg(60, 20 * n, LINE), `/uploads/a/${n}.svg`)));
    expect(images.map((image) => png(image.bytes).height)).toEqual([600, 1200, 1800, 2400]);
  });

  it("gives up for this commit on bytes that are no image, or an image the store does not take", async () => {
    const bmp = Uint8Array.from([0x42, 0x4d, 0x3a, 0, 0, 0, 0, 0, 0, 0, 0x36, 0, 0, 0, 0x28, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0x18, 0]);
    const others = [
      bytesOf("<!doctype html><html><body>Site under maintenance</body></html>"),
      // A page with a drawing in it is still a page.
      bytesOf('<!DOCTYPE html>\n<html><body><svg width="10" height="10"></svg> 404</body></html>'),
      bytesOf('{"error":"rate limited"}'),
      bytesOf(""),
      bmp,
      bytesOf("\x00\x00\x00\x1cftypavif"),
    ];
    for (const other of others) {
      const error = await failure(toHostableImage(other, "/uploads/aixi/tikz-4dc0e19d14b9.svg"));
      // The lens links to the figure on Iliad's site, and the run goes on: one figure must not stop the course.
      expect(error).toBeInstanceOf(PermanentImageError);
      expect(error.message).toBe("/uploads/aixi/tikz-4dc0e19d14b9.svg is not a png, jpeg, gif, webp or svg image");
    }
  });

  it("knows an SVG by its root element, whatever comes before it", async () => {
    const drawing = svgText(60, 20, LINE);
    for (const lead of ["\uFEFF", "<!-- Created with Inkscape -->\n", '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n', "<?xml version='1.0'?><!-- a -->\n<!-- b -->"]) {
      expect((await toHostableImage(bytesOf(lead + drawing), "/uploads/a/figure.svg")).ext, lead).toBe("png");
    }
    // A root with a namespace prefix.
    const prefixed = bytesOf('<?xml version="1.0"?><svg:svg xmlns:svg="http://www.w3.org/2000/svg" width="10" height="10"><svg:rect width="10" height="10"/></svg:svg>');
    expect(png((await toHostableImage(prefixed, "/uploads/a/prefixed.svg")).bytes).width).toBe(FIGURE_WIDTH);
  });

  it("gives up for good on an SVG that cannot be drawn", async () => {
    const error = await failure(toHostableImage(bytesOf("<svg><g></svg>"), "/uploads/aixi/broken.svg"));
    expect(error).toBeInstanceOf(PermanentImageError);
    expect(error.message).toMatch(/^\/uploads\/aixi\/broken\.svg could not be drawn: /);
  });

  it("refuses an SVG that points at anything outside itself, and does not draw the rest of it", async () => {
    const outside = [
      '<image width="60" height="20" xlink:href="/etc/hostname"/>', // a file of this server: resvg would draw it into the PNG
      '<image width="60" height="20" href="secrets/key.png"/>',
      '<image width="60" height="20" href="file:///etc/hostname"/>',
      '<image width="60" height="20" href="https://example.com/pixel.png"/>',
      "<image width='60' height='20' other:href = '//example.com/pixel.png'/>",
      '<image width="60" height="20" href="&#x2f;etc/hostname"/>',
      '<use href="other.svg#part"/>',
      '<rect width="60" height="20" fill="url(other.svg#gradient)"/>',
      '<rect width="60" height="20" style="filter: url( \'file:///tmp/f.svg#f\' )"/>',
      '<style>@import "https://example.com/style.css";</style>',
      '<style>@font-face { font-family: F; src: url("https://example.com/f.woff2"); }</style>',
    ];
    for (const part of outside) {
      const error = await failure(toHostableImage(svg(60, 20, LINE + part), "/uploads/a/figure.svg"));
      expect(error, part).toBeInstanceOf(PermanentImageError);
      expect(error.message, part).toMatch(/^\/uploads\/a\/figure\.svg points at something outside itself \(/);
    }
    const entity = bytesOf(`<!DOCTYPE svg [<!ENTITY file SYSTEM "file:///etc/hostname">]>${svgText(60, 20, "<text>&file;</text>")}`);
    expect(await failure(toHostableImage(entity, "/uploads/a/figure.svg"))).toBeInstanceOf(PermanentImageError);
  });

  it("refuses an SVG over the size limit", async () => {
    const huge = svg(60, 20, `<!--${" ".repeat(MAX_SVG_BYTES)}-->${LINE}`);
    const error = await failure(toHostableImage(huge, "/uploads/a/huge.svg"));
    expect(error).toBeInstanceOf(PermanentImageError);
    expect(error.message).toBe(`/uploads/a/huge.svg is an SVG of ${huge.byteLength} bytes; the largest that is drawn has 16777216`);
  });

  it("refuses an SVG whose pictures inside are larger than MAX_EMBEDDED_PIXELS, reading their size from their headers", async () => {
    // Headers only: the size is read from them, and these are never decoded.
    const png = (width: number, height: number) => {
      const header = Buffer.alloc(33);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(header);
      header.write("IHDR", 12, "latin1");
      header.writeUInt32BE(width, 16);
      header.writeUInt32BE(height, 20);
      return header;
    };
    const jpeg = (width: number, height: number) =>
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 0, 0, 0]);
    const gif = (width: number, height: number) => Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, width & 255, width >> 8, height & 255, height >> 8]);
    const webp = (width: number, height: number) => {
      const header = Buffer.alloc(30);
      header.write("RIFF\0\0\0\0WEBPVP8X", 0, "latin1");
      header.writeUIntLE(width - 1, 24, 3);
      header.writeUIntLE(height - 1, 27, 3);
      return header;
    };
    const holding = (...pictures: Buffer[]) =>
      svg(60, 20, pictures.map((p) => `<image width="10" height="10" href="data:image/png;base64,${p.toString("base64")}"/>`).join(""));

    for (const [name, bomb] of [["png", png(12_000, 12_000)], ["jpeg", jpeg(65_000, 65_000)], ["gif", gif(65_000, 65_000)], ["webp", webp(16_000, 16_000)]] as const) {
      const error = await failure(toHostableImage(holding(bomb), "/uploads/a/bomb.svg"));
      expect(error, name).toBeInstanceOf(PermanentImageError);
      expect(error.message, name).toMatch(/^\/uploads\/a\/bomb\.svg has pictures of \d+ pixels inside it; the most that is drawn is 16000000$/);
    }
    // They count together.
    expect(await failure(toHostableImage(holding(png(3000, 3000), png(3000, 3000)), "/uploads/a/two.svg"))).toBeInstanceOf(PermanentImageError);
    // A picture whose header is cut short cannot be measured.
    const error = await failure(toHostableImage(holding(png(10, 10).subarray(0, 12)), "/uploads/a/short.svg"));
    expect(error.message).toBe("/uploads/a/short.svg has a picture inside it whose size cannot be read; such an SVG is not drawn");
    // The figures of the course carry pictures of 0.1 million pixels.
    expect(MAX_EMBEDDED_PIXELS).toBe(16_000_000);
    expect((await toHostableImage(svg(60, 20, `<image width="10" height="10" href="${DOT}"/>`), "/uploads/a/dot.svg")).ext).toBe("png");
  });

  it("stops drawing an SVG that needs more memory than the limit", async () => {
    // 226 bytes: a filter region 400 times the size of its shape. resvg takes 20 GB for it, within four seconds.
    const greedy = bytesOf(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><defs><filter id="f" x="-200" y="-200" width="400" height="400"><feFlood flood-color="red"/></filter></defs><rect width="10" height="10" filter="url(#f)"/></svg>',
    );
    const started = Date.now();
    const error = await failure(toHostableImage(greedy, "/uploads/a/greedy.svg"));
    expect(error).toBeInstanceOf(PermanentImageError);
    expect(error.message).toBe("/uploads/a/greedy.svg could not be drawn: it needed more than 512 MB of memory");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(DRAW_MEMORY_LIMIT_BYTES).toBe(512 * 1024 * 1024);
  }, 20_000);

  it("kills the drawing of an SVG at the time limit, and the server stays free meanwhile", async () => {
    // 346 bytes that resvg works on for most of a minute: a morphology filter over three rectangles.
    const rects = [0, 1, 2].map((i) => `<rect x="${i}" y="${i}" width="90" height="90" filter="url(#f)"/>`).join("");
    const slow = svg(100, 100, `<defs><filter id="f" x="-1" y="-1" width="3" height="3"><feMorphology radius="1"/></filter></defs>${rects}`);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 50);
    const started = Date.now();
    const error = await failure(toHostableImage(slow, "/uploads/a/slow.svg", { timeLimitMs: 1000 }));
    clearInterval(timer);

    expect(error).toBeInstanceOf(PermanentImageError);
    expect(error.message).toBe("/uploads/a/slow.svg was not drawn within 1 s");
    expect(Date.now() - started).toBeLessThan(5000);
    // The event loop ran all the while: the drawing is in another process.
    expect(ticks).toBeGreaterThan(10);
    // The next figure is drawn as usual.
    expect((await toHostableImage(svg(60, 20, LINE), "/uploads/a/next.svg")).ext).toBe("png");
    expect(DRAW_TIME_LIMIT_MS).toBe(20_000);
  }, 20_000);

  it("has a renderer that ends itself when nothing is left to kill it", async () => {
    // As after a restart of the server: the renderer runs on, with nobody waiting for it.
    const rects = [0, 1, 2].map((i) => `<rect x="${i}" y="${i}" width="90" height="90" filter="url(#f)"/>`).join("");
    const slow = svgText(100, 100, `<defs><filter id="f" x="-1" y="-1" width="3" height="3"><feMorphology radius="1"/></filter></defs>${rects}`);
    const options = { width: FIGURE_WIDTH, maxHeight: 2700, background: "#ffffff", systemFonts: true, hasText: false, memoryLimitBytes: DRAW_MEMORY_LIMIT_BYTES, giveUpAfterMs: 1000 };
    const child = spawn(process.execPath, [join(import.meta.dirname, "figures-render.mjs"), JSON.stringify(options)], { stdio: ["pipe", "ignore", "ignore"] });
    const started = Date.now();
    child.stdin.end(slow);
    const signal = await new Promise((resolve) => child.on("close", (_code, killedBy) => resolve(killedBy)));
    expect(signal).toBe("SIGKILL");
    expect(Date.now() - started).toBeLessThan(5000);
  }, 20_000);

  it("fails the run when a figure has text and the machine has no font: its labels would be left out", async () => {
    const labelled = svg(200, 40, '<text x="4" y="24" font-family="DejaVu Sans" font-size="20">first coordinate</text>');
    const error = await failure(toHostableImage(labelled, "/uploads/a/plot.svg", { systemFonts: false }));
    expect(error.message).toBe("/uploads/a/plot.svg has text, and this machine has no font to draw it with (install a font package, e.g. DejaVu)");
    expect(error).not.toBeInstanceOf(PermanentImageError);
    // A figure whose lettering is outlines needs no font.
    expect((await toHostableImage(svg(60, 20, LINE), "/uploads/a/outlines.svg", { systemFonts: false })).ext).toBe("png");
  });

  it("warns when text is drawn in a substitute font", async () => {
    const excalidraw = svg(
      200,
      40,
      '<defs><style>@font-face { font-family: Excalifont; src: url(data:font/woff2;base64,AAAA); }</style></defs><text x="4" y="24" font-family="Excalifont, sans-serif" font-size="20">Block 1</text>',
    );
    const labelled = svg(200, 40, '<text x="4" y="24" font-family="DejaVu Sans" font-size="20">first coordinate</text>');
    try {
      expect((await toHostableImage(excalidraw, "/uploads/a/drawing.excalidraw.svg")).warning).toBe(
        "/uploads/a/drawing.excalidraw.svg: text drawn in a substitute font (the SVG embeds its own)",
      );
      expect((await toHostableImage(labelled, "/uploads/a/plot.svg")).warning).toBeNull();
    } catch (err) {
      // This machine has no font at all.
      expect((err as Error).message).toMatch(/has text, and this machine has no font to draw it with/);
    }
  });
});
