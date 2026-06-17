import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the relay client so maybeCreateLens can be tested without a relay.
const { createRelayDoc, checkRelayDocsExist } = vi.hoisted(() => ({
  createRelayDoc: vi.fn(),
  checkRelayDocsExist: vi.fn(),
}));
vi.mock("./add-video/relay-docs", () => ({ createRelayDoc, checkRelayDocsExist }));

import { generateLensMarkdown, maybeCreateLens } from "./lens-doc";

describe("generateLensMarkdown", () => {
  it("renders a whole-article lens in the content-processor's flat format", () => {
    const md = generateLensMarkdown({
      id: "abc-123",
      title: "Benchmarks",
      segment: "Article",
      source: "../articles/grey-benchmarks.md",
    });
    expect(md).toContain("id: abc-123");
    expect(md).toContain('title: "Benchmarks"');
    expect(md).toMatch(/^#### Article$/m);
    expect(md).toContain(
      "source:: [[../articles/grey-benchmarks.md|Benchmarks]]",
    );
  });

  it("generates a UUID id and a Video segment when asked", () => {
    const md = generateLensMarkdown({
      title: "Some Talk",
      segment: "Video",
      source: "../video_transcripts/some-talk.md",
    });
    expect(md).toMatch(
      /^id: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/m,
    );
    expect(md).toMatch(/^#### Video$/m);
  });

  it("quotes the YAML title and strips wikilink-breaking chars from the label", () => {
    const md = generateLensMarkdown({
      title: 'A | weird ] title',
      segment: "Article",
      source: "../articles/a.md",
    });
    // []| removed from the [[path|label]] display so the wikilink stays valid
    expect(md).toContain("source:: [[../articles/a.md|A weird title]]");
    // frontmatter title escaped for YAML
    expect(md).toContain('title: "A | weird ] title"');
  });
});

describe("maybeCreateLens", () => {
  beforeEach(() => {
    createRelayDoc.mockReset();
    checkRelayDocsExist.mockReset();
  });

  it("writes a lens with the mirrored path and a relative source wikilink", async () => {
    checkRelayDocsExist.mockResolvedValue({
      "Lens Edu/Lenses/grey-benchmarks.md": false,
    });
    createRelayDoc.mockResolvedValue(undefined);

    const p = await maybeCreateLens({
      docPath: "Lens Edu/articles/grey-benchmarks.md",
      title: "Benchmarks",
      segment: "Article",
    });

    expect(p).toBe("Lens Edu/Lenses/grey-benchmarks.md");
    expect(createRelayDoc).toHaveBeenCalledTimes(1);
    const [writtenPath, md] = createRelayDoc.mock.calls[0];
    expect(writtenPath).toBe("Lens Edu/Lenses/grey-benchmarks.md");
    expect(md).toContain(
      "source:: [[../articles/grey-benchmarks.md|Benchmarks]]",
    );
  });

  it("skips (returns null) when a lens of that name already exists", async () => {
    checkRelayDocsExist.mockResolvedValue({ "Lens Edu/Lenses/foo.md": true });
    const p = await maybeCreateLens({
      docPath: "Lens Edu/articles/foo.md",
      title: "Foo",
      segment: "Article",
    });
    expect(p).toBeNull();
    expect(createRelayDoc).not.toHaveBeenCalled();
  });
});
