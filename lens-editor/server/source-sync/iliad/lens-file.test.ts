import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { composeLens, readLensBody, type FoundCard, type LensFile } from "./lens-file";
import { splitFrontmatter } from "./module-file";
import type { Atom } from "./types";

/** Two spaces at the end of a line (a markdown line break), spelled out so that no editor strips them. */
const BREAK = "  ";

const text = (anchor: string, markdown: string, level: Atom["level"] = 2): Atom => ({
  anchor,
  level,
  title: anchor,
  words: 0,
  parts: [{ kind: "text", markdown }],
  links: [],
});

/** Cards as read from a lens, to go under the heading with this anchor. */
const under = (anchor: string, found: FoundCard[]) => found.map(({ after, nth, block }) => ({ anchor, after, nth, block }));

const lens = (over: Partial<LensFile>): LensFile => ({
  path: "Lens Edu/Lenses/Iliad B.3.1 - Introduction.md",
  was: null,
  id: "362cd9fe-e0c9-47e0-9cf5-a23b33317722",
  title: "B.3.1 Introduction",
  tldr: 'Introduces "degeneracy".',
  summaryForTutor: "For the tutor.",
  authors: ["Kai Ogden (University of Oxford)", "Leon Lang (ILIAD): based on work by others"],
  sourceUrl: "https://iliad-intensive.org/learning/singular-learning-theory/",
  key: "singular-learning-theory#",
  fingerprint: "f1",
  commit: "46ea03c",
  atoms: [],
  cards: [],
  transcripts: new Map([["SzVmiN8BvCc", "Lens Edu/video_transcripts/singular.md"]]),
  ...over,
});

