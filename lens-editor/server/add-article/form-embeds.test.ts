import { beforeEach, describe, expect, it, vi } from "vitest";
import { DuplicateDocumentError } from "./duplicate";

const fetchMocks = vi.hoisted(() => ({
  fetchRawHtml: vi.fn(),
  fetchRawBytes: vi.fn(),
}));
const relayMocks = vi.hoisted(() => ({
  checkRelayArticleUrls: vi.fn(),
  checkRelayDocsExist: vi.fn(),
  createRelayDoc: vi.fn(),
  createRelayAttachment: vi.fn(),
  checkRelayVideoIds: vi.fn(),
  relayTranscriptFolder: () => "Lens Edu/video_transcripts",
  editorOpenUrl: (p: string) => `https://editor.lensacademy.org/open/${encodeURI(p)}`,
}));
const evidenceMocks = vi.hoisted(() => ({
  buildSourceEvidence: vi.fn(),
  writeSourceEvidence: vi.fn(),
}));

vi.mock("./fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./fetch")>()),
  ...fetchMocks,
}));
vi.mock("../add-video/relay-docs", () => relayMocks);
vi.mock("./source-evidence", () => evidenceMocks);

import { formEmbedFromUrl, formTitleFromHtml } from "./form-embeds";
import { processArticle } from "./pipeline";
import { installFakeRelay } from "./fake-relay.test-helper";

describe("formEmbedFromUrl", () => {
  it.each([
    [
      "https://airtable.com/appwUI4Pc2NJPOfmZ/pagHeZnPA3oHwu5Zc/form",
      "https://airtable.com/embed/appwUI4Pc2NJPOfmZ/pagHeZnPA3oHwu5Zc/form",
    ],
    [
      "https://airtable.com/embed/appwUI4Pc2NJPOfmZ/pagHeZnPA3oHwu5Zc/form",
      "https://airtable.com/embed/appwUI4Pc2NJPOfmZ/pagHeZnPA3oHwu5Zc/form",
    ],
    ["https://airtable.com/shrAbc123", "https://airtable.com/embed/shrAbc123"],
    [
      "https://docs.google.com/forms/d/e/1FAIpQLSf/viewform?usp=sf_link",
      "https://docs.google.com/forms/d/e/1FAIpQLSf/viewform?embedded=true",
    ],
    ["https://tally.so/r/w4Ab9", "https://tally.so/embed/w4Ab9"],
  ])("turns %s into its embed URL", (url, embedUrl) => {
    expect(formEmbedFromUrl(url)?.embedUrl).toBe(embedUrl);
  });

  it.each([
    "https://airtable.com/appr2z9dkqLHuyLuw/tblXyz/viwAbc",
    "https://airtable.com/",
    "https://docs.google.com/forms/d/1abc/edit",
    "https://example.com/airtable.com/app/pag/form",
  ])("leaves %s to the article importer", (url) => {
    expect(formEmbedFromUrl(url)).toBeNull();
  });
});

describe("formTitleFromHtml", () => {
  it("takes og:title without the provider suffix", () => {
    const html = `<head><meta property="og:title" content="Offboarding - Airtable"><title>x</title></head>`;
    expect(formTitleFromHtml(html, "Airtable")).toBe("Offboarding");
  });

  it("keeps an apostrophe and reads content before property", () => {
    const html = `<meta content="Alex&#39;s form - Airtable" property="og:title">`;
    expect(formTitleFromHtml(html, "Airtable")).toBe("Alex's form");
  });

  it("gives nothing when the page names only the provider", () => {
    expect(formTitleFromHtml("<title>Airtable</title>", "Airtable")).toBe("");
  });
});

describe("importing a form URL", () => {
  const now = new Date().toISOString();
  const job = (url: string) => ({
    id: "form",
    url,
    status: "processing" as const,
    importMode: "stub" as const,
    created_at: now,
    updated_at: now,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes an embed record without extracting or reviewing the page", async () => {
    const files = installFakeRelay(relayMocks);
    fetchMocks.fetchRawHtml.mockResolvedValue(`<meta property="og:title" content="Offboarding - Airtable">`);

    await processArticle(job("https://airtable.com/appwUI4Pc2NJPOfmZ/pagHeZnPA3oHwu5Zc/form"));

    expect(evidenceMocks.buildSourceEvidence).not.toHaveBeenCalled();
    expect([...files.keys()]).toEqual(["Lens Edu/articles/airtable-offboarding.md"]);
    const markdown = [...files.values()][0];
    expect(markdown).toContain('title: "Offboarding"');
    expect(markdown).toContain('source_url: "https://airtable.com/embed/appwUI4Pc2NJPOfmZ/pagHeZnPA3oHwu5Zc/form"');
    expect(markdown).not.toContain("article-stub");
    expect(markdown).not.toContain("validator-ignore");
  });

  it("names the record after the provider when the page gives no title", async () => {
    const files = installFakeRelay(relayMocks);
    fetchMocks.fetchRawHtml.mockRejectedValue(new Error("403"));

    await processArticle(job("https://tally.so/r/w4Ab9"));

    expect([...files.values()][0]).toContain('title: "Tally form"');
  });

  it("refuses a form that already has a record, whichever spelling was used", async () => {
    installFakeRelay(relayMocks);
    fetchMocks.fetchRawHtml.mockResolvedValue("<title>Offboarding - Airtable</title>");
    await processArticle(job("https://airtable.com/appwUI4Pc2NJPOfmZ/pagHeZnPA3oHwu5Zc/form"));

    await expect(
      processArticle(job("https://airtable.com/embed/appwUI4Pc2NJPOfmZ/pagHeZnPA3oHwu5Zc/form")),
    ).rejects.toBeInstanceOf(DuplicateDocumentError);
  });
});
