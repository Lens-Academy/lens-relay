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
  it("selects by available API key, Datalab first", () => {
    vi.stubEnv("DATALAB_API_KEY", "dk");
    vi.stubEnv("MISTRAL_API_KEY", "mk");
    expect(configuredPdfProvider()).toBe("datalab");
  });

  it("honors PDF_PARSER override and falls back to local without a key", () => {
    vi.stubEnv("DATALAB_API_KEY", "dk");
    vi.stubEnv("PDF_PARSER", "local");
    expect(configuredPdfProvider()).toBe(null);

    vi.stubEnv("PDF_PARSER", "mistral"); // forced but no key
    expect(configuredPdfProvider()).toBe(null);

    vi.stubEnv("MISTRAL_API_KEY", "mk");
    expect(configuredPdfProvider()).toBe("mistral");
  });

  it("uses local extraction when nothing is configured", () => {
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

    const parsed = await parsePdfWithProvider(
      new TextEncoder().encode("%PDF-").buffer,
      "datalab",
    );
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
      parsePdfWithProvider(new ArrayBuffer(4), "datalab"),
    ).rejects.toThrow(/unsupported file/);
  });
});

describe("parsePdfWithProvider — mistral", () => {
  it("joins page markdown in order and maps base64 images", async () => {
    vi.stubEnv("MISTRAL_API_KEY", "mk");
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        pages: [
          {
            index: 1,
            markdown: "Second page.",
            images: [],
          },
          {
            index: 0,
            markdown: "# Title\n\n![img-0.jpeg](img-0.jpeg)",
            images: [
              {
                id: "img-0.jpeg",
                image_base64: `data:image/jpeg;base64,${PNG_B64}`,
              },
            ],
          },
        ],
      }),
    );

    const parsed = await parsePdfWithProvider(new ArrayBuffer(4), "mistral");
    expect(parsed.provider).toBe("mistral");
    expect(parsed.body.indexOf("# Title")).toBeLessThan(
      parsed.body.indexOf("Second page."),
    );
    expect(parsed.body).toContain("![[__pdfimg_0__]]");
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0].mime).toBe("image/jpeg");
    // data-URL prefix must be stripped before decoding
    expect(parsed.images[0].png.toString()).toBe("fake-png-bytes");

    const call = mockFetch.mock.calls[0];
    expect(call[0]).toBe("https://api.mistral.ai/v1/ocr");
    const body = JSON.parse(call[1].body);
    expect(body.include_image_base64).toBe(true);
    expect(body.document.document_url).toMatch(/^data:application\/pdf;base64,/);
  });

  it("throws on an empty parse (caller falls back to local)", async () => {
    vi.stubEnv("MISTRAL_API_KEY", "mk");
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { pages: [] }));
    await expect(
      parsePdfWithProvider(new ArrayBuffer(4), "mistral"),
    ).rejects.toThrow(/empty/i);
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
      parsePdfWithProvider(new ArrayBuffer(4), "datalab"),
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
