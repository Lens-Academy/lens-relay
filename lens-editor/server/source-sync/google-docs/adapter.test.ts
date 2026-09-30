import { describe, expect, it, vi } from "vitest";
import { googleDocAdapter } from "./adapter";
import { GoogleHttpError, type GoogleDocsClient } from "./client";
import { PermanentImageError, type SyncBinding } from "../types";
import type { DocsDocument } from "./docs-types";

const LINK = "https://docs.google.com/document/d/1hWdq25Nw17538nk5aNG1_a8PxfNUhFKfaa9r0H6fRP4/edit";
const binding = (tab = "t.0"): SyncBinding => ({ source: `${LINK}?tab=${tab}`, target: "Lens Edu/articles/Ch1.md", author: ["M"] });

const figure = (id: string) => ({
  table: {
    columns: 2,
    tableRows: [
      { tableCells: [{ content: [{ paragraph: { elements: [{ textRun: { content: "type\n" } }] } }] }, { content: [{ paragraph: { elements: [{ textRun: { content: "figure\n" } }] } }] }] },
      { tableCells: [{ content: [{ paragraph: { elements: [{ textRun: { content: "content\n" } }] } }] }, { content: [{ paragraph: { elements: [{ inlineObjectElement: { inlineObjectId: id } }] } }] }] },
    ],
  },
});

function docWith(images: string[], extraTabs: DocsDocument["tabs"] = []): DocsDocument {
  return {
    documentId: "d1",
    tabs: [
      {
        tabProperties: { tabId: "t.0", title: "Chapter" },
        documentTab: {
          body: { content: images.map(figure) },
          inlineObjects: Object.fromEntries(
            images.map((id) => [id, { inlineObjectProperties: { embeddedObject: { imageProperties: { contentUri: `https://lh.test/${id}` } } } }]),
          ),
        },
        childTabs: extraTabs,
      },
    ],
  };
}

function adapterFor(doc: DocsDocument, getImage: (uri: string) => Promise<Uint8Array> = async () => new Uint8Array([1])) {
  const client = { getDocument: vi.fn(async () => doc), getImage: vi.fn(getImage) } as unknown as GoogleDocsClient;
  return googleDocAdapter(() => client);
}

describe("googleDocAdapter", () => {
  it("converts the bound tab and hosts its images", async () => {
    const content = await adapterFor(docWith(["kix.a"])).pull(binding(), async () => "https://img.test/a.png");
    expect(content.body).toBe("![Figure 1](https://img.test/a.png)\n\n*Figure 1*\n");
    expect(content.editUrl).toBe(`${LINK}?tab=t.0`);
  });

  it("refuses a link without ?tab= when the Doc has several tabs, and warns about unsynced child tabs", async () => {
    const doc = docWith([], [{ tabProperties: { tabId: "t.1", title: "Reviewer notes" } }]);
    await expect(adapterFor(doc).pull({ ...binding(), source: LINK }, async () => "")).rejects.toThrow(/has 2 tabs; add \?tab=<id>/);
    const content = await adapterFor(doc).pull(binding("t.0"), async () => "");
    expect(content.warnings).toEqual(["1 child tab(s) of this tab are not synced; bind them separately"]);
  });

  it("leaves the file alone when an image fails for a passing reason", async () => {
    const adapter = adapterFor(docWith(["kix.a", "kix.b"]), async (uri) => {
      if (uri.endsWith("kix.b")) throw new GoogleHttpError(503, "image download failed: 503");
      return new Uint8Array([1]);
    });
    await expect(adapter.pull(binding(), async () => "https://img.test/x.png")).rejects.toThrow(
      "1 image(s) failed, so the file is left as it was: image kix.b: image download failed: 503",
    );
    const relayDown = adapterFor(docWith(["kix.a"]));
    await expect(relayDown.pull(binding(), async () => { throw new Error("Relay: hosting an image failed: fetch failed"); })).rejects.toThrow(/left as it was/);
  });

  it("writes without an image that can never be hosted, and says so", async () => {
    const adapter = adapterFor(docWith(["kix.a", "kix.b", "kix.c"]), async (uri) => {
      if (uri.endsWith("kix.c")) throw new GoogleHttpError(404, "image download failed: 404");
      return new Uint8Array([uri.endsWith("kix.b") ? 2 : 1]);
    });
    const content = await adapter.pull(binding(), async (bytes) => {
      if (bytes[0] === 2) throw new PermanentImageError("Only image/png, … are accepted: SVG is not accepted");
      return "https://img.test/a.png";
    });
    expect(content.warnings).toEqual(expect.arrayContaining([
      "image kix.b: Only image/png, … are accepted: SVG is not accepted",
      "image kix.c: image download failed: 404",
    ]));
    expect(content.body).toContain("![Figure 1](https://img.test/a.png)");
  });
});
