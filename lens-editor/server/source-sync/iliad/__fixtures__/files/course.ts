/**
 * For the file-step tests: a course of four worksheets shaped like the hand
 * import (cluster A with a module per day, cluster B as one module with a
 * submodule per day), files kept in memory, and a "source" made from what a
 * course already says, so that a test changes only what it is about.
 */

import type { SyncInput } from "../../course-files";
import type { CourseState, LensState } from "../../course-state";
import { layoutFor, linkTarget, type Layout } from "../../layout";
import { readLensBody } from "../../lens-file";
import { splitFrontmatter } from "../../module-file";
import { lensKey, type Atom, type CourseFiles, type Worksheet } from "../../types";

/** The layout of the hand import of 8 Oct 2026: every lens directly in Lenses/, every module in modules/. */
export function flatLayout(course: string): Layout {
  const folder = course.slice(0, course.indexOf("/"));
  return { course, moduleDir: `${folder}/modules`, lensDir: () => `${folder}/Lenses` };
}

/** The mini course as the hand import would have left it, and as the sync lays it out. */
export const MINI_FLAT = flatLayout("Lens Edu/courses/mini.md");
export const MINI_FOLDERS = layoutFor(MINI_FLAT.course);

const A = { id: "A", label: "A — Alignment", urlSlug: "alignment" };
const B = { id: "B", label: "B — Learning", urlSlug: "learning" };

export function worksheet(slug: string, cluster: Worksheet["cluster"], dayCode: string, dayTitle: string, code = dayCode): Worksheet {
  return {
    slug,
    cluster,
    dayCode,
    dayTitle,
    code,
    title: dayTitle,
    summary: null,
    contributors: ["Ada L (Iliad)"],
    slides: null,
    pageUrl: `https://iliad-intensive.org/${cluster.urlSlug}/${slug}/`,
    mdx: "",
  };
}

/** The mini course's worksheets, in taught order. */
export const WORKSHEETS = (): Worksheet[] => [
  worksheet("intro", A, "A.1", "Intro"),
  worksheet("practice", A, "A.2", "Practice"),
  worksheet("mysteries", B, "B.2", "Mysteries"),
  worksheet("slt", B, "B.3", "SLT"),
];

const lens = (id: string, title: string, slug: string, cluster: string, body: string) => `---
id: '${id}'
title: "${title}"
tldr: "What ${title} says."
summary_for_tutor: "For the tutor: ${title}."
authors:
  - Ada L (Iliad)
source_url: https://iliad-intensive.org/${cluster}/${slug}/
upstream_commit: 'c0'
provenance_recorded_at: '2026-10-08'
---

${body}
`;
const text = (markdown: string) => `#### Text\ncontent::\n${markdown}`;
const reading = (id: string) => `---\nid: ${id}\ntitle: "${id}"\n---\n\n#### Article\nsource:: [[../articles/${id}]]\n`;
const article = (id: string) => `---\ntitle: "${id}"\nauthor: Someone\nsource_url: https://example.org/${id}\npublished: 2020-01-01\n---\n\nThe text of ${id}.\n`;

