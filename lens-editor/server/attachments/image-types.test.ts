import { describe, it, expect } from "vitest";
import { extFor, looksLikeSvg, pathExt, sniffImage } from "./image-types";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const GIF = new Uint8Array([...new TextEncoder().encode("GIF89a"), 1, 0, 1, 0]);
const WEBP = new Uint8Array([
  ...new TextEncoder().encode("RIFF"),
  0x24, 0, 0, 0,
  ...new TextEncoder().encode("WEBPVP8 "),
]);
const SVG = new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const PDF = new TextEncoder().encode("%PDF-1.4 ...");

describe("sniffImage", () => {
  // Prevents: trusting a declared content type or URL extension — a CDN
  // error page served as image/png must not be hosted as an image.
  it("identifies the four allowed raster types from magic bytes", () => {
    expect(sniffImage(PNG)).toEqual({ mime: "image/png", ext: "png" });
    expect(sniffImage(JPEG)).toEqual({ mime: "image/jpeg", ext: "jpg" });
    expect(sniffImage(GIF)).toEqual({ mime: "image/gif", ext: "gif" });
    expect(sniffImage(WEBP)).toEqual({ mime: "image/webp", ext: "webp" });
  });

  it("rejects svg, pdf, html and truncated headers", () => {
    expect(sniffImage(SVG)).toBeNull();
    expect(sniffImage(PDF)).toBeNull();
    expect(sniffImage(new TextEncoder().encode("<html>nope</html>"))).toBeNull();
    expect(sniffImage(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
    // RIFF container that is not WEBP (a .wav) is not an image.
    expect(sniffImage(new Uint8Array([...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WAVE")]))).toBeNull();
  });

  it("looksLikeSvg spots svg for a clearer rejection", () => {
    expect(looksLikeSvg(SVG)).toBe(true);
    expect(looksLikeSvg(new TextEncoder().encode("  <svg></svg>"))).toBe(true);
    expect(looksLikeSvg(PNG)).toBe(false);
  });
});

describe("extFor / pathExt", () => {
  it("maps content types and URL extensions, leaving svg external", () => {
    expect(extFor("https://x/a", "image/png")).toBe("png");
    expect(extFor("https://x/a", "image/jpeg; charset=binary")).toBe("jpg");
    expect(extFor("https://x/a.JPEG?x=1", "application/octet-stream")).toBe("jpg");
    expect(extFor("https://x/a.webp", "")).toBe("webp");
    expect(extFor("https://x/a.svg", "image/svg+xml")).toBeNull();
    expect(extFor("https://x/a", "text/html")).toBeNull();
  });

  it("pathExt reads the last segment's extension", () => {
    expect(pathExt("/attachments/fig.PNG")).toBe("png");
    expect(pathExt("/attachments/fig.tar.gz")).toBe("gz");
    expect(pathExt("/attachments/.png")).toBe("");
    expect(pathExt("/attachments/noext")).toBe("");
  });
});
