import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleDocsClient, GoogleHttpError } from "../google-docs/client";
import { memoryFiles } from "../iliad/__fixtures__/files/course";
import { PermanentImageError } from "../types";
import { CHAPTERS, chapterDoc, CONFIG, DOC1, DOC2, link, memoryDocs } from "./__fixtures__/course";
import { combinedRevision, googleAtlasDocs, hostImages, MAX_DOWNLOAD_BYTES, readChapters, tabRevision } from "./snapshot";

describe("tabRevision", () => {
  it("is the same for two reads of an unchanged tab, whose image links differ", () => {
    const [a, b] = [chapterDoc(DOC1, CHAPTERS()[0]), chapterDoc(DOC1, CHAPTERS()[0])].map((doc) => doc.tabs![0].documentTab!);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    expect(tabRevision(a)).toBe(tabRevision(b));
    const edited = CHAPTERS()[0];
    edited.sections[0].words[0] = "edited";
    expect(tabRevision(chapterDoc(DOC1, edited).tabs![0].documentTab!)).not.toBe(tabRevision(a));
  });

  it("combines in order, an unread chapter included", () => {
    expect(combinedRevision(["a", "b"])).not.toBe(combinedRevision(["b", "a"]));
    expect(combinedRevision(["a", null])).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("readChapters", () => {
  it("reads each configured tab, and leaves out one it cannot read", async () => {
    const docs = memoryDocs(CHAPTERS());
    docs.fail.set(DOC2, new GoogleHttpError(404, "Google Doc x is not readable (404: not found)"));
    const { chapters, unread } = await readChapters({ ...CONFIG, chapters: [{ doc: link(DOC1) }, { doc: link(DOC2) }, { doc: link("1cccccccccccccccccccccccccccccccccccccccccccc", "t.9") }] }, docs);
    expect(chapters.map(({ docId, url }) => ({ docId, url }))).toEqual([{ docId: DOC1, url: link(DOC1) }]);
    expect(unread.map((c) => c.reason)).toEqual(["Google Doc x is not readable (404: not found)", expect.stringContaining("is not readable (404)")]);
  });

  it("names the tabs a Doc has when the configured one is not there", async () => {
    const { unread } = await readChapters({ ...CONFIG, chapters: [{ doc: link(DOC1, "t.7") }] }, memoryDocs(CHAPTERS()));
    expect(unread[0].reason).toBe(`Google Doc ${DOC1} has no tab t.7; its tabs: t.0 "Chapter"`);
  });
});

describe("hostImages", () => {
  it("hosts each image of the chapters given once a day, under the chapter's stem", async () => {
    const docs = memoryDocs(CHAPTERS());
    const { chapters } = await readChapters(CONFIG, docs);
    const files = memoryFiles({});
    const hosted = new Map();
    const snapshot = await hostImages([{ source: chapters[0], stem: "atlas-capabilities" }], docs, files, hosted);
    expect(snapshot.imageUrl(DOC1, "kix.one")).toBe("attachments/atlas-capabilities.png");
    expect(snapshot.imageUrl(DOC2, "kix.one")).toBeNull();
    expect(docs.images).toEqual([`${DOC1}#kix.one`]);
    await hostImages([{ source: chapters[0], stem: "atlas-capabilities" }], docs, files, hosted);
    expect(docs.images).toHaveLength(1);
  });

  it("hosts an image again when its object changed, though its id did not", async () => {
    const docs = memoryDocs(CHAPTERS());
    const { chapters } = await readChapters(CONFIG, docs);
    const hosted = new Map();
    const host = (source = chapters[0]) => hostImages([{ source, stem: "atlas-capabilities" }], docs, memoryFiles({}), hosted);
    await host();
    await host();
    expect(docs.images).toHaveLength(1);
    const object = chapters[0].tab.inlineObjects!["kix.one"];
    object.inlineObjectProperties!.embeddedObject!.title = "a new picture";
    await host();
    expect(docs.images).toHaveLength(2);
  });

  it("hosts each image as the conversion makes it, and the original when that fails", async () => {
    const docs = memoryDocs(CHAPTERS());
    const { chapters } = await readChapters(CONFIG, docs);
    const hostedBytes: Uint8Array[] = [];
    const files = {
      ...memoryFiles({}),
      hostImage: async (bytes: Uint8Array, stem: string) => {
        hostedBytes.push(bytes);
        return `attachments/${stem}.webp`;
      },
    };
    const smaller = async () => ({ bytes: new Uint8Array([9]), mime: "image/webp" });
    await hostImages([{ source: chapters[0], stem: "atlas-capabilities" }], docs, files, new Map(), smaller);
    expect(hostedBytes).toEqual([new Uint8Array([9])]);
    const broken = await hostImages([{ source: chapters[0], stem: "atlas-capabilities" }], docs, files, new Map(), () => Promise.reject(new Error("bad image")));
    expect(hostedBytes[1]).toEqual(new Uint8Array([1, 2, 3]));
    expect(broken.warnings).toEqual(["atlas-capabilities: image kix.one could not be made smaller (bad image); it is hosted as it is, 0.0 MB"]);
    expect(broken.failed).toEqual([]);
  });

  it("leaves out an image that can never be hosted, and fails the chapter of one that may yet be", async () => {
    const docs = memoryDocs(CHAPTERS());
    const { chapters } = await readChapters(CONFIG, docs);
    const host = (error: Error) => hostImages([{ source: chapters[0], stem: "atlas-capabilities" }], { ...docs, getImage: async () => Promise.reject(error) }, memoryFiles({}), new Map());
    const lasting = await host(new PermanentImageError("SVG is not accepted"));
    expect(lasting.warnings).toEqual(["atlas-capabilities: image kix.one: SVG is not accepted; the article is written without it"]);
    expect(lasting.failed).toEqual([]);
    const passing = await host(new GoogleHttpError(503, "image download failed: 503"));
    expect(passing.failed).toEqual([{ docId: DOC1, url: link(DOC1), reason: "1 image(s) could not be hosted: image kix.one: image download failed: 503" }]);
  });
});

describe("googleAtlasDocs", () => {
  afterEach(() => vi.unstubAllGlobals());
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const docs = googleAtlasDocs(new GoogleDocsClient({ client_email: "sync@test", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() }));
  const image = (contentUri: string) => docs.getImage({ docId: DOC1, inlineObjectId: "kix.gif", contentUri });

  it("downloads an image over the relay's limit, since what is hosted is the smaller WebP", async () => {
    const big = new Uint8Array(22 * 1024 * 1024);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(big)));
    expect((await image("https://lh.test/big")).length).toBe(big.length);
  });

  it("takes an image too large to download for one that can never be hosted", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { headers: { "content-length": String(MAX_DOWNLOAD_BYTES + 1) } })));
    await expect(image("https://lh.test/huge")).rejects.toThrow(PermanentImageError);
    await expect(image("https://lh.test/huge")).rejects.toThrow("over 100 MB, too large to download");
    // Any other failure may pass, and fails the chapter's run as before.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    await expect(image("https://lh.test/busy")).rejects.toThrow(GoogleHttpError);
  });
});
