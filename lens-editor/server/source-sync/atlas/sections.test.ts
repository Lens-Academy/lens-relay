import { describe, expect, it } from "vitest";
import type { DocumentTab, StructuralElement } from "../google-docs/docs-types";
import { heading, image, para, run, table, text } from "../google-docs/__fixtures__/docs";
import { atlasSlug, splitChapter } from "./sections";
import type { ChapterSource } from "./types";

const chapter = (content: StructuralElement[], extra: Partial<DocumentTab> = {}): ChapterSource => ({
  docId: "doc",
  url: "https://docs.google.com/document/d/doc/edit?tab=t.0",
  tab: { body: { content }, ...extra },
  revision: "r1",
});
const describes = (s: string) => table([["type", [text("section-description")]], ["content", [text(s)]]]);
const empty = text("");

describe("atlasSlug", () => {
  it.each([
    ["Weak-to-Strong (W2S)", "weak-to-strong-w2s"],
    ["Appendix: Forecasting", "appendix-forecasting"],
    ["Généralisation", "gnralisation"],
    ["Learning  from\timitation", "learning-from-imitation"],
    ["AI's 'risks' & more", "ais-risks-more"],
    [" - Edge - ", "-edge-"],
    ["snake_case stays", "snake_case-stays"],
  ])("%s", (input, slug) => {
    expect(atlasSlug(input)).toBe(slug);
  });
});

