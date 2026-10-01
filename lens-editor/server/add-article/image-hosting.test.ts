import { describe, it, expect, vi } from "vitest";
import { hostRemoteImages, newImageBudget } from "./image-hosting";

/** arXiv + ar5iv asset mirrors, to exercise the hostPattern option. */
const ARXIV_IMAGE_HOSTS = /(^|\.)(arxiv\.org|ar5iv\.org|ar5iv\.labs\.arxiv\.org)$/i;

// Real magic bytes: hosting sniffs the content, not the content type.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).buffer;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).buffer;
const H = "[0-9a-f]{8}";

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
    expect(out).toMatch(new RegExp(`!\\[Fig 1\\]\\(https://raw\\.githubusercontent\\.com/Lens-Academy/lens-edu-staging/staging/attachments/turner-power-img1-${H}\\.png\\)`));
    expect(out).toContain("https://example.com/keep.png"); // outside hostPattern: untouched
    expect(o.upload).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^/attachments/turner-power-img1-${H}\\.png$`)),
      expect.any(Buffer),
      "image/png",
    );
  });

  // Prevents: hotlinks on ordinary sites (AISI, ai-2040, ...) staying
  // external and rotting; only arXiv used to be rehosted.
  it("rehosts images from any host when no hostPattern is given", async () => {
    const body =
      "![a](https://www.aisi.gov.uk/img/chart.png)\n![b](https://ai-2040.com/fig.jpg)";
    const o = opts({
      hostPattern: undefined,
      fetchImage: vi.fn(async (u: string) => ({
        bytes: u.endsWith(".jpg") ? JPEG : PNG,
        contentType: "application/octet-stream",
      })),
    });
    const out = await hostRemoteImages(body, "s", o);
    expect(out).not.toContain("aisi.gov.uk");
    expect(out).not.toContain("ai-2040.com");
    expect(out).toMatch(new RegExp(`/attachments/s-img1-${H}\\.png\\)`));
    expect(out).toMatch(new RegExp(`/attachments/s-img2-${H}\\.jpg\\)`));
  });

  // Prevents: re-downloading (and duplicating) images that already point at
  // our own published attachments.
  it("leaves images on the folder's own attachment URL alone", async () => {
    const own = "https://raw.githubusercontent.com/Lens-Academy/lens-edu-staging/staging/attachments/x.png";
    const o = opts({ hostPattern: undefined });
    const out = await hostRemoteImages(`![a](${own})`, "s", o);
    expect(out).toBe(`![a](${own})`);
    expect(o.fetchImage).not.toHaveBeenCalled();
  });

  // Prevents: an HTML error page served as image/png being hosted as an image
  it("keeps images whose bytes are not an image, and says why", async () => {
    let result: { hosted: number; kept: { url: string; reason: string }[] } | undefined;
    const body = "![a](https://example.com/missing.png)";
    const o = opts({
      hostPattern: undefined,
      fetchImage: vi.fn(async () => ({
        bytes: new TextEncoder().encode("<html>404</html>").buffer,
        contentType: "image/png",
      })),
      onResult: (r) => { result = r; },
    });
    expect(await hostRemoteImages(body, "s", o)).toBe(body);
    expect(o.upload).not.toHaveBeenCalled();
    expect(result).toEqual({
      hosted: 0,
      kept: [{ url: "https://example.com/missing.png", reason: "not a png, jpeg, gif or webp image" }],
    });
  });

  // Prevents: one image-heavy page pushing hundreds of MB into the relay
  it("stops at the per-article byte budget", async () => {
    const body = ["a", "b", "c"].map((n) => `![${n}](https://example.com/${n}.png)`).join("\n");
    const o = opts({ hostPattern: undefined, budget: newImageBudget(30, PNG.byteLength * 2), concurrency: 1 });
    const out = await hostRemoteImages(body, "s", o);
    expect(o.upload).toHaveBeenCalledTimes(2);
    expect(out).toContain("https://example.com/c.png");
    // Spent budget stops downloads too, not only uploads.
    expect(o.fetchImage).toHaveBeenCalledTimes(2);
  });

  it("passes the per-image byte cap to the fetcher", async () => {
    const o = opts({ maxBytesPerImage: 1234 });
    await hostRemoteImages("![f](https://arxiv.org/a/x1.png)", "b", o);
    expect(o.fetchImage).toHaveBeenCalledWith("https://arxiv.org/a/x1.png", 1234, undefined);
  });

  // Prevents: the rendered and unrendered candidates of one import each
  // downloading and uploading the same images
  it("reuses hosted URLs from a shared cache", async () => {
    const cache = new Map<string, string>();
    const body = "![f](https://example.com/x.png)";
    const first = opts({ hostPattern: undefined, cache });
    const second = opts({ hostPattern: undefined, cache });
    const a = await hostRemoteImages(body, "one", first);
    const b = await hostRemoteImages(body, "two", second);
    expect(b).toBe(a);
    expect(second.fetchImage).not.toHaveBeenCalled();
    expect(second.upload).not.toHaveBeenCalled();
  });

  // Prevents: downloads racing ahead of uploads and holding every image of
  // the article in memory at once
  it("keeps at most `concurrency` downloads in flight or held", async () => {
    let inFlight = 0;
    let peak = 0;
    const o = opts({
      hostPattern: undefined,
      concurrency: 2,
      fetchImage: vi.fn(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return { bytes: PNG, contentType: "image/png" };
      }),
      // A slow upload: finished downloads must not be replaced while waiting.
      upload: vi.fn(async () => { await new Promise((r) => setTimeout(r, 20)); }),
    });
    const body = Array.from({ length: 8 }, (_, i) => `![${i}](https://e.com/${i}.png)`).join("\n");
    await hostRemoteImages(body, "s", o);
    expect(peak).toBeLessThanOrEqual(2);
    expect(o.upload).toHaveBeenCalledTimes(8);
  });

  // Prevents: two review candidates of one article each using the full budget
  it("shares one budget between calls and continues the numbering", async () => {
    const budget = newImageBudget(3);
    const first = opts({ hostPattern: undefined, budget });
    const second = opts({ hostPattern: undefined, budget });
    await hostRemoteImages("![a](https://e.com/a.png) ![b](https://e.com/b.png)", "s", first);
    const out = await hostRemoteImages("![c](https://e.com/c.png) ![d](https://e.com/d.png)", "s", second);
    expect(out).toMatch(/s-img3-/);
    expect(out).toContain("https://e.com/d.png");
    expect(second.fetchImage).toHaveBeenCalledTimes(1);
  });

  // Prevents: a slow image host holding the import until the job deadline
  it("stops at the time limit and keeps the rest external", async () => {
    let result: { hosted: number; kept: { url: string; reason: string }[] } | undefined;
    const ctrl = new AbortController();
    const o = opts({
      hostPattern: undefined,
      signal: ctrl.signal,
      concurrency: 1,
      fetchImage: vi.fn(async (_u: string, _max: number, signal?: AbortSignal) => {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 1000);
          signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); });
        });
        return { bytes: PNG, contentType: "image/png" };
      }),
      onResult: (r) => { result = r; },
    });
    setTimeout(() => ctrl.abort(), 10);
    const body = "![a](https://e.com/a.png) ![b](https://e.com/b.png)";
    expect(await hostRemoteImages(body, "s", o)).toBe(body);
    expect(result!.kept.map((k) => k.reason)).toEqual([
      "image hosting time limit reached",
      "image hosting time limit reached",
    ]);
    expect(o.fetchImage).toHaveBeenCalledTimes(1);
  });

  // Prevents: a fetcher that throws synchronously escaping as a rejection
  it("treats a synchronously throwing fetcher as a failed image", async () => {
    const body = "![a](https://e.com/a.png)";
    const o = opts({
      hostPattern: undefined,
      fetchImage: vi.fn(() => { throw new Error("boom"); }) as never,
    });
    expect(await hostRemoteImages(body, "s", o)).toBe(body);
  });

  // Prevents: parallel downloads scrambling the img<n> numbering
  it("numbers images in order of appearance even when downloads finish out of order", async () => {
    const delays: Record<string, number> = { a: 30, b: 0, c: 10 };
    const o = opts({
      hostPattern: undefined,
      fetchImage: vi.fn(async (u: string) => {
        const name = u.slice(-5, -4);
        await new Promise((r) => setTimeout(r, delays[name]));
        return { bytes: new Uint8Array([...new Uint8Array(PNG), name.charCodeAt(0)]).buffer, contentType: "image/png" };
      }),
    });
    const out = await hostRemoteImages(
      "![a](https://e.com/a.png) ![b](https://e.com/b.png) ![c](https://e.com/c.png)",
      "s",
      o,
    );
    const order = [...out.matchAll(/s-img(\d)-/g)].map((m) => m[1]);
    expect(order).toEqual(["1", "2", "3"]);
  });

  it("uses the configured folder's public base URL", async () => {
    const o = opts({ folder: "Lens" });
    vi.stubEnv("ATTACHMENT_PUBLIC_URLS", "Lens=https://raw.example/lens/main");
    try {
      const out = await hostRemoteImages("![f](https://arxiv.org/a/x1.png)", "b", o);
      expect(out).toMatch(new RegExp(`https://raw\\.example/lens/main/attachments/b-img1-${H}\\.png`));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("retries with a longer hash suffix on a relay name conflict", async () => {
    const { RelayAttachmentConflictError } = await import("../add-video/relay-docs");
    const upload = vi.fn(async (p: string) => {
      if (upload.mock.calls.length === 1) throw new RelayAttachmentConflictError(p, "h", "taken");
    });
    const out = await hostRemoteImages("![f](https://arxiv.org/a/x1.png)", "b", opts({ upload }));
    expect(upload).toHaveBeenCalledTimes(2);
    expect(out).toMatch(/b-img1-[0-9a-f]{16}\.png/);
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
          ? { bytes: new Uint8Array([...new Uint8Array(PNG), ...new Uint8Array(6 * 1024 * 1024)]).buffer, contentType: "image/png" }
          : { bytes: new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>").buffer, contentType: "image/svg+xml" },
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
    const o = opts({ budget: newImageBudget(2) });
    const out = await hostRemoteImages(body, "b", o);
    expect(o.upload).toHaveBeenCalledTimes(2);
    expect(out).toContain("x2.png"); // third image left external
  });

  it("takes extension/mime from the bytes, not the content-type", async () => {
    const o = opts({
      fetchImage: vi.fn(async () => ({ bytes: JPEG, contentType: "image/png" })),
    });
    const out = await hostRemoteImages(
      "![f](https://arxiv.org/a/fig)",
      "b",
      o,
    );
    expect(out).toMatch(new RegExp(`/attachments/b-img1-${H}\\.jpg\\)`));
    expect(o.upload).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^/attachments/b-img1-${H}\\.jpg$`)),
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
    expect(out).toMatch(new RegExp(`^before !\\[a\\]\\(https://raw\\.githubusercontent\\.com/Lens-Academy/lens-edu-staging/staging/attachments/s-img1-${H}\\.png\\) after$`));
    expect(o.fetchImage).toHaveBeenCalledWith(url, expect.any(Number), undefined);
  });
});
