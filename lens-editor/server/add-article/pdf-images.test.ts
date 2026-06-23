import { describe, it, expect } from "vitest";
import zlib from "node:zlib";
import { encodePng } from "./pdf-images";

describe("encodePng", () => {
  it("encodes raw RGBA pixels into a valid PNG and round-trips the data", () => {
    const data = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]); // 2x1: red, green
    const png = encodePng(data, 2, 1, 4);

    // PNG signature
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    // IHDR
    expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(2); // width
    expect(png.readUInt32BE(20)).toBe(1); // height
    expect(png[24]).toBe(8); // bit depth
    expect(png[25]).toBe(6); // color type: RGBA
    // IEND terminates
    expect(png.subarray(png.length - 8, png.length - 4).toString("ascii")).toBe("IEND");

    // IDAT (right after the 25-byte IHDR chunk) inflates to filter-byte + the row
    const idatLen = png.readUInt32BE(33);
    expect(png.subarray(37, 41).toString("ascii")).toBe("IDAT");
    const inflated = zlib.inflateSync(png.subarray(41, 41 + idatLen));
    expect([...inflated]).toEqual([0, 255, 0, 0, 255, 0, 255, 0, 255]);
  });

  it("picks the PNG color type from the channel count", () => {
    expect(encodePng(new Uint8Array([128]), 1, 1, 1)[25]).toBe(0); // grayscale
    expect(encodePng(new Uint8Array([1, 2, 3]), 1, 1, 3)[25]).toBe(2); // RGB
    expect(encodePng(new Uint8Array([1, 2, 3, 4]), 1, 1, 4)[25]).toBe(6); // RGBA
  });
});
