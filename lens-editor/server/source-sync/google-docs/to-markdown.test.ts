import { describe, expect, it } from "vitest";
import { convertDocumentTab, escapeInline } from "./to-markdown";
import type { DocumentTab, ParagraphElement, StructuralElement, TextStyle } from "./docs-types";

// --- Docs JSON builders -----------------------------------------------------

const run = (content: string, textStyle: TextStyle = {}): ParagraphElement => ({ textRun: { content, textStyle } });
const para = (
  elements: ParagraphElement[],
  namedStyleType = "NORMAL_TEXT",
  bullet?: { listId: string; nestingLevel?: number },
): StructuralElement => ({ paragraph: { elements, paragraphStyle: { namedStyleType }, bullet } });
const text = (s: string, style?: TextStyle) => para([run(`${s}\n`, style)]);
const heading = (level: number | "TITLE" | "SUBTITLE", s: string) =>
  para([run(`${s}\n`)], typeof level === "number" ? `HEADING_${level}` : level);
const image = (id: string) => para([{ inlineObjectElement: { inlineObjectId: id } }, run("\n")]);
const table = (rows: [string, StructuralElement[]][]): StructuralElement => ({
  table: {
    columns: 2,
    tableRows: rows.map(([key, value]) => ({ tableCells: [{ content: [text(key)] }, { content: value }] })),
  },
});

function convert(content: StructuralElement[], extra: Partial<DocumentTab> = {}) {
  return convertDocumentTab(
    { body: { content }, ...extra },
    { imageUrl: (id) => (id.startsWith("missing") ? null : `https://img.test/${id}.png`) },
  );
}

// --- Plain Docs structure ---------------------------------------------------