describe("splitChapter", () => {
  it("reads the chapter from TITLE and SUBTITLE and starts a section at each Heading 1 with text", () => {
    const { facts, sections, warnings } = splitChapter(
      chapter([
        { sectionBreak: {} },
        heading("TITLE", "Chapter 8 - Scalable Oversight"),
        heading("SUBTITLE", "Keeping control."),
        empty,
        heading(1, ""),
        heading(1, "Introduction"),
        text("First."),
        heading(1, "  "),
        text("Still the introduction."),
        heading(1, "Weak-to-Strong (W2S)"),
        heading(2, "Detail"),
        heading(1, "Appendix: Debate"),
      ]),
    );
    expect(warnings).toEqual([]);
    expect(facts).toEqual({ number: 8, title: "Scalable Oversight", slug: "scalable-oversight" });
    expect(sections.map(({ number, title, slug, appendix }) => ({ number, title, slug, appendix }))).toEqual([
      { number: 1, title: "Introduction", slug: "introduction", appendix: false },
      { number: 2, title: "Weak-to-Strong (W2S)", slug: "weak-to-strong-w2s", appendix: false },
      { number: 3, title: "Appendix: Debate", slug: "appendix-debate", appendix: true },
    ]);
    // An empty Heading 1 neither ends a section nor is dropped from it.
    expect(sections[0].content).toEqual([text("First."), heading(1, "  "), text("Still the introduction.")]);
    expect(sections.every((s) => s.chapter === facts)).toBe(true);
  });

  it("leaves out what comes before the first section, and says so when a reader would have seen it", () => {
    const { sections, warnings } = splitChapter(
      chapter([heading("TITLE", "Chapter 2 - Risks"), text("Draft note."), image("kix.a"), describes("Orphan."), heading(1, "Introduction"), text("Body.")]),
    );
    expect(sections).toHaveLength(1);
    expect(sections[0].content).toEqual([text("Body.")]);
    expect(warnings).toEqual(["Chapter 2 (Risks): 3 element(s) before the first section were left out"]);
  });

  it("keeps a table that comes straight after a section's heading", () => {
    const figure = table([["type", [text("figure")]], ["content", [image("kix.f")]], ["caption", [text("Scaling.")]]]);
    const { sections } = splitChapter(chapter([heading("TITLE", "Chapter 1 - Capabilities"), heading(1, "Introduction"), figure, text("After.")]));
    expect(sections[0].content).toEqual([figure, text("After.")]);
  });

  it("takes the description from the section's own section-description table, wherever it is in the section", () => {
    const box = table([["type", [text("noteBox")]], ["content", [describes("Nested, not the section's.")]]]);
    const { sections, warnings } = splitChapter(
      chapter([
        heading("TITLE", "Chapter 1 - Capabilities"),
        heading(1, "First"),
        describes("What the first is about."),
        heading(1, "Second"),
        text("Lead-in."),
        heading(1, ""),
        table([["type", [text("section-description")]], ["content", [para([run("Late\u000bdescription.\n")])]]]),
        heading(1, "Third"),
        box,
        heading(1, "Fourth"),
        describes("One."),
        describes("Two."),
      ]),
    );
    expect(sections.map((s) => s.description)).toEqual(["What the first is about.", "Late description.", null, "One."]);
    expect(warnings).toEqual(['Chapter 1 (Capabilities): section "Fourth" has 2 section-description tables; the first is used']);
  });

  it("counts the words a reader reads: text, list items and component text, not headings or the description", () => {
    const { sections } = splitChapter(
      chapter([
        heading("TITLE", "Chapter 1 - Capabilities"),
        heading(1, "Introduction"),
        describes("Not counted here."),
        heading(2, "A heading is not read"),
        text("One two\u000bthree."), // 3: a manual line break separates words
        para([run("four five\n")], "NORMAL_TEXT", { listId: "l" }), // 2
        table([["type", [text("figure")]], ["content", [image("kix.f")]], ["caption", [text("six seven")]]]), // 2
        table([["type", [text("quote")]], ["content", [text("eight")]], ["speaker", [text("Not Counted")]], ["source-url", [text("nine")]]]), // 2
        table([["type", [text("noteBox")]], ["title", [text("Box title")]], ["content", [text("ten"), table([["type", [text("definition")]], ["term", [text("Term")]], ["content", [text("eleven twelve")]], ["source", [text("thirteen")]]])]]]), // 4
        {
          table: {
            columns: 3,
            tableRows: [{ tableCells: [{ content: [text("fourteen")] }, { content: [text("fifteen")] }, { content: [text("sixteen")] }] }],
          },
        }, // 3
      ]),
    );
    expect(sections[0].words).toBe(16);
  });

  it("joins no words across a manual line break in a section heading", () => {
    const { sections } = splitChapter(chapter([heading("TITLE", "Chapter 1 - Capabilities"), para([run("Current\u000bCapabilities\n")], "HEADING_1")]));
    expect(sections[0]).toMatchObject({ title: "Current Capabilities", slug: "current-capabilities" });
  });

  it("reports a TITLE it cannot read, sections without a slug and sections sharing one", () => {
    const out = splitChapter(chapter([heading("TITLE", "Capabilities"), heading(1, "Risks"), heading(1, "Risks!"), heading(1, "ÉÉ")]));
    expect(out.facts).toEqual({ number: 0, title: "Capabilities", slug: "capabilities" });
    expect(out.warnings).toEqual([
      'the TITLE "Capabilities" does not read "Chapter <number> - <title>"',
      'Chapter 0 (Capabilities): two sections have the slug "risks"',
      'Chapter 0 (Capabilities): section "ÉÉ" has no slug (no ASCII letters or digits)',
    ]);
    expect(splitChapter(chapter([text("No title, no sections.")])).warnings).toEqual([
      'the tab has no TITLE paragraph "Chapter <number> - <title>"',
      "Chapter 0 (Untitled): 1 element(s) before the first section were left out",
      "Chapter 0 (Untitled): no Heading 1 with text, so the chapter has no sections",
    ]);
  });

  it("keys a section by its heading's id, and gives a chapter whose title has no ASCII letters an address of its own", () => {
    const h1 = (title: string, headingId: string) => ({ paragraph: { elements: [run(`${title}\n`)], paragraphStyle: { namedStyleType: "HEADING_1", headingId } } });
    const { facts, sections } = splitChapter(chapter([heading("TITLE", "Глава 3 - Стратегии"), h1("Введение", "h.abc"), heading(1, "Later")]));
    expect(facts).toEqual({ number: 3, title: "Стратегии", slug: "chapter-3" });
    expect(sections.map(({ slug, headingId }) => [slug, headingId])).toEqual([["", "h.abc"], ["later", null]]);
  });
});
