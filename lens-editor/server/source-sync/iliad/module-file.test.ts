import { describe, expect, it } from "vitest";
import { blockFile, parseBlocks, setFrontmatter, spaced, splitFrontmatter } from "./module-file";

const MODULE = `---
id: 'm'
slug: iliad-learning
title: "B — Learning"
---

# Submodule: B.2 Mysteries

# Lens: B.2.1 Overview: the day
source:: [[../Lenses/Iliad B.2.1 - Overview]]

# Learning Outcome:
source:: [[../Learning Outcomes/x]]

# Lens: A reading
source:: [[../Lenses/huh-platonic|The paper]]
optional:: true`;

describe("splitFrontmatter", () => {
  it("splits a file so that head + body is the file", () => {
    const file = splitFrontmatter(MODULE);
    expect(file.head + file.body).toBe(MODULE);
    expect(file.data).toMatchObject({ id: "m", slug: "iliad-learning", title: "B — Learning" });
    expect(file.body.startsWith("\n# Submodule")).toBe(true);
  });

  it("takes a file without frontmatter as all body, and refuses frontmatter that is not fields", () => {
    expect(splitFrontmatter("# Lens: x\n")).toEqual({ head: "", data: {}, body: "# Lens: x\n" });
    expect(() => splitFrontmatter("---\n- a\n- b\n---\n")).toThrow("not a list of fields");
    expect(() => splitFrontmatter('---\ntitle: "a "b""\n---\n')).toThrow();
  });
});

describe("setFrontmatter", () => {
  it("replaces a field where it stands, or adds it last", () => {
    const head = "---\nslug: mini\nupstream_commit: 'old'\ntitle: x\n---\n";
    expect(setFrontmatter(head, { upstream_commit: "upstream_commit: 'new'" })).toBe("---\nslug: mini\nupstream_commit: 'new'\ntitle: x\n---\n");
    expect(setFrontmatter("---\nslug: mini\n---\n", { upstream_commit: "upstream_commit: 'new'" })).toBe("---\nslug: mini\nupstream_commit: 'new'\n---\n");
    expect(setFrontmatter("---\nslug: mini\n---", { upstream_commit: "upstream_commit: 'new'" })).toBe("---\nslug: mini\nupstream_commit: 'new'\n---");
    expect(setFrontmatter("", { id: "id: 'a'", title: 'title: "T"' })).toBe("---\nid: 'a'\ntitle: \"T\"\n---\n");
  });

  it("leaves every other field as written, lists and comments with it", () => {
    const head = `---
id: 'a'
tags:
  - wip
  - "two: words"
title: "Old"   # a person's note
authors:
  - One
  - Two
duration_minutes: 12
"quoted key": [1,
  2]
provenance_recorded_at: '2026-10-08'
---
`;
    expect(setFrontmatter(head, { title: 'title: "New"', authors: "authors:\n  - Three", tldr: 'tldr: "Added"', provenance_recorded_at: null, absent: null })).toBe(`---
id: 'a'
tags:
  - wip
  - "two: words"
title: "New"
authors:
  - Three
duration_minutes: 12
"quoted key": [1,
  2]
tldr: "Added"
---
`);
  });

  it("keeps one of a field written twice", () => {
    expect(setFrontmatter("---\ntitle: a\nid: x\ntitle: b\n---\n", { title: "title: c" })).toBe("---\ntitle: c\nid: x\n---\n");
  });
});

describe("parseBlocks", () => {
  const blocks = parseBlocks(splitFrontmatter(MODULE).body);

  it("gives back the text it was given", () => {
    expect(blocks.map((block) => block.raw).join("")).toBe(splitFrontmatter(MODULE).body);
  });

  it("reads each heading's type and title", () => {
    expect(blocks.map((block) => [block.type, block.title])).toEqual([
      ["", ""],
      ["submodule", "B.2 Mysteries"],
      ["lens", "B.2.1 Overview: the day"],
      ["learning outcome", ""],
      ["lens", "A reading"],
    ]);
  });

  it("finds the file a lens entry and a course's module line bring in", () => {
    expect(blocks.map((block) => blockFile(block, "Lens Edu/modules/M.md"))).toEqual([
      null,
      null,
      "Lens Edu/Lenses/Iliad B.2.1 - Overview.md",
      null,
      "Lens Edu/Lenses/huh-platonic.md",
    ]);
    const [line, meeting] = parseBlocks("# Module: [[../../modules/Iliad B - Learning|B — Learning]]\n\n# Meeting: Unit B\n");
    expect(blockFile(line, "Lens Edu/courses/in-development/c.md")).toBe("Lens Edu/modules/Iliad B - Learning.md");
    expect(blockFile(meeting, "Lens Edu/courses/in-development/c.md")).toBeNull();
  });

  it("closes a block with an empty line when a new one must follow", () => {
    expect(spaced("# Lens: x\nsource:: [[y]]")).toBe("# Lens: x\nsource:: [[y]]\n\n");
    expect(spaced("# Lens: x\n")).toBe("# Lens: x\n\n");
    expect(spaced("# Lens: x\n\n")).toBe("# Lens: x\n\n");
  });
});
