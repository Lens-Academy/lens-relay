import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DocsDocument, DocsTab, DocumentTab, StructuralElement } from "../google-docs/docs-types";
import { heading, image, para, run, table, text } from "../google-docs/__fixtures__/docs";
import { atlasComponent } from "../google-docs/to-markdown";
import { convertSection } from "./convert";
import { splitChapter } from "./sections";
import type { ChapterCounters, ChapterSource } from "./types";

const source = (content: StructuralElement[], extra: Partial<DocumentTab> = {}): ChapterSource => ({
  docId: "doc",
  url: "https://docs.google.com/document/d/doc/edit?tab=t.0",
  tab: { body: { content }, ...extra },
  revision: "r1",
});
const imageUrl = (id: string) => (id.startsWith("missing") ? null : `https://img.test/${id}.png`);

/** Every section of a chapter converted in order, as the sync does: one counters map per chapter. */
function convertChapter(chapter: ChapterSource) {
  const counters: ChapterCounters = new Map();
  const { sections } = splitChapter(chapter);
  return sections.map((section) => convertSection(section, chapter, imageUrl, counters));
}

const describes = (s: string) => table([["type", [text("section-description")]], ["content", [para([run(s), run(" here", { italic: true }), run(".\n")])]]]);
const ref = (id: string, n: string) => ({ footnoteReference: { footnoteId: id, footnoteNumber: n } });
const figure = (id: string) => table([["type", [text("figure")]], ["content", [image(id)]], ["caption", [text(`Caption ${id}.`)]]]);

describe("convertSection", () => {
  it("writes the description and a rule, then the content and the footnotes it references, without the heading", () => {
    const chapter = source(
      [
        heading("TITLE", "Chapter 1 - Capabilities"),
        heading(1, "Introduction"),
        text("Opening."),
        describes("Why capabilities matter"),
        heading(2, "Detail"),
        para([run("Claim"), ref("f2", "2"), run(".\n")]),
        heading(1, ""),
        heading(3, "Deeper"),
        heading(1, "Next"),
        para([run("Other"), ref("f1", "1"), run(".\n")]),
      ],
      { footnotes: { f1: { content: [text("First note.")] }, f2: { content: [text("Second note.")] } } },
    );
    const [intro, next] = convertChapter(chapter);
    expect(intro).toEqual({
      markdown:
        "Why capabilities matter *here*.\n\n---\n\nOpening.\n\n## Detail\n\nClaim[^note-2].\n\n### Deeper\n\n[^note-2]: Second note.\n",
      warnings: [],
    });
    expect(next.markdown).toBe("Other[^note-1].\n\n[^note-1]: First note.\n");
  });

  it("numbers figures, interactive figures, videos and definitions on across the sections of a chapter", () => {
    const iframe = table([["type", [text("iframe")]], ["src", [text("https://owid.test/g")]], ["still_image", [image("kix.s")]]]);
    const video = table([["type", [text("video")]], ["source", [text("https://youtu.be/x")]]]);
    const definition = table([["type", [text("definition")]], ["term", [text("AGI")]], ["content", [text("General.")]]]);
    const box = table([["type", [text("noteBox")]], ["title", [text("Aside")]], ["content", [figure("kix.n")]]]);
    const [first, second] = convertChapter(
      source([
        heading("TITLE", "Chapter 3 - Strategies"),
        heading(1, "One"),
        figure("kix.a"),
        box,
        video,
        definition,
        heading(1, "Two"),
        figure("kix.b"),
        iframe,
        video,
        definition,
      ]),
    );
    expect(first.markdown).toContain("*Figure 3.1: Caption kix.a.*");
    expect(first.markdown).toContain("*Figure 3.2: Caption kix.n.*");
    expect(second.markdown).toBe(
      "![Figure 3.3](https://img.test/kix.b.png)\n\n*Figure 3.3: Caption kix.b.*\n\n" +
        "![Interactive figure 3.1](https://img.test/kix.s.png)\n\n*Interactive figure 3.1* ([Open the interactive version](https://owid.test/g))\n\n" +
        "*Video 3.2* ([Watch the video](https://youtu.be/x))\n\n**Definition 3.2: AGI** — General.\n",
    );
  });

  it("writes no rule when the section has no description, and leaves out a second description", () => {
    const [only] = convertChapter(
      source([heading("TITLE", "Chapter 1 - Capabilities"), heading(1, "Introduction"), text("Body."), describes("A"), describes("B")]),
    );
    expect(only.markdown).toBe("A *here*.\n\n---\n\nBody.\n");
    const [plain] = convertChapter(source([heading("TITLE", "Chapter 1 - Capabilities"), heading(1, "Introduction"), text("Body.")]));
    expect(plain.markdown).toBe("Body.\n");
  });

  it("says which section a warning is about", () => {
    const [out] = convertChapter(source([heading("TITLE", "Chapter 2 - Risks"), heading(1, "Misuse"), image("missing.x")]));
    expect(out.warnings).toEqual(["Section 2.1 (Misuse): an image (missing.x) could not be hosted and was left out"]);
  });
});

// --- Today's Atlas, from a local dump ------------------------------------------