export const MINI: Record<string, string> = {
  "Lens Edu/courses/mini.md": `---
slug: mini
title: "Mini"
---
# Module: [[../modules/Iliad A.1 - Intro|A.1 Intro]]
# Module: [[../modules/Iliad A.2 - Practice|A.2 Practice]]
# Meeting: Unit A

# Module: [[../modules/Iliad B - Learning|B — Learning]]

# Meeting: Unit B`,

  "Lens Edu/modules/Iliad A.1 - Intro.md": `---
id: 'm-a1'
slug: iliad-a1
title: "A.1 Intro"
---

# Lens: A.1.1 Opening
source:: [[../Lenses/Iliad A.1 - Intro]]

# Lens: A.1.2 Targets
source:: [[../Lenses/Iliad A.1.2 - Targets]]

# Lens: CEV
source:: [[../Lenses/cev]]
optional:: true

# Lens: Corrigibility
source:: [[../Lenses/corrigibility]]
optional:: true

`,
  // No newline at the end, as one module of the hand import has it.
  "Lens Edu/modules/Iliad A.2 - Practice.md": `---
id: 'm-a2'
slug: iliad-a2
title: "A.2 Practice"
---

# Lens: A.2.1 Overview
source:: [[../Lenses/Iliad A.2.1 - Overview]]

# Lens: Responsible scaling
source:: [[../Lenses/rsp]]`,

  "Lens Edu/modules/Iliad B - Learning.md": `---
id: 'm-b'
slug: iliad-learning
title: "B — Learning"
---

# Submodule: B.2 Mysteries of Deep Learning

# Lens: B.2.1 Overview
source:: [[../Lenses/Iliad B.2.1 - Overview]]

# Submodule: B.3 Singular Learning Theory

# Lens: B.3.1 Introduction
source:: [[../Lenses/Iliad B.3.1 - Introduction]]

# Lens: B.3.2 Degeneracy
source:: [[../Lenses/Iliad B.3.2 - Degeneracy]]
`,

  // The first lens of a worksheet kept the worksheet's name in the hand import.
  "Lens Edu/Lenses/Iliad A.1 - Intro.md": lens("a11", "A.1.1 Opening", "intro", "alignment", text("Welcome to the day.\n\n\\## Roadmap\n\nWe start at ten.")),
  "Lens Edu/Lenses/Iliad A.1.2 - Targets.md": lens(
    "a12",
    "A.1.2 Targets",
    "intro",
    "alignment",
    text(`\\## Targets

Read one of these: [CEV](https://example.org/cev), [Corrigibility](https://example.org/corrigibility).

:::require_x_optional_lenses{x=1}
::card[[../Lenses/cev|CEV]]

> Most important: section 3.

::card[[../Lenses/corrigibility|Corrigibility]]
:::

Then discuss in groups.

\\### Debrief

Ten minutes.`),
  ),
  "Lens Edu/Lenses/Iliad A.2.1 - Overview.md": lens("a21", "A.2.1 Overview", "practice", "alignment", text("\\## Overview\n\nLabs publish policies such as the [RSP](https://example.org/rsp).")),
  "Lens Edu/Lenses/Iliad B.2.1 - Overview.md": lens("b21", "B.2.1 Overview", "mysteries", "learning", text("\\## Overview\n\nWhy does deep learning work?")),
  "Lens Edu/Lenses/Iliad B.3.1 - Introduction.md": lens(
    "b31",
    "B.3.1 Introduction",
    "slt",
    "learning",
    `${text("**Contents**\n\n- Introduction")}\n\n#### Video\nsource:: [[../video_transcripts/singular]]\n\n${text("\\## Introduction\n\nSingular learning theory accounts for degeneracy.")}`,
  ),
  "Lens Edu/Lenses/Iliad B.3.2 - Degeneracy.md": lens("b32", "B.3.2 Degeneracy", "slt", "learning", text("\\## Degeneracy\n\nA definition.\n\n\\### Symmetries\n\nContinuous ones.")),

  "Lens Edu/Lenses/cev.md": reading("cev"),
  "Lens Edu/Lenses/corrigibility.md": reading("corrigibility"),
  "Lens Edu/Lenses/rsp.md": reading("rsp"),
  "Lens Edu/articles/cev.md": article("cev"),
  "Lens Edu/articles/corrigibility.md": article("corrigibility"),
  "Lens Edu/articles/rsp.md": article("rsp"),
  "Lens Edu/video_transcripts/singular.md": `---\ntitle: "Deep Learning Is Singular"\nchannel: "Iliad"\nurl: "https://www.youtube.com/watch?v=SzVmiN8BvCc"\n---\n\nA transcript.\n`,
};