describe("document structure", () => {
  it("takes TITLE and SUBTITLE as metadata and maps heading levels", () => {
    const out = convert([
      heading("TITLE", "Chapter 3 - Strategies"),
      heading("SUBTITLE", "How we might make AI go well."),
      heading(1, "Introduction"),
      text("Body."),
      heading(2, "Detail"),
      heading(1, "   "),
    ]);
    expect(out.title).toBe("Chapter 3 - Strategies");
    expect(out.description).toBe("How we might make AI go well.");
    expect(out.body).toBe("# Introduction\n\nBody.\n\n## Detail\n");
  });

  it("renders emphasis with whitespace outside the markers", () => {
    const out = convert([para([run("Plain "), run("bold ", { bold: true }), run("and "), run("both", { bold: true, italic: true }), run(" ~gone~\n", { strikethrough: true })])]);
    expect(out.body.trim()).toBe("Plain **bold** and ***both*** ~~\\~gone\\~~~");
  });

  it("keeps a bold run's closing marker valid when the next word touches it", () => {
    const out = convert([para([run("making AI safe.", { bold: true }), run("If progress\n")])]);
    expect(out.body.trim()).toBe("**making AI safe**.If progress");
  });

  it("links runs, merging differently styled runs of one link and unlinking bare spaces", () => {
    const link = { url: "https://example.org/a (b)" };
    const out = convert([para([run(" ", { link }), run("Mnih ", { link, italic: true }), run("2013", { link }), run(" said\n")])]);
    expect(out.body.trim()).toBe("[*Mnih* 2013](https://example.org/a%20%28b%29) said");
  });

  it("escapes markdown syntax in prose, including at the start of a line", () => {
    expect(escapeInline("a*b [x] `c` $5 ~3 <br> snake_case _x_ 100%%")).toBe(
      "a\\*b \\[x\\] \\`c\\` \\$5 \\~3 \\<br\\> snake_case \\_x\\_ 100\\%\\%",
    );
    const out = convert([text("# not a heading"), text("1. not a list"), text(":::callout not a box")]);
    expect(out.body).toBe("\\# not a heading\n\n1\\. not a list\n\n\\::\\:callout not a box\n");
  });

  it("nests lists by level and numbers ordered ones", () => {
    const lists = {
      o: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }, { glyphSymbol: "●" }] } },
    };
    const out = convert(
      [
        para([run("one\n")], "NORMAL_TEXT", { listId: "o" }),
        para([run("sub\n")], "NORMAL_TEXT", { listId: "o", nestingLevel: 1 }),
        para([run("two\u000bmore\n")], "NORMAL_TEXT", { listId: "o" }),
        text("after"),
      ],
      { lists },
    );
    expect(out.body).toBe("1. one\n    - sub\n2. two\n   more\n\nafter\n");
  });

  it("turns native footnotes into typed ids with definitions at the end", () => {
    const out = convert(
      [para([run("Claim"), { footnoteReference: { footnoteId: "f1", footnoteNumber: "1" } }, run(".\n")])],
      { footnotes: { f1: { content: [text("The source.")] } } },
    );
    expect(out.body).toBe("Claim[^note-1].\n\n[^note-1]: The source.\n");
  });

  it("splits maths out of text and translates Typst to TeX", () => {
    const out = convert([text("Cost is $2 times 10^29$ FLOP, or \\$5. $ sum_(t=0)^infinity gamma^t $ ends it.")]);
    expect(out.body).toBe(
      "Cost is $2 \\times 10^{29}$ FLOP, or \\$5.\n\n$$\n\\sum_{t=0}^{\\infty} \\gamma^{t}\n$$\n\nends it.\n",
    );
  });

  it("treats a paragraph of bare TeX as display maths, with a warning", () => {
    const out = convert([text("\\begin{align*} a = \\frac{b}{c} \\end{align*}")]);
    expect(out.body).toBe("$$\n\\begin{align*} a = \\frac{b}{c} \\end{align*}\n$$\n");
    expect(out.warnings[0]).toMatch(/TeX outside/);
  });

  it("embeds inline images and warns about ones that could not be hosted", () => {
    const out = convert([image("kix.a"), image("missing.b")]);
    expect(out.body).toBe("![](https://img.test/kix.a.png)\n");
    expect(out.warnings).toEqual(["an image (missing.b) could not be hosted and was left out"]);
  });

  it("renders horizontal rules and ordinary tables", () => {
    const out = convert([
      para([{ horizontalRule: {} }, run("\n")]),
      {
        table: {
          columns: 3,
          tableRows: [
            { tableCells: [{ content: [text("A")] }, { content: [text("B|C")] }, { content: [text("D")] }] },
            { tableCells: [{ content: [text("1")] }, { content: [text("2")] }, { content: [text("3")] }] },
          ],
        },
      },
    ]);
    expect(out.body).toBe("---\n\n| A | B\\|C | D |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n");
  });

  it("keeps internal links as text and says how many", () => {
    const out = convert([
      para([run("see ", {}), run("Scaling", { link: { headingId: "h.x" } }), run(" and "), run("Notes\n", { link: { tabId: "t.1" } })]),
    ]);
    expect(out.body.trim()).toBe("see Scaling and Notes");
    expect(out.warnings).toEqual(["2 link(s) to headings, bookmarks or tabs inside the doc were kept as plain text"]);
  });
});

// --- Atlas components -------------------------------------------------------

