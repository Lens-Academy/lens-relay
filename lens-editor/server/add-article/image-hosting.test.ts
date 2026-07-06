import { describe, it, expect, vi } from "vitest";
import { hostRemoteImages, ARXIV_IMAGE_HOSTS } from "./image-hosting";

const PNG = new TextEncoder().encode("png-bytes").buffer;

function opts(over: Partial<Parameters<typeof hostRemoteImages>[2]> = {}) {
  return {
    hostPattern: ARXIV_IMAGE_HOSTS,
    fetchImage: vi.fn(async () => ({ bytes: PNG, contentType: "image/png" })),
    upload: vi.fn(async () => {}),
    ...over,
  };
}

describe("hostRemoteImages", () => {
  // Prevents: arXiv figures left as rot-prone ar5iv hotlinks (images 6.76 in
  // the blind eval; every figure-bearing arXiv item docked).
  it("rehosts arXiv-host images as attachments and rewrites embeds", async () => {
    const body =
      "Intro\n\n![Fig 1](https://ar5iv.labs.arxiv.org/html/1912.01683/assets/x1.png)\n\n" +
      "![ext](https://example.com/keep.png)\n";
    const o = opts();
    const out = await hostRemoteImages(body, "turner-power", o);
    expect(out).toContain("![[/attachments/turner-power-img1.png]]");
    expect(out).toContain("https://example.com/keep.png"); // non-arXiv untouched
    expect(o.upload).toHaveBeenCalledWith(
      "/attachments/turner-power-img1.png",
      expect.any(Buffer),
      "image/png",
    );
  });

  it("keeps the external URL when fetch or upload fails", async () => {
    const body = "![f](https://arxiv.org/html/1/assets/x1.png)";
    const out = await hostRemoteImages(
      body,
      "b",
      opts({ fetchImage: vi.fn(async () => { throw new Error("net"); }) }),
    );
    expect(out).toBe(body);
  });

  it("skips oversized and unknown-type images", async () => {
    const body =
      "![a](https://arxiv.org/a/big.png)\n![b](https://arxiv.org/a/vector.svg)";
    const o = opts({
      fetchImage: vi.fn(async (u: string) =>
        u.endsWith("big.png")
          ? { bytes: new ArrayBuffer(6 * 1024 * 1024), contentType: "image/png" }
          : { bytes: PNG, contentType: "image/svg+xml" },
      ),
    });
    const out = await hostRemoteImages(body, "b", o);
    expect(out).toBe(body);
    expect(o.upload).not.toHaveBeenCalled();
  });

  it("caps the number of hosted images", async () => {
    const body = Array.from(
      { length: 5 },
      (_, i) => `![f${i}](https://arxiv.org/a/x${i}.png)`,
    ).join("\n");
    const o = opts({ maxImages: 2 });
    const out = await hostRemoteImages(body, "b", o);
    expect(o.upload).toHaveBeenCalledTimes(2);
    expect(out).toContain("x2.png"); // third image left external
  });

  it("uses jpeg extension/mime from content-type", async () => {
    const o = opts({
      fetchImage: vi.fn(async () => ({ bytes: PNG, contentType: "image/jpeg" })),
    });
    const out = await hostRemoteImages(
      "![f](https://arxiv.org/a/fig)",
      "b",
      o,
    );
    expect(out).toContain("![[/attachments/b-img1.jpg]]");
    expect(o.upload).toHaveBeenCalledWith(
      "/attachments/b-img1.jpg",
      expect.any(Buffer),
      "image/jpeg",
    );
  });
});

describe("review-hardening: URLs containing parentheses", () => {
  // Prevents: ")" in a URL truncating the match and leaving a stray paren.
  it("matches and rewrites parenthesized URLs cleanly", async () => {
    const url = "https://arxiv.org/img.png?x=(1)";
    const o = opts();
    const out = await hostRemoteImages(`before ![a](${url}) after`, "s", o);
    expect(out).toBe("before ![[/attachments/s-img1.png]] after");
    expect(o.fetchImage).toHaveBeenCalledWith(url);
  });
});