describe("composeLens", () => {
  it("writes the frontmatter the sync keeps its state in, then Text, Video, Text", () => {
    const { content, warnings } = composeLens(
      lens({
        atoms: [
          {
            anchor: "",
            level: 0,
            title: "",
            words: 0,
            links: [],
            parts: [
              { kind: "text", markdown: "**Contents**\n\n- Introduction\n" },
              { kind: "video", youtubeId: "SzVmiN8BvCc", title: "Deep Learning Is Singular" },
              { kind: "text", markdown: "> Thou shalt have the power to degenerate" },
            ],
          },
          text("introduction", `\\## Introduction\n\nSingular learning theory accounts for degeneracy.${BREAK}`),
        ],
      }),
    );
    expect(warnings).toEqual([]);
    expect(content).toBe(`---
id: '362cd9fe-e0c9-47e0-9cf5-a23b33317722'
title: "B.3.1 Introduction"
tldr: "Introduces \\"degeneracy\\"."
summary_for_tutor: "For the tutor."
authors:
  - Kai Ogden (University of Oxford)
  - "Leon Lang (ILIAD): based on work by others"
source_url: https://iliad-intensive.org/learning/singular-learning-theory/
upstream_key: "singular-learning-theory#"
upstream_fingerprint: "f1"
upstream_commit: '46ea03c'
synced_from:
  source: "iliad"
  url: "https://iliad-intensive.org/learning/singular-learning-theory/"
---

#### Text
content::
**Contents**

- Introduction

#### Video
source:: [[../video_transcripts/singular]]

#### Text
content::
> Thou shalt have the power to degenerate

\\## Introduction

Singular learning theory accounts for degeneracy.${BREAK}
`);
    // What the editor's "this file is synced" banner and the next run read back.
    expect(parseYaml(splitFrontmatter(content).head.slice(4, -5))).toMatchObject({
      tldr: 'Introduces "degeneracy".',
      authors: ["Kai Ogden (University of Oxford)", "Leon Lang (ILIAD): based on work by others"],
      synced_from: { source: "iliad", url: "https://iliad-intensive.org/learning/singular-learning-theory/" },
    });
  });

  it("points the editor's \"synced from\" link at the section the lens starts with", () => {
    const { content } = composeLens(lens({ key: "singular-learning-theory#degeneracy", atoms: [text("degeneracy", "\\## Degeneracy\n\nA definition.")] }));
    expect(content).toContain('  url: "https://iliad-intensive.org/learning/singular-learning-theory/#degeneracy"\n');
  });

  // Two tools of the team write fields such as these onto lenses.
  it("keeps every frontmatter field it does not own, where a person put it", () => {
    const was = `---
id: '362cd9fe-e0c9-47e0-9cf5-a23b33317722'
title: "B.3.1 Introduction"
duration_minutes: 25
tldr: "An old summary."
tags:
  - slt
  - "week: 3"
authors:
  - Someone Else
source_url: https://iliad-intensive.org/learning/singular-learning-theory/
upstream_commit: 'old'
provenance_recorded_at: '2026-10-08'
sidebar_author: Iliad
---

#### Text
content::
Old text.
`;
    const { content } = composeLens(lens({ was, atoms: [text("", "New text.", 0)] }));
    expect(splitFrontmatter(content).head).toBe(`---
id: '362cd9fe-e0c9-47e0-9cf5-a23b33317722'
title: "B.3.1 Introduction"
duration_minutes: 25
tldr: "Introduces \\"degeneracy\\"."
tags:
  - slt
  - "week: 3"
authors:
  - Kai Ogden (University of Oxford)
  - "Leon Lang (ILIAD): based on work by others"
source_url: https://iliad-intensive.org/learning/singular-learning-theory/
upstream_commit: '46ea03c'
sidebar_author: Iliad
summary_for_tutor: "For the tutor."
upstream_key: "singular-learning-theory#"
upstream_fingerprint: "f1"
synced_from:
  source: "iliad"
  url: "https://iliad-intensive.org/learning/singular-learning-theory/"
---
`);
    // Written again from its own result, nothing moves.
    expect(composeLens(lens({ was: content, atoms: [text("", "New text.", 0)] })).content).toBe(content);
  });

  it("lets no text of the source site open a comment or a suggestion in the file", () => {
    const { content } = composeLens(
      lens({
        title: "B.3.9 Results %% draft",
        tldr: "A summary with %% in it {++and a suggestion++}.",
        summaryForTutor: "Two\nlines.",
        authors: ["Ada %% L", "[[x|y]]"],
        sourceUrl: "https://iliad-intensive.org/learning/a%%b/",
        key: "slt#x%%y",
        atoms: [{ anchor: "x", level: 2, title: "X", words: 0, links: [], parts: [{ kind: "video", youtubeId: "abc)%%[x]", title: "A [talk] %% here" }] }],
      }),
    );
    expect(content).not.toContain("%%");
    expect(content).not.toContain("{++");
    expect(splitFrontmatter(content).data).toMatchObject({
      title: "B.3.9 Results % draft",
      summary_for_tutor: "Two lines.",
      authors: ["Ada % L", "x y"],
      source_url: "https://iliad-intensive.org/learning/a%b/",
      upstream_key: "slt#x%y",
    });
    expect(splitFrontmatter(content).body).toBe("\n#### Text\ncontent::\n[Video: A talk % here](https://www.youtube.com/watch?v=abcx)\n");
  });

  it("links a video from where the lens lives", () => {
    const video: Atom = { anchor: "", level: 0, title: "", words: 0, links: [], parts: [{ kind: "video", youtubeId: "SzVmiN8BvCc", title: null }] };
    const { content } = composeLens(lens({ path: "Lens Edu/Lenses/Iliad/B.3 Singular Learning Theory/Iliad B.3.1 - Introduction.md", atoms: [video] }));
    expect(content).toContain("#### Video\nsource:: [[../../../video_transcripts/singular]]\n");
  });

  it("links to YouTube in the text, and says so, when Lens Edu has no transcript of a video", () => {
    const { content, warnings } = composeLens(
      lens({
        atoms: [
          {
            anchor: "talk",
            level: 2,
            title: "Talk",
            words: 0,
            links: [],
            parts: [
              { kind: "text", markdown: "\\## Talk" },
              { kind: "video", youtubeId: "abcdefghijk", title: "A new talk" },
              { kind: "text", markdown: "Afterwards, discuss." },
            ],
          },
        ],
      }),
    );
    expect(content).toContain("#### Text\ncontent::\n\\## Talk\n\n[Video: A new talk](https://www.youtube.com/watch?v=abcdefghijk)\n\nAfterwards, discuss.\n");
    expect(content).not.toContain("#### Video");
    expect(warnings).toEqual([expect.stringMatching(/links to the video https:\/\/www\.youtube\.com\/watch\?v=abcdefghijk and does not play it.*To make it play: import the video/)]);
  });

  it("leaves out a summary it does not have, and authors a worksheet does not name", () => {
    const { content } = composeLens(lens({ tldr: null, summaryForTutor: null, authors: [], key: "prerequisites#", atoms: [text("", "Hello.", 0)] }));
    expect(content).not.toMatch(/^(tldr|summary_for_tutor|authors):/m);
    expect(content).toContain('  url: "https://iliad-intensive.org/learning/singular-learning-theory/"\n');
  });

  describe("cards", () => {
    const block = ":::require_x_optional_lenses{x=1}\n::card[[../Lenses/cev|CEV]]\n\n::card[[../Lenses/corrigibility|Corrigibility]]\n:::";
    const atoms = () => [
      text("targets", "\\### Targets\n\nRead one of these.\n\nThen discuss.", 3),
      text("debrief", "\\### Debrief\n\nTen minutes.", 3),
    ];
    const bodyOf = (file: LensFile) => splitFrontmatter(composeLens(file).content).body;

    it("go back under their heading, below the line they followed", () => {
      expect(bodyOf(lens({ atoms: atoms(), cards: [{ anchor: "targets", after: ["Read one of these."], nth: 0, block }] }))).toBe(
        `\n#### Text\ncontent::\n\\### Targets\n\nRead one of these.\n\n${block}\n\nThen discuss.\n\n\\### Debrief\n\nTen minutes.\n`,
      );
    });

    it("go to the end of their heading's text when the line is gone, and say so", () => {
      const { warnings } = composeLens(lens({ atoms: atoms(), cards: [{ anchor: "targets", after: ["A line Iliad rewrote."], nth: 0, block }] }));
      expect(warnings).toEqual([expect.stringMatching(/^The lens "B\.3\.1 Introduction" \(.*\) has a card whose place is gone from the text: .* It now stands at the end of its section: "CEV", "Corrigibility"\. To do: check/)]);
      expect(bodyOf(lens({ atoms: atoms(), cards: [{ anchor: "targets", after: ["A line Iliad rewrote."], nth: 0, block }] }))).toBe(
        `\n#### Text\ncontent::\n\\### Targets\n\nRead one of these.\n\nThen discuss.\n\n${block}\n\n\\### Debrief\n\nTen minutes.\n`,
      );
    });

    it("stay in the lens when the heading is gone: below their line, or last", () => {
      expect(bodyOf(lens({ atoms: atoms(), cards: [{ anchor: "renamed", after: ["Read one of these."], nth: 0, block: "::card[[../Lenses/cev|CEV]]" }] }))).toContain(
        "Read one of these.\n\n::card[[../Lenses/cev|CEV]]\n\nThen discuss.",
      );
      expect(bodyOf(lens({ atoms: atoms(), cards: [{ anchor: "renamed", after: null, nth: 0, block: "::card[[../Lenses/cev|CEV]]" }] }))).toMatch(
        /Ten minutes\.\n\n::card\[\[\.\.\/Lenses\/cev\|CEV\]\]\n$/,
      );
    });

    // Seen in a scenario: a card between two exercises moved up under the heading, because its line was ":::".
    it("stay where they were between callouts whose closing lines are all alike", () => {
      const exercises = ["One", "Two", "Three"].map((n) => `:::callout {title="Exercise" tone="amber"}\nExercise ${n}.\n:::`).join("\n\n");
      const original = `\n#### Text\ncontent::\n\\### Exercises\n\nDo these.\n\n${exercises.replace("Exercise Two.\n:::", "Exercise Two.\n:::\n\n::card[[../Lenses/cev|CEV]]")}\n`;
      const read = readLensBody(original);
      expect(read.cards).toEqual([{ heading: 0, after: ["Exercise Two.", ":::"], nth: 0, block: "::card[[../Lenses/cev|CEV]]" }]);
      const part = read.parts[0] as { text: string };
      const composed = composeLens(lens({ atoms: [{ ...text("exercises", part.text, 3) }], cards: under("exercises", read.cards) }));
      expect(splitFrontmatter(composed.content).body).toBe(original);
      expect(composed.warnings).toEqual([]);
    });

    it("count which of several equal lines they followed", () => {
      const original = "\n#### Text\ncontent::\n\\### Steps\n\nRepeat.\n\nRepeat.\n\n::card[[../Lenses/cev|CEV]]\n\nRepeat.\n";
      const read = readLensBody(original);
      expect(read.cards).toEqual([{ heading: 0, after: ["Repeat."], nth: 1, block: "::card[[../Lenses/cev|CEV]]" }]);
      const part = read.parts[0] as { text: string };
      const composed = composeLens(lens({ atoms: [text("steps", part.text, 3)], cards: under("steps", read.cards) }));
      expect(splitFrontmatter(composed.content).body).toBe(original);
      // The text lost one of the lines: the card goes below the last that is left.
      const shorter = composeLens(lens({ atoms: [text("steps", "\\### Steps\n\nRepeat.\n\nOther.", 3)], cards: under("steps", read.cards) }));
      expect(splitFrontmatter(shorter.content).body).toBe("\n#### Text\ncontent::\n\\### Steps\n\nRepeat.\n\n::card[[../Lenses/cev|CEV]]\n\nOther.\n");
    });

    // On the first run 8 card blocks lost their place: each followed a quote the hand import wrote, which the source does not have.
    it("stay with the card before them when their own lines are gone", () => {
      const cev = { anchor: "targets", after: ["Read one of these."], nth: 0, block: "::card[[../Lenses/cev|CEV]]" };
      const corrigibility = { anchor: "targets", after: ["> A quote the hand import wrote."], nth: 0, block: "::card[[../Lenses/corrigibility|Corrigibility]]" };
      const { content, warnings } = composeLens(lens({ atoms: atoms(), cards: [cev, corrigibility] }));
      expect(splitFrontmatter(content).body).toContain("Read one of these.\n\n::card[[../Lenses/cev|CEV]]\n\n::card[[../Lenses/corrigibility|Corrigibility]]\n\nThen discuss.");
      expect(warnings).toEqual([]);
    });

    it("are set apart by empty lines even inside a paragraph", () => {
      const tight = [text("targets", "\\### Targets\nRead one of these.\nThen discuss.", 3)];
      expect(bodyOf(lens({ atoms: tight, cards: [{ anchor: "targets", after: ["Read one of these."], nth: 0, block: "::card[[../Lenses/cev|CEV]]" }] }))).toContain(
        "Read one of these.\n\n::card[[../Lenses/cev|CEV]]\n\nThen discuss.",
      );
    });
  });
});