describe("Atlas components", () => {
  const chapter = heading("TITLE", "Chapter 2 - Risks");

  it("numbers figures within the chapter and italicises the caption", () => {
    const out = convert([
      chapter,
      table([["type", [text("figure")]], ["content", [image("kix.f1")]], ["caption", [para([run("Scaling "), run("laws", { italic: true }), run(" (2020).\n")])]]]),
      // Some Atlas figures carry the image in a `source` row.
      table([["type", [text("figure")]], ["source", [image("kix.f2")]], ["caption", [text("Second")]]]),
    ]);
    expect(out.body).toBe(
      "![Figure 2.1](https://img.test/kix.f1.png)\n\n*Figure 2.1: Scaling laws (2020).*\n\n" +
        "![Figure 2.2](https://img.test/kix.f2.png)\n\n*Figure 2.2: Second*\n",
    );
  });

  it("links videos and interactive figures from their captions", () => {
    const out = convert([
      table([["type", [text("video")]], ["source", [text("https://youtu.be/x")]], ["caption", [text("A talk.")]]]),
      table([["type", [text("iframe")]], ["src", [text("https://ourworldindata.org/g")]], ["still_image", [image("kix.s")]], ["caption", [text("A chart.")]]]),
    ]);
    expect(out.body).toBe(
      "*Video 1: A talk.* ([Watch the video](https://youtu.be/x))\n\n" +
        "![Interactive figure 1](https://img.test/kix.s.png)\n\n" +
        "*Interactive figure 1: A chart.* ([Open the interactive version](https://ourworldindata.org/g))\n",
    );
  });

  it("renders a quote with its attribution", () => {
    const out = convert([
      table([
        ["type", [text("quote")]],
        ["content", [text("First line."), text("Second line.")]],
        ["speaker", [text("Garry Kasparov")]],
        ["position", [text("Chess Grandmaster")]],
        ["date", [text("1997")]],
        ["source-url", [text("https://ibm.com/deep-blue")]],
      ]),
    ]);
    expect(out.body).toBe(
      "> First line.\n>\n> Second line.\n> — [Garry Kasparov](https://ibm.com/deep-blue), Chess Grandmaster (1997)\n",
    );
  });

  it("renders a definition as a bold lead-in with its source", () => {
    const out = convert([
      table([["type", [text("definition")]], ["term", [text("AGI")]], ["content", [text("General AI.")]], ["source", [text("(Morris, 2024)")]]]),
    ]);
    expect(out.body).toBe("**Definition: AGI** — General AI. (Morris, 2024)\n");
  });

  it("turns note boxes and callouts into callouts, growing the fence around nested ones", () => {
    const out = convert([
      table([
        ["type", [text("noteBox")]],
        ["title", [text('The "bitter" lesson {1}')]],
        [
          "content",
          [text("Outer text."), table([["type", [text("callout")]], ["flavor", [text("warning")]], ["content", [text("Careful.")]]])],
        ],
      ]),
      table([["type", [text("noteBox")]], ["title", [text("Open box")]], ["collapsed", [text("no")]], ["content", [text("Shown.")]]]),
    ]);
    expect(out.body).toBe(
      `::::callout{title="The 'bitter' lesson 1" tone="neutral" collapse="closed"}\n\nOuter text.\n\n` +
        `:::callout{title="Warning" tone="amber"}\n\nCareful.\n\n:::\n\n::::\n\n` +
        `:::callout{title="Open box" tone="neutral"}\n\nShown.\n\n:::\n`,
    );
  });

  it("renders a section description as the lead paragraph and rule", () => {
    const out = convert([heading(1, "Risks"), table([["type", [text("section-description")]], ["content", [text("Why it matters.")]]])]);
    expect(out.body).toBe("# Risks\n\nWhy it matters.\n\n---\n");
  });

  it("reports what it cannot carry over instead of dropping it silently", () => {
    const out = convert([
      table([["type", [text("figure")]], ["caption", [text("Empty")]]]),
      table([["type", [text("hologram")]], ["content", [text("?")]]]),
      table([["src", [text("https://x.test")]], ["caption", [text("No type row")]]]),
      text("A leftover [^footnote_x] marker."),
    ]);
    expect(out.body).toBe(
      "*Figure 1: Empty*\n\n| type | hologram |\n| --- | --- |\n| content | ? |\n\n" +
        "| src | https://x.test |\n| --- | --- |\n| caption | No type row |\n\nA leftover \\[\\^footnote_x\\] marker.\n",
    );
    expect(out.warnings).toEqual([
      "Figure 1 has no image",
      'a two-column table with a "type" row of "hologram" is shown as a plain table',
      'a table looks like a component but has no "type" row, so it is shown as a plain table',
      "text contains a markdown footnote marker, not a Docs footnote: [^footnote_x]",
    ]);
  });

  it("keeps an ordinary data table whose first column says Type", () => {
    const out = convert([table([["Type", [text("Example")]], ["Misuse", [text("Bioweapons")]]])]);
    expect(out.body).toBe("| Type | Example |\n| --- | --- |\n| Misuse | Bioweapons |\n");
  });

  it("reports what a component cannot hold: extra images, text beside an image, tables in cells, empty terms", () => {
    const out = convert([
      table([["type", [text("figure")]], ["content", [image("kix.a"), image("kix.b"), text("stray words")]]]),
      table([["type", [text("definition")]], ["term", [text("")]], ["content", [text("Meaning.")]]]),
      table([["type", [text("quote")]], ["content", [text("Said."), table([["x", [text("y")]]])]]]),
    ]);
    expect(out.body).toBe(
      "![Figure 1](https://img.test/kix.a.png)\n\n*Figure 1*\n\n**Definition** — Meaning.\n\n> Said.\n",
    );
    expect(out.warnings).toEqual([
      "Figure 1: only the first of 2 images is kept",
      "Figure 1: text beside the image was left out",
      "a definition has no term",
    ]);
  });

  it("takes a video's URL from its link when the source row is linked text", () => {
    const out = convert([
      table([["type", [text("video")]], ["source", [para([run("Watch here\n", { link: { url: "https://youtu.be/x" } })])]]]),
    ]);
    expect(out.body).toBe("*Video 1* ([Watch the video](https://youtu.be/x))\n");
  });

  it("numbers figures from a chapter title in another language", () => {
    const out = convert([heading("TITLE", "Chapitre 7 - Généralisation"), table([["type", [text("figure")]], ["content", [image("kix.a")]]])]);
    expect(out.body).toContain("*Figure 7.1*");
  });
});

