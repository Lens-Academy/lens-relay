import { describe, expect, it } from "vitest";
import { CHAPTERS, chapterDoc, DOC1, DOC2, link, wordsOf, type ChapterSpec } from "./__fixtures__/course";
import { planAtlas, printToStore, sectionFingerprint, type AtlasChapter } from "./plan";
import { splitChapter } from "./sections";
import { tabRevision } from "./snapshot";
import type { AtlasLens } from "./types";

const NOW = new Date("2026-11-13T10:00:00Z");

function chaptersOf(specs: ChapterSpec[]): AtlasChapter[] {
  return specs.map((spec, i) => {
    const docId = [DOC1, DOC2][i];
    const tab = chapterDoc(docId, spec).tabs![0].documentTab!;
    const source = { docId, url: link(docId), tab, revision: tabRevision(tab) };
    const { facts, sections } = splitChapter(source);
    return { source, facts, sections };
  });
}

/** The lenses a first run would leave: one per section, with its fingerprint. */
function pinsOf(chapters: AtlasChapter[]): AtlasLens[] {
  return chapters.flatMap(({ facts, source, sections }) =>
    sections.map((s) => ({ key: `${facts.slug}#${s.slug}`, heading: s.headingId, id: `id-${s.slug}`, fingerprint: sectionFingerprint(s), lensPath: `L/${s.title}.md`, articlePath: `A/${s.title}.md`, title: s.title, url: source.url })),
  );
}

let n = 0;
const plan = (chapters: AtlasChapter[], pins: AtlasLens[], missingSince = new Map<string, string>()) =>
  planAtlas(chapters, { pins, missingSince }, { now: NOW, newId: () => `new-${++n}` });

describe("planAtlas", () => {
  it("finds a section whose heading was typed again by its text, in its own chapter only", () => {
    const pins = pinsOf(chaptersOf(CHAPTERS()));
    const specs = CHAPTERS();
    specs[0].sections[1] = { ...specs[0].sections[1], title: "Foundation Models Today", heading: "h.typed-again" };
    // A section moved to another chapter is new there.
    specs[1].sections.push(specs[0].sections.splice(2, 1)[0]);
    const result = plan(chaptersOf(specs), pins);
    const ids = result.chapters.flatMap((c) => c.sections.map((s) => [s.key, s.id]));
    expect(ids).toContainEqual(["capabilities#foundation-models-today", "id-foundation-models"]);
    expect(ids).toContainEqual(["risks#scaling", expect.stringMatching(/^new-/)]);
    expect(result.chapters[0].waiting.map((pin) => pin.key)).toEqual(["capabilities#scaling"]);
    expect(result.missingSince).toEqual(new Map([["id-scaling", NOW.toISOString()]]));
  });

  it("keeps the ids of a renamed chapter, by its Doc", () => {
    const pins = pinsOf(chaptersOf(CHAPTERS()));
    const specs = CHAPTERS();
    specs[1].title = "Risks of AI";
    const result = plan(chaptersOf(specs), pins);
    expect(result.chapters[1].sections.map((s) => [s.key, s.id])).toEqual([
      ["risks-of-ai#risk-decomposition", "id-risk-decomposition"],
      ["risks-of-ai#misuse", "id-misuse"],
    ]);
    expect(result.retired).toEqual([]);
  });

  it("finds a lens by an address only when one section has it", () => {
    const specs = CHAPTERS();
    for (const s of specs[1].sections) s.heading = null;
    const pins = pinsOf(chaptersOf(specs));
    specs[1].sections.push({ title: "Misuse", heading: null, words: wordsOf("again") });
    const result = plan(chaptersOf(specs), pins);
    // Two sections are now "risks#misuse": the lens goes by its text to the one it was.
    expect(result.chapters[1].sections.map((s) => [s.key, s.id])).toEqual([
      ["risks#risk-decomposition", "id-risk-decomposition"],
      ["risks#misuse", "id-misuse"],
      ["risks#misuse", expect.stringMatching(/^new-/)],
    ]);
  });

  it("retires a lens missed for an hour", () => {
    const pins = pinsOf(chaptersOf(CHAPTERS()));
    const specs = CHAPTERS();
    specs[0].sections.pop();
    const result = plan(chaptersOf(specs), pins, new Map([["id-appendix-expert-surveys", "2026-11-13T08:59:00.000Z"]]));
    expect(result.retired.map(({ pin }) => pin.key)).toEqual(["capabilities#appendix-expert-surveys"]);
    expect(result.chapters[0].waiting).toEqual([]);
    expect(result.missingSince.size).toBe(0);
  });
});

describe("printToStore", () => {
  it("keeps the stored fingerprint through a small edit, and renews it after a large one", () => {
    const [chapter] = chaptersOf(CHAPTERS());
    const stored = sectionFingerprint(chapter.sections[1]);
    const small = CHAPTERS();
    small[0].sections[1].words[7] = "edited";
    expect(printToStore(stored, sectionFingerprint(chaptersOf(small)[0].sections[1]))).toBe(stored);
    const large = CHAPTERS();
    large[0].sections[1].words = wordsOf("other");
    const fresh = sectionFingerprint(chaptersOf(large)[0].sections[1]);
    expect(printToStore(stored, fresh)).toBe(fresh);
    expect(printToStore("", fresh)).toBe(fresh);
  });
});