/**
 * Opt-in: ATLAS_FIXTURE is a JSON file `{ <docId>: <Docs API document with
 * all tabs> }` holding the 8 chapter Docs (scripts dump one). When an
 * `images/<docId>/<objectId>.<ext>` folder sits beside it, images get URLs
 * from their bytes, as hosting gives them, so copies of a picture share one.
 */
const FIXTURE = process.env.ATLAS_FIXTURE;
const CHAPTER_TABS: [string, string][] = [
  ["1hWdq25Nw17538nk5aNG1_a8PxfNUhFKfaa9r0H6fRP4", "t.0"],
  ["1TzouUrIM5SaJ0UJVXzk2SjDHPYaS7ue4tEy-9pHOVj4", "t.0"],
  ["1vWbtZ4_nXwlGHWHPzvBYG5-__kNfkq5t3-b-pmDd1KI", "t.2iafmf6rj9gc"],
  ["16Dk4IRy1NoMSB5K_dKqR8XnwJ2PjX1LofoPGX_35o0k", "t.0"],
  ["165SypJtK-9S3Plot19EViZhjeRptivJELuWvUglQXa0", "t.0"],
  ["1xek7xTWiNI4UWQOPmHBeMgmuRkCx6Yamd-a_5tzrxKg", "t.0"],
  ["11YpIAKCHaB0yxYVBEkGEdmaC2haxlNRB2ua-dQflO8Y", "t.0"],
  ["1Z5YL7x65G06oy-cUT-h_kTFYlAB7wF4xooXijATbIf0", "t.0"],
];

function findTab(tabs: DocsTab[] | undefined, id: string): DocsTab | undefined {
  for (const tab of tabs ?? []) {
    const found = tab.tabProperties?.tabId === id ? tab : findTab(tab.childTabs, id);
    if (found) return found;
  }
}

/** Tables of this type anywhere in these elements, inside other tables too. */
function countTables(elements: StructuralElement[], type: string): number {
  return elements.reduce((n, el) => {
    if (!el.table) return n;
    const inside = (el.table.tableRows ?? []).flatMap((row) => (row.tableCells ?? []).map((cell) => countTables(cell.content ?? [], type)));
    return n + (atlasComponent(el.table).type === type ? 1 : 0) + inside.reduce((a, b) => a + b, 0);
  }, 0);
}

describe.skipIf(!FIXTURE)("the Atlas's 8 chapters, split and converted", () => {
  const docs = FIXTURE ? (JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, DocsDocument>) : {};
  const images = FIXTURE ? join(dirname(FIXTURE), "images") : "";
  const manifest = existsSync(join(images, "manifest.json"))
    ? (JSON.parse(readFileSync(join(images, "manifest.json"), "utf8")) as Record<string, Record<string, { file: string }>>)
    : {};
  const hostedUrl = (docId: string) => (id: string) => {
    const file = manifest[docId]?.[id]?.file;
    return file ? `https://img.test/${createHash("sha256").update(readFileSync(join(images, file))).digest("hex").slice(0, 12)}` : imageUrl(id);
  };

  it.each(CHAPTER_TABS.map((tab, i) => [i + 1, ...tab] as const))("chapter %i", (number, docId, tabId) => {
    const tab = findTab(docs[docId]?.tabs, tabId)?.documentTab;
    expect(tab).toBeDefined();
    const chapter: ChapterSource = { docId, url: `https://docs.google.com/document/d/${docId}/edit?tab=${tabId}`, tab: tab!, revision: "" };
    const { facts, sections, warnings } = splitChapter(chapter);
    expect(facts.number).toBe(number);
    expect(sections.length).toBeGreaterThan(0);

    const counters: ChapterCounters = new Map();
    const converted = sections.map((section) => convertSection(section, chapter, hostedUrl(docId), counters));
    for (const [i, section] of sections.entries()) {
      expect(section.words, section.title).toBeGreaterThan(0);
      expect(converted[i].markdown.trim(), section.title).not.toBe("");
    }
    // Every figure, numbered 1..n in document order across the sections.
    const figures = countTables(tab!.body?.content ?? [], "figure");
    expect(counters.get("Figure") ?? 0).toBe(figures);
    const labels = converted.flatMap((c) => [...c.markdown.matchAll(/^\*Figure (\d+)\.(\d+)/gm)].map((m) => `${m[1]}.${m[2]}`));
    expect(labels).toEqual(Array.from({ length: figures }, (_, i) => `${number}.${i + 1}`));
    // No picture shown twice in a row.
    for (const { markdown } of converted) {
      const shown = [...markdown.matchAll(/^!\[[^\]]*\]\(([^)]+)\)$/gm)].map((m) => m[1]);
      expect(shown.filter((url, i) => url === shown[i - 1])).toEqual([]);
    }

    console.log(
      [
        `Chapter ${facts.number} - ${facts.title} (${facts.slug}): ${sections.length} sections, ${figures} figures, ` +
          `counters ${JSON.stringify(Object.fromEntries(counters))}`,
        ...sections.map((s) => `  ${s.number}. ${s.slug}${s.appendix ? " (appendix)" : ""}: ${s.words} words${s.description ? "" : ", no description"}`),
        ...[...warnings, ...converted.flatMap((c) => c.warnings)].map((w) => `  ! ${w}`),
      ].join("\n"),
    );
  });
});