describe("readLensBody", () => {
  const body = `
#### Text
content::
Before any heading.

::card[[../Lenses/a|A]]

\\## One

Pick one:

:::require_x_optional_lenses{x=1}
::card[[../Lenses/b|B]]

> A note on B.

::card[[../Lenses/c|C]]
:::

After the list.

\`\`\`md
\\## not a heading
::card[[../Lenses/code|in a code block]]
#### Text
\`\`\`

#### Video
source:: [[../video_transcripts/v]]

#### Text
content::
!### Two: [linked](https://example.org/x)

A paragraph.${BREAK}

::card[[../Lenses/d|D]]

::card[[../Lenses/e|E]]

> About E.

#### Chat
instructions::
Talk.

#### A type Lens adds later
field:: value
`;
  const read = readLensBody(body);

  it("takes the cards out of the text and remembers where each stood", () => {
    expect(read.cards).toEqual([
      { heading: -1, after: ["Before any heading."], nth: 0, block: "::card[[../Lenses/a|A]]" },
      { heading: 0, after: ["Pick one:"], nth: 0, block: ":::require_x_optional_lenses{x=1}\n::card[[../Lenses/b|B]]\n\n> A note on B.\n\n::card[[../Lenses/c|C]]\n:::" },
      { heading: 1, after: ["A paragraph."], nth: 0, block: "::card[[../Lenses/d|D]]\n\n::card[[../Lenses/e|E]]" },
    ]);
  });

  it("gives the text and the videos in order, code blocks untouched", () => {
    expect(read.parts).toEqual([
      { text: "Before any heading.\n\n\\## One\n\nPick one:\n\nAfter the list.\n\n```md\n\\## not a heading\n::card[[../Lenses/code|in a code block]]\n#### Text\n```" },
      { video: "../video_transcripts/v" },
      { text: "!### Two: [linked](https://example.org/x)\n\nA paragraph.  \n\n> About E." },
    ]);
  });

  it("lists the headings, and the segments the sync would not write back", () => {
    expect(read.headings).toEqual(["One", "Two: [linked](https://example.org/x)"]);
    // Every other "#### <Type>" is a segment, whatever types Lens has: no list of them to keep in step.
    expect(read.others).toEqual(["chat", "a type lens adds later"]);
    expect(readLensBody("\n#### Text\ncontent::\n\\#### An escaped heading\n\nText.\n")).toMatchObject({ headings: ["An escaped heading"], others: [] });
  });

  it("composes back to the body it read", () => {
    const original = "\n#### Text\ncontent::\n\\## One\n\nPick one:\n\n::card[[../Lenses/b|B]]\n\n::card[[../Lenses/c|C]]\n\nAfter.\n\n#### Video\nsource:: [[../video_transcripts/v]]\n\n#### Text\ncontent::\nLast words.\n";
    const { parts, cards } = readLensBody(original);
    const atom: Atom = {
      anchor: "one",
      level: 2,
      title: "One",
      words: 0,
      links: [],
      parts: parts.map((part) => ("text" in part ? { kind: "text", markdown: part.text } : { kind: "video", youtubeId: "v", title: null })),
    };
    const { content } = composeLens(
      lens({ atoms: [atom], cards: under("one", cards), transcripts: new Map([["v", "Lens Edu/video_transcripts/v.md"]]) }),
    );
    expect(splitFrontmatter(content).body).toBe(original);
  });
});