// --- Findings from the review of the first version ---------------------------

describe("emphasis", () => {
  it("nests neighbouring runs instead of fusing their markers (real chapter 1 text)", () => {
    const out = convert([
      para([run('"', { italic: true }), run("Expected time until", { italic: true, bold: true }), run('. As always."\n', { italic: true })]),
    ]);
    expect(out.body.trim()).toBe('*"**Expected time until**. As always."*');
  });

  it("closes and reopens across crossing styles without writing ****", () => {
    const out = convert([para([run("a ", { bold: true }), run("b", { bold: true, italic: true }), run("c\n", { italic: true })])]);
    expect(out.body.trim()).toBe("**a *b***_c_");
  });

  it("keeps superscript and subscript", () => {
    const out = convert([para([run("10"), run("26", { baselineOffset: "SUPERSCRIPT" }), run(" FLOP of CO"), run("2\n", { baselineOffset: "SUBSCRIPT" })])]);
    expect(out.body.trim()).toBe("10<sup>26</sup> FLOP of CO<sub>2</sub>");
  });
});

describe("escaping", () => {
  it.each([
    ["Ratio A:B and Note:important, see https://x.test", "Ratio A\\:B and Note\\:important, see https://x.test"],
    ["&copy; AT&amp;T & co", "\\&copy; AT\\&amp;T & co"],
    ["{++added++} {--gone--} {==marked==}", "\\{++added++} \\{--gone--} \\{==marked==}"],
    ["Fill ____ in, use __name__", "Fill \\_\\_\\_\\_ in, use \\_\\_name\\_\\_"],
    ["see <https://x.test> or <x>", "see <https://x.test> or \\<x\\>"],
  ])("%s", (input, expected) => {
    expect(escapeInline(input)).toBe(expected);
  });

  it("escapes line starts in list items, quotes, footnotes and after manual line breaks", () => {
    const out = convert(
      [
        para([run("2023. A big year\n")], "NORMAL_TEXT", { listId: "b" }),
        para([run("# of parameters\n")], "NORMAL_TEXT", { listId: "b" }),
        table([["type", [text("quote")]], ["content", [text("1. Do no harm.")]], ["speaker", [text("Hippocrates")]]]),
        para([run("Results\u000b===\u000b---"), { footnoteReference: { footnoteId: "f", footnoteNumber: "1" } }, run("\n")]),
      ],
      { footnotes: { f: { content: [text("- see below")] } } },
    );
    expect(out.body).toBe(
      "- 2023\\. A big year\n- \\# of parameters\n\n> 1\\. Do no harm.\n> — Hippocrates\n\n" +
        "Results\n\\===\n---[^note-1]\n\n[^note-1]: \\- see below\n",
    );
  });

  it("keeps a heading's trailing # as text", () => {
    expect(convert([heading(2, "Using C #")]).body).toBe("## Using C \\#\n");
  });
});

