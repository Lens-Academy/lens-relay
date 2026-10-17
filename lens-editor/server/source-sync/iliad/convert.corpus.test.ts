/**
 * The converter against the real course: every built worksheet is
 * converted, and its text is compared with the lenses of the hand import of
 * 8 Oct 2026, which were made from the same pages.
 *
 * Opt-in: ILIAD_FIXTURES is a directory with `built/` (Iliad's schedule.yaml and
 * the 28 built `<slug>.mdx` worksheets) and `lens-edu/` (a checkout of the
 * Lens Edu content).
 * The comparison is printed; the assertions hold for source commit d5fec17.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { convertWorksheet } from "./convert";
import type { Converted, Worksheet } from "./types";

const CORPUS = process.env.ILIAD_FIXTURES ?? "";
const IMPORT_COMMIT = "46ea03c";
/** The source added a section to this worksheet after the import, so the two no longer hold the same text. */
const CHANGED_SINCE = "policy-gradients-misgeneralization";

interface HandImport {
  pageUrl: string;
  /** Lens bodies of the worksheet, in the order the module files list them. */
  bodies: string[];
}

/** The hand import by worksheet slug. */
function handImport(edu: string): Map<string, HandImport> {
  const sheets = new Map<string, HandImport>();
  const seen = new Set<string>();
  for (const module of readdirSync(join(edu, "modules")).filter((name) => name.startsWith("Iliad ")).sort()) {
    for (const [, name] of readFileSync(join(edu, "modules", module), "utf8").matchAll(/^source:: \[\[\.\.\/Lenses\/(Iliad [^\]|]+)\]\]/gm)) {
      const path = join(edu, "Lenses", `${name}.md`);
      if (seen.has(name) || !existsSync(path)) continue;
      seen.add(name);
      const [, frontmatter, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(readFileSync(path, "utf8")) ?? [];
      const pageUrl = /^source_url:\s*['"]?(\S+?)['"]?\s*$/m.exec(frontmatter ?? "")?.[1];
      if (!pageUrl || !new RegExp(`^upstream_commit:\\s*'?${IMPORT_COMMIT}`, "m").test(frontmatter)) continue;
      const slug = pageUrl.replace(/\/$/, "").split("/").pop()!;
      if (!sheets.has(slug)) sheets.set(slug, { pageUrl, bodies: [] });
      sheets.get(slug)!.bodies.push(body);
    }
  }
  return sheets;
}

/** Lines of text to compare: no empty lines, and every image at the same URL. */
const comparable = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trimEnd().replace(/(!\[[^\]]*\])\([^)]*\)/g, "$1(IMAGE)"))
    .filter(Boolean);

/**
 * The lines of a lens that come from the source. What a lens has beyond the
 * source is left out: segment headers, and the reading cards a person put in
 * place of the links to readings.
 */
function sourceLines(body: string): string[] {
  const kept: string[] = [];
  let cards = false;
  for (const line of body.split("\n")) {
    if (line === "#### Text" || line === "content::" || line.startsWith("source:: ")) continue;
    if (/^:::require_x_optional_lenses/.test(line)) cards = true;
    else if (cards && line.trim() === ":::") cards = false;
    else if (!cards && !line.startsWith("::card")) kept.push(line === "#### Video" ? "[video]" : line);
  }
  return comparable(kept.join("\n"));
}

const textOf = ({ atoms }: Converted): string =>
  atoms.flatMap((atom) => atom.parts.map((part) => (part.kind === "text" ? part.markdown : "[video]"))).join("\n\n");

/** Lines of `a` that `b` lacks, counting repeats; `as` says what makes two lines the same. */
function missingFrom(a: string[], b: string[], as: (line: string) => string = (line) => line): string[] {
  const left = new Map<string, number>();
  for (const line of b) left.set(as(line), (left.get(as(line)) ?? 0) + 1);
  return a.filter((line) => {
    const n = left.get(as(line)) ?? 0;
    if (n > 0) left.set(as(line), n - 1);
    return n === 0;
  });
}

/**
 * The one rule that departs from the import on purpose: the import put every
 * expanded macro in braces, the converter leaves an operator or relation
 * bare (mdx-macros.ts). Lines that differ in braces only are counted apart.
 */
const bracesAside = (line: string): string => line.replace(/[{}]/g, "");