/** CourseFiles in memory. `calls` lists what was done, in order. */
export function memoryFiles(initial: Record<string, string> = MINI): CourseFiles & { files: Map<string, string>; calls: string[] } {
  const files = new Map(Object.entries(initial));
  const calls: string[] = [];
  const take = (path: string): string => {
    const content = files.get(path);
    if (content === undefined) throw new Error(`"${path}" does not exist`);
    files.delete(path);
    return content;
  };
  return {
    files,
    calls,
    read: async (path) => files.get(path) ?? null,
    async write(path, content) {
      calls.push(`write ${path}`);
      files.set(path, content);
    },
    async move(from, to) {
      calls.push(`move ${from} -> ${to}`);
      if (files.has(to)) throw new Error(`"${to}" already exists`);
      files.set(to, take(from));
    },
    async trash(path) {
      calls.push(`trash ${path}`);
      files.set(path.replace(/^([^/]+)\//, "$1/_trash/"), take(path));
    },
    hostImage: async (_bytes, stem) => `attachments/${stem}.png`,
  };
}

/**
 * A lens's own text as the converter would hand it over: one atom per
 * heading. A line directly above a heading goes with the heading (the hand
 * import opens a hidden section with a "%% ..." line there).
 */
export function atomsOf(lens: LensState, state: CourseState, firstOfWorksheet: boolean): Atom[] {
  const body = readLensBody(splitFrontmatter(lens.content).body);
  const videoIds = new Map([...state.transcripts].map(([id, path]) => [path, id]));
  const atoms: Atom[] = [];
  const open = (anchor: string, level: Atom["level"], title: string) => atoms.push({ anchor, level, title, words: 0, parts: [], links: [] });
  const current = () => atoms[atoms.length - 1] ?? atoms[open(firstOfWorksheet ? "" : `inside-${lens.id}`, 0, "") - 1];
  let heading = 0;
  for (const part of body.parts) {
    if ("video" in part) {
      current().parts.push({ kind: "video", youtubeId: videoIds.get(linkTarget(lens.path, part.video)) ?? "unknown", title: null });
      continue;
    }
    let lines: string[] = [];
    let fenced = false;
    const close = () => {
      const markdown = lines.join("\n");
      if (markdown.trim()) current().parts.push({ kind: "text", markdown });
      for (const [, label, url] of markdown.matchAll(/\[([^\]]*)\]\((https?:[^)\s]+)\)/g)) current().links.push({ text: label, url });
      lines = [];
    };
    for (const line of part.text.split("\n")) {
      if (/^ {0,3}(```|~~~)/.test(line)) fenced = !fenced;
      const found = fenced ? null : line.match(/^[\\!]?(#{2,4})\s+(\S.*?)\s*$/);
      if (found) {
        const above = lines.length && lines[lines.length - 1].trim() ? lines.splice(lines.findLastIndex((l) => !l.trim()) + 1) : [];
        close();
        open(lens.headingAnchors[heading++], found[1].length as Atom["level"], found[2]);
        lines = above;
      }
      lines.push(line);
    }
    close();
  }
  if (heading !== lens.headingAnchors.length) throw new Error(`${lens.path}: ${heading} headings found, ${lens.headingAnchors.length} read`);
  return atoms;
}

/** A run whose source says what the course already says: every lens continued, nothing new. */
export function sameAsNow(state: CourseState, worksheets: Worksheet[], commit: string): SyncInput {
  const seen = new Set<string>();
  return {
    commit,
    worksheets: worksheets.map((sheet) => ({
      worksheet: sheet,
      lenses: state.lenses
        .filter((lens) => lens.slug === sheet.slug)
        .map((lens) => {
          const atoms = atomsOf(lens, state, !seen.has(lens.slug));
          seen.add(lens.slug);
          const key = lens.upstreamKey ?? lensKey(lens.slug, atoms[0].anchor);
          return { planned: { key, pinned: { key, id: lens.id, fingerprint: lens.fingerprint ?? "" }, atoms }, fingerprint: `chars:${lens.text.length}` };
        }),
    })),
  };
}