describe("maths in markdown", () => {
  const md = (s: string) => convert([text(s)]).body.trim();

  it("never lets HTML through inline maths", () => {
    expect(md("Formula $<img src=x onerror=alert(1)>$ here.")).toBe("Formula $\\lt img src=x onerror=alert(1)\\gt$ here.");
  });

  it("swaps characters markdown would act on for TeX that draws the same", () => {
    expect(md("$V^*(s) = max_a Q^*(s, a)$")).toBe("$V^{\\ast }(s) = \\max_ {a} Q^{\\ast }(s, a)$");
    expect(md("$(a)_i + (b)_j$")).toBe("$(a)_ {i} + (b)_ {j}$");
    expect(md("$p = 90% {1, 2}$")).toBe("$p = 90\\char37  \\lbrace 1, 2\\rbrace$");
  });

  it("shows display maths inline where no block can stand, and says so", () => {
    const out = convert([para([run("where $ x = y $ holds\n")], "NORMAL_TEXT", { listId: "b" })]);
    expect(out.body).toBe("- where $x = y$ holds\n");
    expect(out.warnings).toEqual(["display maths inside a list, caption, quote, footnote or table cell is shown inline: x = y"]);
  });

  it("reports a $ whose partner is in another formatting run, and Typst names it cannot translate", () => {
    const out = convert([para([run("where $x"), run("^2", { bold: true }), run("$.\n")]), text("It cost $500."), text("Then $op(y)$.")]);
    // "$500" is money, not maths: no warning for it.
    expect(out.warnings).toEqual([
      'a "$" has no partner within the same formatting, so it is shown as text: where $x',
      "maths uses Typst names the sync does not translate: op",
    ]);
  });
});

describe("lists and other structure", () => {
  const lists = { o: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }, { glyphType: "DECIMAL" }, { glyphType: "DECIMAL" }] } } };

  it("continues numbering after an interrupting paragraph, as Docs does", () => {
    const item = (s: string) => para([run(`${s}\n`)], "NORMAL_TEXT", { listId: "o" });
    const out = convert([item("a"), item("b"), text("aside"), item("c")], { lists });
    expect(out.body).toBe("1. a\n2. b\n\naside\n\n3. c\n");
  });

  it("clamps a skipped nesting level so the item stays in the list", () => {
    const out = convert(
      [para([run("top\n")], "NORMAL_TEXT", { listId: "o" }), para([run("deep\n")], "NORMAL_TEXT", { listId: "o", nestingLevel: 2 })],
      { lists },
    );
    expect(out.body).toBe("1. top\n    1. deep\n");
  });

  it("keeps date chips and images in heading-styled paragraphs; reports positioned images and title footnotes", () => {
    const out = convert([
      para([run("TITLE"), { footnoteReference: { footnoteId: "f", footnoteNumber: "1" } }], "TITLE"),
      para([run("Published "), { dateElement: { dateElementProperties: { displayText: "Sep 30, 2026" } } }, run("\n")]),
      para([{ inlineObjectElement: { inlineObjectId: "kix.h" } }, run("\n")], "HEADING_2"),
      { paragraph: { elements: [run("Beside a picture\n")], positionedObjectIds: ["kix.p"] } },
    ]);
    expect(out.body).toBe("Published Sep 30, 2026\n\n![](https://img.test/kix.h.png)\n\nBeside a picture\n");
    expect(out.warnings).toEqual([
      "a footnote in the title was left out",
      '1 positioned ("wrap text") image(s) were left out; make them inline images',
    ]);
  });

  it("collapses whitespace in alt text", () => {
    const out = convert([image("kix.a")], {
      inlineObjects: { "kix.a": { inlineObjectProperties: { embeddedObject: { description: "Line one\n\nLine two" } } } },
    });
    expect(out.body).toBe("![Line one Line two](https://img.test/kix.a.png)\n");
  });
});