describe.skipIf(!CORPUS)("the whole course", { timeout: 120_000 }, () => {
  const edu = join(CORPUS, "lens-edu");
  const imported = CORPUS ? handImport(edu) : new Map<string, HandImport>();
  const slugs = CORPUS
    ? readdirSync(join(CORPUS, "built"))
        .filter((name) => name.endsWith(".mdx") && !name.endsWith("-nosol.mdx"))
        .map((name) => name.replace(".mdx", ""))
        .sort()
    : [];
  const pageOf = (slug: string): Worksheet => ({
    slug,
    cluster: { id: "X", label: "X", urlSlug: "x" },
    dayCode: "X.1",
    dayTitle: slug,
    code: "X.1",
    title: slug,
    summary: null,
    contributors: [],
    slides: null,
    pageUrl: imported.get(slug)?.pageUrl ?? `https://iliad-intensive.org/x/${slug}/`,
    mdx: readFileSync(join(CORPUS, "built", `${slug}.mdx`), "utf8").replace(/^---\n[\s\S]*?\n---\n/, ""),
  });
  const convert = (slug: string) => convertWorksheet(pageOf(slug), async (sitePath) => `https://img.test${sitePath}.png`);

  it("converts every worksheet to Lens markdown with no MDX left in it", async () => {
    expect(slugs).toHaveLength(28);
    const warnings: string[] = [];
    for (const slug of slugs) {
      const converted = await convert(slug);
      expect(await convert(slug), slug).toEqual(converted);
      warnings.push(...converted.warnings);
      const text = textOf(converted);
      // Outside maths and code: no comment, component, relative link or single dollar of the source.
      const prose = text.replace(/```[\s\S]*?```|\$\$[\s\S]*?\$\$|`[^`\n]*`|\\\$/g, "");
      expect(prose.match(/\{\/\*|\*\/\}|<\/?[A-Za-z][^<>\n]*>|\]\([#/][^)]*\)|\$/g) ?? [], slug).toEqual([]);
      expect(text.match(/^#.*$/gm) ?? [], slug).toEqual([]);
      const anchors = converted.atoms.map((atom) => atom.anchor);
      expect(new Set(anchors).size, slug).toBe(anchors.length);
      // The page's own table of contents is written by the site's build, whose links are the site's anchors with
      // runs of hyphens made one and the ends trimmed ("-1. Prerequisites" is linked as #1-prerequisites, and is a
      // dead link there). A heading with maths is left out: the build keeps the formula's letters in the link.
      const linked = (anchor: string) => anchor.replace(/-+/g, "-").replace(/^-|-$/g, "");
      const contents = /\*\*Contents\*\*\n\n((?:[ \t]*- \[.*\n)+)/.exec(pageOf(slug).mdx)?.[1] ?? "";
      for (const [, anchor] of contents.matchAll(/^[^$\n]*\]\(#([^)]*)\)$/gm)) expect(anchors.map(linked), `${slug} #${anchor}`).toContain(anchor);
    }
    expect(warnings).toEqual(['ai-alignment-intro: line 247: a heading has no text; the line below it ("Further reading") is taken as its text']);
  });

  it("starts an atom at each exercise a lens of the hand import starts at", async () => {
    // Five lenses of the import begin in the middle of a section, at an exercise. A sixth (E.2.6) begins at a solution.
    const starts: [lens: string, slug: string, exercise: string][] = [
      ["Iliad A.4.4 - ", "reward-learning-theory", "prob-jobs-interp"],
      ["Iliad B.5.4 - ", "data-attribution", "ex-ols-if"],
      ["Iliad C.3.3 - ", "computational-mechanics", "ex-p2-3"],
      ["Iliad C.3.5 - ", "computational-mechanics", "ex-p3-3"],
      ["Iliad D.4.1.5 - ", "agent-foundations", "ex-complete-class"],
    ];
    const firstLines = (text: string) => comparable(text).slice(0, 3);
    for (const [lens, slug, exercise] of starts) {
      const file = readdirSync(join(edu, "Lenses")).find((name) => name.startsWith(lens))!;
      const body = readFileSync(join(edu, "Lenses", file), "utf8").replace(/^---\n[\s\S]*?\n---\n\s*#### Text\ncontent::\n/, "");
      const atom = (await convert(slug)).atoms.find((a) => a.anchor === exercise);
      expect(atom, file).toMatchObject({ level: 5, title: "" });
      expect(atom!.parts[0].kind === "text" ? firstLines(atom!.parts[0].markdown) : [], file).toEqual(firstLines(body));
    }
  });

  it("gives the text of the hand import", async () => {
    const report: string[] = [`${"worksheet".padEnd(36)} ${["lenses", "lines", "same", "only here", "only imp.", "similar", "braces aside"].map((cell) => cell.padStart(9)).join(" ")}`];
    const unexplained: string[] = [];
    let total = 0;
    let shared = 0;
    for (const slug of slugs.filter((s) => imported.has(s) && s !== CHANGED_SINCE)) {
      const mine = comparable(textOf(await convert(slug)));
      const theirs = imported.get(slug)!.bodies.flatMap(sourceLines);
      const onlyMine = missingFrom(mine, theirs);
      const onlyTheirs = missingFrom(theirs, mine);
      const same = mine.length - onlyMine.length;
      const stillMine = missingFrom(onlyMine, onlyTheirs, bracesAside);
      const stillTheirs = missingFrom(onlyTheirs, onlyMine, bracesAside);
      const sameBracesAside = mine.length - stillMine.length;
      const similarity = (n: number) => ((2 * n) / (mine.length + theirs.length)).toFixed(4);
      const cells = [imported.get(slug)!.bodies.length, mine.length, same, onlyMine.length, onlyTheirs.length, similarity(same), similarity(sameBracesAside)];
      report.push(`${slug.padEnd(36)} ${cells.map((cell) => String(cell).padStart(9)).join(" ")}`);
      total += mine.length + theirs.length;
      shared += 2 * sameBracesAside;
      unexplained.push(...[...stillMine.map((line) => `+ ${line}`), ...stillTheirs.map((line) => `- ${line}`)].map((line) => `${slug} ${line.slice(0, 170)}`));
      expect(Number(similarity(sameBracesAside)), slug).toBeGreaterThan(0.9);
    }
    console.log(`${report.join("\n")}\n\nall: ${(shared / total).toFixed(4)} of lines the same, braces aside`);
    console.log(`lines that differ, braces aside (+ here, - in the import):\n${unexplained.sort((a, b) => b.length - a.length).join("\n")}`);
    expect(report).toHaveLength(1 + 26);
    expect(shared / total).toBeGreaterThan(0.99);
  });
});
