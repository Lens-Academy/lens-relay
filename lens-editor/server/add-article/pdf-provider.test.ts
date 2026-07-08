import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  configuredPdfProvider,
  parsePdfWithProvider,
  substituteImageRefs,
} from "./pdf-provider";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Minimal Response stand-in for fetchBytesWithTimeout (reads arrayBuffer). */
function jsonResponse(status: number, payload: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: new Headers(),
    arrayBuffer: async () => bytes.buffer,
  };
}

const PNG_B64 = Buffer.from("fake-png-bytes").toString("base64");

describe("configuredPdfProvider", () => {
  it("selects datalab when its key is set", () => {
    vi.stubEnv("DATALAB_API_KEY", "dk");
    expect(configuredPdfProvider()).toBe("datalab");
  });

  it("uses local extraction when no key is configured", () => {
    expect(configuredPdfProvider()).toBe(null);
  });
});

describe("substituteImageRefs", () => {
  it("replaces provider image refs with indexed placeholders", () => {
    const md = "Intro\n\n![fig](page_0_fig_1.png)\n\nMore\n\n![x](chart.jpeg)";
    const { body, images } = substituteImageRefs(md, [
      { name: "page_0_fig_1.png", base64: PNG_B64 },
      { name: "chart.jpeg", base64: PNG_B64 },
    ]);
    expect(body).toContain("![[__pdfimg_0__]]");
    expect(body).toContain("![[__pdfimg_1__]]");
    expect(images).toHaveLength(2);
    expect(images[0].mime).toBe("image/png");
    expect(images[1].mime).toBe("image/jpeg");
    expect(images[0].png.toString()).toBe("fake-png-bytes");
  });

  // Prevents: background/decoration crops the markdown never cites being
  // uploaded as figures.
  it("drops images the markdown does not reference", () => {
    const { body, images } = substituteImageRefs("No figures here.", [
      { name: "unused.png", base64: PNG_B64 },
    ]);
    expect(images).toHaveLength(0);
    expect(body).toBe("No figures here.");
  });

  it("drops figures with undecodable/empty payloads but keeps the text", () => {
    const { body, images } = substituteImageRefs("A ![f](x.png) B", [
      { name: "x.png", base64: "" },
    ]);
    expect(images).toHaveLength(0);
    expect(body).not.toContain("__pdfimg_");
    expect(body).toContain("A");
    expect(body).toContain("B");
  });
});

describe("parsePdfWithProvider — datalab", () => {
  it("submits, polls until complete, and maps markdown + images", async () => {
    vi.stubEnv("DATALAB_API_KEY", "dk");
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          request_check_url: "https://www.datalab.to/api/v1/convert/123",
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { status: "processing" }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: "complete",
          success: true,
          markdown: "# Title\n\n![](fig1.png)\n\nBody text.",
          images: { "fig1.png": PNG_B64 },
        }),
      );

    const parsed = await parsePdfWithProvider(new TextEncoder().encode("%PDF-").buffer);
    expect(parsed.provider).toBe("datalab");
    expect(parsed.body).toContain("# Title");
    expect(parsed.body).toContain("![[__pdfimg_0__]]");
    expect(parsed.images).toHaveLength(1);

    // Submit carries the API key; polls hit the check URL.
    expect(mockFetch.mock.calls[0][1].headers["X-Api-Key"]).toBe("dk");
    expect(mockFetch.mock.calls[1][0]).toBe("https://www.datalab.to/api/v1/convert/123");
  }, 15_000);

  it("throws when Datalab reports failure (caller falls back to local)", async () => {
    vi.stubEnv("DATALAB_API_KEY", "dk");
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { success: false, error: "unsupported file" }),
    );
    await expect(
      parsePdfWithProvider(new ArrayBuffer(4)),
    ).rejects.toThrow(/unsupported file/);
  });
});


describe("review-hardening: datalab terminal status + empty image names", () => {
  // Prevents: a terminal "failed" status spinning the full 6-min poll budget.
  it("fails fast with Datalab's own error on a terminal status", async () => {
    vi.stubEnv("DATALAB_API_KEY", "dk");
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(200, { success: true, request_check_url: "https://d/1" }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { status: "failed", success: false, error: "corrupt pdf" }),
      );
    await expect(
      parsePdfWithProvider(new ArrayBuffer(4)),
    ).rejects.toThrow(/corrupt pdf/);
    expect(mockFetch).toHaveBeenCalledTimes(2); // no further polling
  }, 15_000);

  // Prevents: a blank image name matching every empty ![]() in the body.
  it("skips images with blank names", () => {
    const { body, images } = substituteImageRefs("start ![]() end", [
      { name: "", base64: PNG_B64 },
    ]);
    expect(images).toHaveLength(0);
    expect(body).toBe("start ![]() end");
  });
});
