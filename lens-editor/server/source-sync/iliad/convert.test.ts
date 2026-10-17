import { describe, expect, it } from "vitest";
import { PermanentImageError } from "../types";
import { convertWorksheet } from "./convert";
import type { Converted, Worksheet } from "./types";

const page = (mdx: string): Worksheet => ({
  slug: "aixi",
  cluster: { id: "D", label: "D - Agency", urlSlug: "agency" },
  dayCode: "D.3",
  dayTitle: "AIXI",
  code: "D.3.2",
  title: "AIXI",
  summary: null,
  contributors: [],
  slides: null,
  pageUrl: "https://iliad-intensive.org/agency/aixi/",
  mdx,
});

const hostAt = async (sitePath: string) => `https://img.test${sitePath}.png`;
const convert = (...lines: string[]) => convertWorksheet(page(lines.join("\n")), hostAt);

/** All text of the page, a video as `[video <id>]`. */
const textOf = ({ atoms }: Converted) =>
  atoms.flatMap((atom) => atom.parts.map((part) => (part.kind === "text" ? part.markdown : `[video ${part.youtubeId}]`))).join("\n\n");
/** The Lens markdown of a page with nothing to report. */
async function lens(...lines: string[]): Promise<string> {
  const converted = await convert(...lines);
  expect(converted.warnings).toEqual([]);
  return textOf(converted);
}

