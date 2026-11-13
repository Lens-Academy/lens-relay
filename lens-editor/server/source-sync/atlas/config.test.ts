import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG, DOC1, DOC2, link } from "./__fixtures__/course";
import { chapterRef, configHash, parseAtlasCourses, sameChapter } from "./config";

const parse = (entries: unknown[]) => parseAtlasCourses(JSON.stringify(entries));
const problems = (entry: Record<string, unknown>) => {
  try {
    parse([entry]);
  } catch (err) {
    return (err as Error).message.split("\n");
  }
  return [];
};

describe("parseAtlasCourses", () => {
  it("is off when unset, and reads the example config of the real course", () => {
    expect(parseAtlasCourses(undefined)).toEqual([]);
    expect(parseAtlasCourses("  ")).toEqual([]);
    const example = readFileSync(join(__dirname, "../../../scripts/atlas-sync.config.example.json"), "utf8");
    const [course] = parseAtlasCourses(`[${example}]`);
    expect(course).toMatchObject({ slug: "ai-safety-atlas-v1", folder: "AI Safety Atlas (Google Docs)", filePrefix: "Atlas" });
    expect(course.chapters).toHaveLength(8);
    expect(course.chapters.map((c) => chapterRef(c.doc).tabId)).toContain("t.2iafmf6rj9gc");
    expect(course.chapters[3].authors).toEqual(["Charles Martinet", "Markov Grey", "Su Cizem", "Charbel-Raphaël Segerie"]);
    expect(course.chapters[6]).toMatchObject({ authors: ["Markov Grey"], acknowledgements: expect.arrayContaining(["Charbel-Raphael Segerie"]) });
  });

  it("trims what it is given", () => {
    const [course] = parse([{ ...CONFIG, siteUrl: "https://atlas.test/chapters/v1/", title: " Atlas Test " }]);
    expect(course).toMatchObject({ siteUrl: "https://atlas.test/chapters/v1", title: "Atlas Test" });
  });

  it("names every problem of every entry", () => {
    expect(() => parseAtlasCourses("{")).toThrow(/ATLAS_SYNC_COURSES is not valid JSON/);
    expect(() => parseAtlasCourses("{}")).toThrow("ATLAS_SYNC_COURSES must be a JSON list of courses");
    expect(problems({ ...CONFIG, autors: [] })[0]).toMatch(/^ATLAS_SYNC_COURSES\[0\] has unknown key\(s\) "autors"/);
    expect(problems({ ...CONFIG, title: "" })).toEqual(["ATLAS_SYNC_COURSES[0].title must be a non-empty string"]);
    expect(problems({ ...CONFIG, course: "Lens Edu/Atlas.md" })).toEqual([`ATLAS_SYNC_COURSES[0].course "Lens Edu/Atlas.md" must be the course file's full path, "<Folder>/courses/.../<file>.md"`]);
    expect(problems({ ...CONFIG, course: "Lens Edu/courses/atlas" })).toHaveLength(1);
    expect(problems({ ...CONFIG, filePrefix: "Atlas: v1", folder: "Atlas " })).toEqual([
      'ATLAS_SYNC_COURSES[0].folder "Atlas " must be a plain file name; "Atlas" would be one',
      'ATLAS_SYNC_COURSES[0].filePrefix "Atlas: v1" must be a plain file name; "Atlas - v1" would be one',
    ]);
    expect(problems({ ...CONFIG, folder: "a/b", slug: "Atlas", authors: [] })).toEqual([
      'ATLAS_SYNC_COURSES[0].folder "a/b" must be a plain file name; "a b" would be one',
      'ATLAS_SYNC_COURSES[0].slug "Atlas" must be lower-case words joined by "-"',
      "ATLAS_SYNC_COURSES[0].authors must be a non-empty list of names (Lens articles require one); a chapter's own authors replace them",
    ]);
    expect(problems({ ...CONFIG, chapters: [{ doc: `https://docs.google.com/document/d/${DOC1}/edit` }, { doc: "https://example.org/x" }, link(DOC2), { doc: link(DOC1, "t.1"), autors: [] }] })).toEqual([
      "ATLAS_SYNC_COURSES[0].chapters[0].doc must name its tab: add ?tab=<id> to the link (the Doc's tab ids are in its links)",
      'ATLAS_SYNC_COURSES[0].chapters[1].doc is not a Google Docs link: "https://example.org/x"',
      'ATLAS_SYNC_COURSES[0].chapters[2] must be { "doc": "<Google Docs link with ?tab=>", "authors"?: [names], "acknowledgements"?: [names] }',
      'ATLAS_SYNC_COURSES[0].chapters[3] has unknown key(s) "autors"; the keys are doc, authors, acknowledgements',
    ]);
    expect(problems({ ...CONFIG, chapters: [{ doc: link(DOC1), authors: [], acknowledgements: "Jeanne Salle" }] })).toEqual([
      "ATLAS_SYNC_COURSES[0].chapters[0].authors must be a non-empty list of names, or left out for the course's authors",
      "ATLAS_SYNC_COURSES[0].chapters[0].acknowledgements must be a list of names",
    ]);
    expect(problems({ ...CONFIG, chapters: [{ doc: link(DOC1) }, { doc: link(DOC1, "t.1") }] })).toEqual(["ATLAS_SYNC_COURSES[0].chapters[1] is in the same Doc as .chapters[0]; each chapter must be a Doc of its own"]);
    expect(problems({ ...CONFIG, courseFields: { slug: "x", "partner-url": 3 } })).toEqual(["ATLAS_SYNC_COURSES[0].courseFields must be an object of text fields, none empty"]);
    expect(problems({ ...CONFIG, courseFields: { slug: "x", missing_since: "y" } })).toEqual(["ATLAS_SYNC_COURSES[0].courseFields may not set slug, missing_since: the sync writes them itself"]);
    expect(() => parse([CONFIG, { ...CONFIG, course: "Lens Edu/courses/other.md" }])).toThrow("ATLAS_SYNC_COURSES[1] has the same course file or folder as [0]; they would write the same files");
  });
});

describe("chapter links", () => {
  it("are known by Doc and tab, whatever else the link carries", () => {
    expect(chapterRef(`https://docs.google.com/document/d/${DOC1}/edit?usp=sharing&tab=t.0#heading=h.x`)).toEqual({ docId: DOC1, tabId: "t.0", url: link(DOC1) });
    expect(sameChapter(link(DOC1), `https://docs.google.com/document/u/0/d/${DOC1}/edit?tab=t.0`)).toBe(true);
    expect(sameChapter(link(DOC1), link(DOC1, "t.1"))).toBe(false);
    expect(sameChapter(link(DOC1), link(DOC2))).toBe(false);
    expect(sameChapter(null, link(DOC2))).toBe(false);
  });
});

describe("configHash", () => {
  it("changes with what shapes the files, credits included, and not with how the link is written", () => {
    const hash = configHash(CONFIG);
    expect(configHash({ ...CONFIG, chapters: [{ ...CONFIG.chapters[0], doc: `${link(DOC1)}&usp=sharing` }, CONFIG.chapters[1]] })).toBe(hash);
    expect(configHash({ ...CONFIG, appendicesOptional: true })).toBe(hash);
    expect(configHash({ ...CONFIG, chapters: [{ ...CONFIG.chapters[0], acknowledgements: ["Jeanne Salle"] }, CONFIG.chapters[1]] })).not.toBe(hash);
    expect(configHash({ ...CONFIG, filePrefix: "AISA" })).not.toBe(hash);
  });
});
