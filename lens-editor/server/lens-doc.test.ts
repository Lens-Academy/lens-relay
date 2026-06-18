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
    // No `.md` extension and no `|alias` — the canonical lens wikilink form.
    expect(md).toContain("source:: [[../articles/grey-benchmarks]]");
    expect(md).not.toContain("grey-benchmarks.md");
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
    expect(md).toContain("source:: [[../video_transcripts/some-talk]]");
  });

  it("strips the .md, uses no alias, and still YAML-escapes a weird title", () => {
    const md = generateLensMarkdown({
      title: 'A | weird ] title',
      segment: "Article",
      source: "../articles/a.md",
    });
    // Extensionless, alias-free wikilink (no `|` to break, no `.md` to misresolve).
    expect(md).toContain("source:: [[../articles/a]]");
    // The title still carries the display text — escaped for YAML in frontmatter.
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
    expect(md).toContain("source:: [[../articles/grey-benchmarks]]");
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

  it("keeps the source a valid RELATIVE wikilink when lens and doc folders are co-located", async () => {
    // If an operator points RELAY_LENS_FOLDER at the doc folder, relative()
    // yields a bare "foo" — which is NOT a relative wikilink. Must be "./foo".
    process.env.RELAY_LENS_FOLDER = "Lens Edu/articles";
    checkRelayDocsExist.mockResolvedValue({});
    createRelayDoc.mockResolvedValue(undefined);
    try {
      await maybeCreateLens({
        docPath: "Lens Edu/articles/foo.md",
        title: "Foo",
        segment: "Article",
      });
    } finally {
      delete process.env.RELAY_LENS_FOLDER;
    }
    const [, md] = createRelayDoc.mock.calls[0];
    expect(md).toContain("source:: [[./foo]]");
  });
});