describe("atoms", () => {
  it("cuts the page at every H2, H3 and H4, with the text before the first heading as an atom of its own", async () => {
    const { atoms, warnings } = await convert(
      "Opening words.",
      "",
      "## 1. Setup",
      "",
      "An **agent** acts.",
      "",
      "### 1.1 Spaces of $\\cA$",
      "",
      "Text.",
      "",
      "#### 1.1.1 Detail",
      "",
      "##### Not a section",
      "",
      "More.",
    );
    expect(warnings).toEqual([]);
    expect(atoms.map((a) => [a.level, a.anchor, a.title, a.words])).toEqual([
      [0, "", "", 2],
      [2, "1-setup", "1. Setup", 6],
      [3, "11-spaces-of-", "1.1 Spaces of $$\\cA$$", 6],
      [4, "111-detail", "1.1.1 Detail", 8],
    ]);
    expect(atoms[3].parts).toEqual([{ kind: "text", markdown: "\\#### 1.1.1 Detail\n\n\\##### Not a section\n\nMore." }]);
  });

  it("has no opening atom when the page starts at a heading, and numbers repeated headings as the site does", async () => {
    const { atoms } = await convert("## Readings", "", "a", "", "## Readings", "", "b");
    expect(atoms.map((a) => a.anchor)).toEqual(["readings", "readings-1"]);
  });

  it("gives a heading with a link the anchor and title of its words", async () => {
    const { atoms } = await convert("## [Sections 9–11](#9-ratios): the *stretch* goal");
    expect(atoms[0]).toMatchObject({ anchor: "sections-911-the-stretch-goal", title: "Sections 9–11: the stretch goal" });
    expect(atoms[0].parts).toEqual([{ kind: "text", markdown: "\\## Sections 9–11: the *stretch* goal" }]);
  });

  it("takes the line under an empty heading as its text, and says so", async () => {
    const converted = await convert("Intro.", "## ", "Further reading", "", "* a");
    expect(converted.atoms.map((a) => a.anchor)).toEqual(["", "further-reading"]);
    expect(textOf(converted)).toBe("Intro.\n\n\\## Further reading\n\n* a");
    expect(converted.warnings).toEqual(['aixi: line 2: a heading has no text; the line below it ("Further reading") is taken as its text']);
  });

  it("starts no atom at a heading the site gives no anchor", async () => {
    const converted = await convert("Intro.", "", "## $\\pi$", "", "Text.", "", "## Next");
    expect(converted.atoms.map((a) => a.anchor)).toEqual(["", "next"]);
    expect(textOf(converted)).toBe("Intro.\n\n\\## $$\\pi$$\n\nText.\n\n\\## Next");
    expect(converted.warnings).toEqual(['aixi: line 3: heading "$\\pi$" has no words for an anchor, so no section starts at it']);
  });

  it("starts an atom at each exercise with an id that stands outside every box, and changes no text", async () => {
    const mdx = [
      "## 1. Setup",
      "",
      "Intro.",
      "",
      '<Exercise id="prob-a">',
      "**Exercise 1.1.** A.",
      "</Exercise>",
      "",
      "<Solution>",
      "S.",
      "</Solution>",
      "",
      "<Exercise>",
      "**Exercise 1.2.** No id.",
      "</Exercise>",
      "",
      '<Callout type="note">',
      '<Exercise id="prob-nested">',
      "Nested.",
      "</Exercise>",
      "</Callout>",
      "",
      '<Exercise id="prob-b">',
      "**Exercise 1.3.** B.",
      "</Exercise>",
    ];
    const converted = await convert(...mdx);
    expect(converted.warnings).toEqual([]);
    expect(converted.atoms.map((a) => [a.level, a.anchor, a.title, a.words])).toEqual([
      [2, "1-setup", "1. Setup", 4],
      [5, "prob-a", "", 22],
      [5, "prob-b", "", 6],
    ]);
    expect(converted.atoms[1].parts).toEqual([
      {
        kind: "text",
        markdown: [
          ':::callout {title="Exercise" tone="amber"}',
          "**Exercise 1.1.** A.",
          ":::",
          "",
          ':::callout {title="Solution" tone="neutral" collapse="closed"}',
          "S.",
          ":::",
          "",
          ':::callout {title="Exercise" tone="amber"}',
          "**Exercise 1.2.** No id.",
          ":::",
          "",
          '::::callout {title="Note" tone="blue"}',
          ':::callout {title="Exercise" tone="amber"}',
          "Nested.",
          ":::",
          "::::",
        ].join("\n"),
      },
    ]);
    // The same page with no id on any exercise is one atom with the same text.
    expect(textOf(converted)).toBe(textOf(await convert(...mdx.map((line) => line.replace(/ id="[^"]*"/, "")))));
  });

  it("starts no atom at an exercise whose id a heading or an earlier exercise has, and warns", async () => {
    const converted = await convert('<Exercise id="setup">', "A.", "</Exercise>", "", '<Exercise id="prob-a">', "B.", "</Exercise>", "", '<Exercise id="prob-a">', "C.", "</Exercise>", "", "## Setup");
    expect(converted.atoms.map((a) => [a.level, a.anchor])).toEqual([[0, ""], [5, "prob-a"], [2, "setup"]]);
    expect(converted.warnings).toEqual([
      'aixi: line 1: exercise id "setup" is also the anchor of a heading or the id of an earlier exercise, so no section starts at it',
      'aixi: line 9: exercise id "prob-a" is also the anchor of a heading or the id of an earlier exercise, so no section starts at it',
    ]);
  });

  it("gives the same text every time", async () => {
    const mdx = ["$\\gdef\\cM{\\mathcal{M}}$", "", "## A", "", "<Exercise id=\"x\">", "$\\cM$ [^1]", "</Exercise>", "", "[^1]: Note."];
    expect(await convert(...mdx)).toEqual(await convert(...mdx));
  });
});

describe("boxes", () => {
  it("turns each component into a callout, line for line", async () => {
    expect(
      await lens(
        '<Definition id="def-policy">',
        "",
        "**Definition 0.2.** A policy.",
        "",
        "</Definition>",
        "",
        "<Theorem>",
        "T",
        "</Theorem>",
        "<Solution>",
        "S",
        "</Solution>",
        '<Solution title="Proof of Theorem 4.1">',
        "P",
        "</Solution>",
        "<LearningOutcomes>",
        "- L",
        "</LearningOutcomes>",
      ),
    ).toBe(
      [
        ':::callout {title="Definition" tone="blue"}',
        "",
        "**Definition 0.2.** A policy.",
        "",
        ":::",
        "",
        ':::callout {title="Theorem" tone="green"}',
        "T",
        ":::",
        ':::callout {title="Solution" tone="neutral" collapse="closed"}',
        "S",
        ":::",
        ':::callout {title="Proof of Theorem 4.1" tone="neutral" collapse="closed"}',
        "P",
        ":::",
        ':::callout {title="What you\'ll learn" tone="neutral"}',
        "- L",
        ":::",
      ].join("\n"),
    );
  });

  it("names a Callout after its type, or its title", async () => {
    expect(
      await lens(
        '<Callout type="note">',
        "n",
        "</Callout>",
        '<Callout type="tip" title="Observation return">',
        "t",
        "</Callout>",
        '<Callout type="warning" id="co-pitfall">',
        "w",
        "</Callout>",
      ),
    ).toBe(
      [
        ':::callout {title="Note" tone="blue"}',
        "n",
        ":::",
        ':::callout {title="Observation return" tone="green"}',
        "t",
        ":::",
        ':::callout {title="Warning" tone="amber"}',
        "w",
        ":::",
      ].join("\n"),
    );
  });

  it("gives a box more colons than the boxes inside it", async () => {
    expect(await lens('<Exercise id="a">', "**Exercise 1.1.** Show it.", "", "<Hint>", "", "Use 0.2.", "", "</Hint>", "</Exercise>")).toBe(
      [
        '::::callout {title="Exercise" tone="amber"}',
        "**Exercise 1.1.** Show it.",
        "",
        ':::callout {title="Hint" tone="neutral" collapse="closed"}',
        "",
        "Use 0.2.",
        "",
        ":::",
        "::::",
      ].join("\n"),
    );
  });

  it("reads a component written on one line as the same box", async () => {
    expect(await lens("<Hint>Try $n = 2$.</Hint>")).toBe(':::callout {title="Hint" tone="neutral" collapse="closed"}\nTry $$n = 2$$.\n:::');
  });

  it("keeps a heading inside a box in its atom", async () => {
    const { atoms } = await convert("## A", "", "<Solution>", "## Not a section", "</Solution>");
    expect(atoms).toHaveLength(1);
    expect(atoms[0].parts[0]).toMatchObject({ markdown: expect.stringContaining("\\## Not a section") });
  });

  it("keeps what an unknown component encloses, without its box, and warns", async () => {
    const converted = await convert("Before.", "", '<Quiz id="q1">', "", "What is $x$?", "", "</Quiz>", "", "After <Badge>new</Badge>.", "", '<Poll question="Which?" />');
    expect(textOf(converted)).toBe("Before.\n\nWhat is $$x$$?\n\nAfter new.");
    expect(converted.warnings).toEqual([
      'aixi: line 3: <Quiz id="q1"> is a component this sync does not know: its box is left out and what it encloses is kept',
      "aixi: line 9: <Badge> is a component this sync does not know: its box is left out and what it encloses is kept",
      'aixi: line 11: <Poll question="Which?" /> is a component this sync does not know: its box is left out and what it encloses is kept',
    ]);
  });

  it("closes a box the page leaves open, and warns", async () => {
    const converted = await convert("<Exercise>", "E");
    expect(textOf(converted)).toBe(':::callout {title="Exercise" tone="amber"}\nE\n:::');
    expect(converted.warnings).toEqual(["aixi: line 2: <Exercise> is never closed"]);
  });
});

describe("maths", () => {
  it("writes inline maths with two dollars and leaves displayed maths as it is", async () => {
    expect(await lens("Let $x$ and $y_{1}$ cost \\$5.", "", "$$", "x \\leq y", "$$", "", "Code `$x$` stays.")).toBe(
      "Let $$x$$ and $$y_{1}$$ cost \\$5.\n\n$$\nx \\leq y\n$$\n\nCode `$x$` stays.",
    );
  });

  it("takes the macro table off the page and expands its macros in every formula", async () => {
    expect(
      await lens(
        "$\\gdef\\cM{\\mathcal{M}}\\gdef\\dv#1#2{\\frac{d #1}{d #2}}$",
        "",
        "## Setup",
        "",
        "For $\\mu \\in \\cM$:",
        "",
        "$$",
        "\\dv{x}{t}= \\cM",
        "$$",
      ),
    ).toBe("\\## Setup\n\nFor $$\\mu \\in {\\mathcal{M}}$$:\n\n$$\n\\frac{d x}{d t}= {\\mathcal{M}}\n$$");
  });

  it("keeps a formula valid on its own: \\renewcommand, CriticMarkup braces, a line starting with \\#", async () => {
    expect(await lens("$$", "\\renewcommand{\\arraystretch}{1.8}\\begin{array}{c}a & \\text{--}\\end{array}", "$$", "", "$$", "\\#\\{t \\geq 1\\} \\leq 2", "$$")).toBe(
      "$$\n\\def\\arraystretch{1.8}\\begin{array}{c}a & \\text{\\relax --}\\end{array}\n$$\n\n$$\n{}\\#\\{t \\geq 1\\} \\leq 2\n$$",
    );
  });

  it("copies a formula the page never closes, and warns", async () => {
    const converted = await convert("Text.", "", "$$", "x = 1");
    expect(textOf(converted)).toBe("Text.\n\n$$\nx = 1");
    expect(converted.warnings).toEqual(["aixi: line 4: a displayed formula is never closed; it is copied as written"]);
  });

  it("reads a tag-like run inside maths as maths", async () => {
    expect(await lens("If $a<B>c$ then $x<t$.")).toBe("If $$a<B>c$$ then $$x<t$$.");
  });
});

describe("links, figures and videos", () => {
  it("keeps the words of a link within the page, and escapes what would then start a list", async () => {
    expect(await lens("See ([Hutter 2024](#bib-hutter)) and [Exercise 0.2](#prob-chain).", "", "- [5. Further readings](#5-further-readings)", "  - [5.1 Other](#51-other)")).toBe(
      "See (Hutter 2024) and Exercise 0.2.\n\n- 5\\. Further readings\n  - 5.1 Other",
    );
  });

  it("makes a link to the site absolute, and lists links to other sites", async () => {
    const converted = await convert(
      "## Reading",
      "",
      "Start with [Solomonoff](/agency/solomonoff-induction), the [slides](slides.pdf) and [the *paper*](https://arxiv.org/abs/1 \"t\").",
      "",
      "### More",
      "",
      "[Post](https://lesswrong.com/a\\#b) <span id=\"x\">**(a)**</span>",
    );
    expect(textOf(converted)).toBe(
      [
        "\\## Reading",
        "",
        'Start with [Solomonoff](https://iliad-intensive.org/agency/solomonoff-induction), the [slides](https://iliad-intensive.org/agency/aixi/slides.pdf) and [the *paper*](https://arxiv.org/abs/1 "t").',
        "",
        "\\### More",
        "",
        "[Post](https://lesswrong.com/a\\#b) **(a)**",
      ].join("\n"),
    );
    expect(converted.atoms.map((a) => a.links)).toEqual([
      [{ text: "the *paper*", url: "https://arxiv.org/abs/1" }],
      [{ text: "Post", url: "https://lesswrong.com/a#b" }],
    ]);
  });

  it("embeds a figure at the URL it is hosted at, with its caption below", async () => {
    const asked: string[] = [];
    const converted = await convertWorksheet(
      page(
        [
          '<div id="fig-1">',
          '<Figure src="/uploads/aixi/tikz-4dc0.svg" alt="diagram" />',
          "</div>",
          "",
          '<Figure src="/uploads/aixi/plot.png" alt="A [plot] of $V$">',
          "",
          "A plot of $V$.",
          "",
          "</Figure>",
          "",
          '<Figure src="/uploads/aixi/tikz-4dc0.svg" alt="diagram" />',
        ].join("\n"),
      ),
      async (sitePath) => {
        asked.push(sitePath);
        return `https://img.test/${asked.length}.png`;
      },
    );
    expect(textOf(converted)).toBe(
      "![diagram](https://img.test/1.png)\n\n![A \\[plot\\] of $V$](https://img.test/2.png)\n\nA plot of $$V$$.\n\n![diagram](https://img.test/1.png)",
    );
    expect(asked).toEqual(["/uploads/aixi/tikz-4dc0.svg", "/uploads/aixi/plot.png"]);
    expect(converted.warnings).toEqual([]);
  });

  it("links a figure that can never be hosted, and fails the page on any other error", async () => {
    const figure = page('<Figure src="/uploads/aixi/big.svg" alt="diagram" />');
    const converted = await convertWorksheet(figure, async () => {
      throw new PermanentImageError("too large");
    });
    expect(textOf(converted)).toBe("[diagram](https://iliad-intensive.org/uploads/aixi/big.svg)");
    expect(converted.warnings).toEqual(["aixi: figure /uploads/aixi/big.svg cannot be hosted (too large); the text links to it"]);
    await expect(
      convertWorksheet(figure, async () => {
        throw new Error("relay is down");
      }),
    ).rejects.toThrow("relay is down");
  });

  it("makes a video a part of its own between the text around it", async () => {
    const { atoms, warnings } = await convert('<YouTube id="FaXazOpzLvQ" title="When Bad Goals Fit" />', "", "## Prerequisites", "", "Before.", "", '<YouTube id="abcdefghijk" />', "", "After.");
    expect(warnings).toEqual([]);
    expect(atoms.map((a) => a.parts)).toEqual([
      [{ kind: "video", youtubeId: "FaXazOpzLvQ", title: "When Bad Goals Fit" }],
      [
        { kind: "text", markdown: "\\## Prerequisites\n\nBefore." },
        { kind: "video", youtubeId: "abcdefghijk", title: null },
        { kind: "text", markdown: "After." },
      ],
    ]);
  });

  it("links a video that stands inside a box, and warns", async () => {
    const converted = await convert("<Callout type=\"tip\">", '<YouTube id="abcdefghijk" title="Watch" />', "</Callout>");
    expect(textOf(converted)).toContain("[Watch](https://www.youtube.com/watch?v=abcdefghijk)");
    expect(converted.warnings).toEqual(["aixi: line 2: video abcdefghijk stands inside a box, so the text links to it"]);
  });
});

describe("footnotes", () => {
  it("moves each definition below the text of the atom that refers to it", async () => {
    const { atoms, warnings } = await convert(
      "## A",
      "",
      "Value[^1] and optimum.[^2]",
      "",
      "## B",
      "",
      "Events.[^3]",
      "",
      "[^1]: See [Appendix A](#a) and [the book](https://example.org/book).",
      "",
      "[^2]: A $\\sup$.",
      "",
      "[^3]: Measurable.",
      "",
      "[^4]: Nobody asks.",
    );
    expect(atoms.map((a) => (a.parts[0] as { markdown: string }).markdown)).toEqual([
      "\\## A\n\nValue[^1] and optimum.[^2]\n\n[^1]: See Appendix A and [the book](https://example.org/book).\n[^2]: A $$\\sup$$.",
      "\\## B\n\nEvents.[^3]\n\n[^3]: Measurable.\n[^4]: Nobody asks.",
    ]);
    // The words of a definition count where it is read, not at the foot of the page.
    expect(atoms.map((a) => a.words)).toEqual([15, 8]);
    expect(atoms[0].links).toEqual([{ text: "the book", url: "https://example.org/book" }]);
    expect(warnings).toEqual(["aixi: footnote [^4] is defined and nothing refers to it"]);
  });
});

describe("what is written for the teacher", () => {
  it("writes a JSX comment as a Lens comment, with the boxes inside it converted", async () => {
    expect(await lens("Text. {/* TODO: check $x$ */}", "", "{/*", "<Solution>", "", "Answer: 10:30.", "", "</Solution>", "*/}")).toBe(
      'Text. %% TODO: check $x$ %%\n\n%% :::callout {title="Solution" tone="neutral" collapse="closed"}\n\nAnswer: 10:30.\n\n::: %%',
    );
  });

  it("counts no words for an atom that is nothing but comments, and all its words when a learner sees any of it", async () => {
    const { atoms } = await convert("{/* parked for now */}", "", "## A", "", "Shown. {/* not shown */}", "", "## B", "", '<TeachingNote title="Intent">', "Only for the teacher.", "</TeachingNote>");
    // The heading of B is shown, so B counts in full.
    expect(atoms.map((a) => [a.anchor, a.words])).toEqual([["", 0], ["a", 7], ["b", 9]]);
  });

  it("hides a teaching note under its title", async () => {
    expect(await lens("Before.", "", '<TeachingNote title="Session intent">', "", "They [read](https://example.org/x).", "", "</TeachingNote>", "", "After.")).toBe(
      "Before.\n\n%% Facilitator logistics (hidden from learners):\n**Session intent**\n\nThey [read](https://example.org/x).\n%%\n\nAfter.",
    );
  });

  it("hides a timetable section, and a subsection of it that is only a timetable", async () => {
    const { atoms, warnings } = await convert(
      "## 2. Roadmap for today",
      "",
      "- 10:00–10:30 [Lecture](https://example.org/slides) {/* confirm */}",
      "",
      "### Backup plan",
      "",
      "| Time | Session |",
      "|:--|:--|",
      "| 10:00–10:10 | Welcome |",
      "",
      '<TeachingNote title="Overflow">',
      "Continue after lunch.",
      "</TeachingNote>",
      "",
      "### Session 1: Alignment targets",
      "",
      "**10:30–11:25.** Read [this](https://example.org/a).",
      "",
      "## Goal and Roadmap",
      "",
      "Content.",
    );
    expect(warnings).toEqual([]);
    expect(atoms.map((a) => (a.parts[0] as { markdown: string }).markdown)).toEqual([
      "%% Facilitator logistics (hidden from learners):\n\\## 2. Roadmap for today\n\n- 10:00–10:30 [Lecture](https://example.org/slides) confirm\n%%",
      "%% Facilitator logistics (hidden from learners):\n\\### Backup plan\n\n| Time | Session |\n|:--|:--|\n| 10:00–10:10 | Welcome |\n\n**Overflow**\nContinue after lunch.\n%%",
      "\\### Session 1: Alignment targets\n\n**10\\:30–11\\:25.** Read [this](https://example.org/a).",
      "\\## Goal and Roadmap\n\nContent.",
    ]);
    // A link the learner never sees is no reading, and an atom the learner sees none of has no size.
    expect(atoms.map((a) => a.links.length)).toEqual([0, 0, 1, 0]);
    expect(atoms.map((a) => a.words)).toEqual([0, 0, 8, 5]);
  });

  it("hides a timetable under a bold line, up to the next bold line or heading", async () => {
    expect(await lens("**Prerequisites.**", "", "RL.", "", "**Roadmap for today.**", "", "- 10:00 – 11:00: Talk", "", "**Notation.** We write $x$.")).toBe(
      "**Prerequisites.**\n\nRL.\n\n%% Facilitator logistics (hidden from learners):\n**Roadmap for today.**\n\n- 10:00 – 11:00: Talk\n%%\n\n**Notation.** We write $$x$$.",
    );
  });
});

describe("what Lens would read as its own syntax", () => {
  it("escapes a directive, a comment marker, a field and a fence in text, and nothing in a link target", async () => {
    expect(await lens("At 10:30 see arXiv:2304.065 (ratio 3:1), 100%% sure: yes.", "", "source:: not a field", "", ":::note", "", "<https://example.org/a:b> and https://example.org/c:d")).toBe(
      "At 10\\:30 see arXiv\\:2304.065 (ratio 3\\:1), 100\\%\\% sure: yes.\n\nsource\\:: not a field\n\n\\:::note\n\n<https://example.org/a:b> and https://example.org/c:d",
    );
  });

  it("leaves code as it is, and warns when Lens would act on it", async () => {
    const converted = await convert("```python", "# a comment, not a heading", "x = '$y$' # 10:30", "```", "", "Use `{--force}`.");
    expect(textOf(converted)).toBe("```python\n# a comment, not a heading\nx = '$y$' # 10:30\n```\n\nUse `{--force}`.");
    expect(converted.warnings).toEqual(['aixi: line 6: code holds "{--", which Lens reads as its own markup: `{--force}`']);
  });

  it("carries tables, quotes and escapes over unchanged", async () => {
    const mdx = ["| #parameters $P$ | time |", "| --- | --- |", "| \\[A\\]\\[B\\] | 10 |", "", "> *Thou shalt*", ">     —1496"];
    expect(await lens(...mdx)).toBe(mdx.join("\n").replace("$P$", () => "$$P$$"));
  });

  it("drops inline HTML it cannot carry, with a warning, and keeps what Lens renders", async () => {
    const converted = await convert('H<sub>2</sub>O<br/> and <mark class="x">this</mark>.');
    expect(textOf(converted)).toBe("H<sub>2</sub>O<br/> and this.");
    expect(converted.warnings).toEqual(['aixi: line 1: <mark class="x"> is a component this sync does not know: its box is left out and what it encloses is kept']);
  });
});
