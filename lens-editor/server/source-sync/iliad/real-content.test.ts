/**
 * The file step against the real course: the hand import of 8 Oct 2026 is
 * read back, every lens is composed again from its own text, and the result
 * must be the import itself plus the sync's frontmatter.
 *
 * Opt-in: set ILIAD_FIXTURES to a directory holding `lens-edu/` (a
 * checkout of the Lens Edu content) and `built/schedule.yaml` (Iliad's).
 * Nothing is written there: runs that write work on a copy.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { flatLayout, sameAsNow } from "./__fixtures__/files/course";
import { applyFilePlan, planCourseFiles } from "./course-files";
import { readCourseState, type CourseState } from "./course-state";
import { dirCourseFiles } from "./dir-course-files";
import { LAYOUT, lensFileName, linkTargets } from "./layout";
import { splitFrontmatter } from "./module-file";
import type { CourseFiles, Worksheet } from "./types";

const FIXTURES = process.env.ILIAD_FIXTURES;
const FLAT_LAYOUT = flatLayout(LAYOUT.course);
const IMPORT_COMMIT = "46ea03c036a05c7687d702d509037521e19f3b0c";

interface Schedule {
  clusters: { id: string; label: string; urlSlug: string; days: { code: string; title: string; worksheets: string[] }[] }[];
}

/** The schedule's worksheets, with the authors the hand import recorded. */
function worksheets(schedule: Schedule, state: CourseState): Worksheet[] {
  return schedule.clusters.flatMap((cluster) =>
    cluster.days.flatMap((day) =>
      day.worksheets.map((slug, i): Worksheet => {
        const first = state.lenses.find((lens) => lens.slug === slug);
        const authors = first ? (splitFrontmatter(first.content).data.authors as string[] | undefined) : undefined;
        return {
          slug,
          cluster: { id: cluster.id, label: cluster.label, urlSlug: cluster.urlSlug },
          dayCode: day.code,
          dayTitle: day.title,
          code: day.worksheets.length > 1 ? `${day.code}.${i + 1}` : day.code,
          title: day.title,
          summary: null,
          contributors: authors ?? [],
          slides: null,
          pageUrl: `https://iliad-intensive.org/${cluster.urlSlug}/${slug}/`,
          mdx: "",
        };
      }),
    ),
  );
}

const body = (content: string) => content.slice(splitFrontmatter(content).head.length);
/** Frontmatter lines; a list item reads the same with or without quotes (the import copied one author line quoted). */
const frontmatterLines = (content: string) => splitFrontmatter(content).head.split("\n").map((line) => line.replace(/^(\s+- )"(.*)"$/, "$1$2"));

describe.skipIf(!FIXTURES)("the hand import, read back and composed again", () => {
  const content = join(FIXTURES ?? "", "lens-edu");
  let schedule: Schedule;
  let state: CourseState;
  /** Every path the state reader read: what a copy of the course needs. */
  const read = new Set<string>();
  const scratch: string[] = [];

  /** A copy of the course's files that a test may write to. */
  const copy = (): { root: string; files: CourseFiles } => {
    const root = mkdtempSync(join(tmpdir(), "iliad-files-"));
    scratch.push(root);
    for (const path of read) cpSync(join(content, path.slice("Lens Edu/".length)), join(root, path.slice("Lens Edu/".length)));
    return { root, files: dirCourseFiles(root) };
  };

  beforeAll(async () => {
    schedule = parseYaml(readFileSync(join(FIXTURES!, "built", "schedule.yaml"), "utf8")) as Schedule;
    const files = dirCourseFiles(content);
    state = await readCourseState({ ...files, read: (path) => (read.add(path), files.read(path)) }, FLAT_LAYOUT);
  });
  afterAll(() => scratch.forEach((root) => rmSync(root, { recursive: true, force: true })));

  it("finds the course: 8 modules, 198 Iliad lenses, 106 readings", () => {
    const blocks = state.modules.flatMap((module) => module.blocks);
    expect(state.modules).toHaveLength(8);
    expect(state.lenses).toHaveLength(198);
    expect(blocks.filter((block) => block.lens)).toHaveLength(198);
    expect(blocks.filter((block) => block.reading)).toHaveLength(106);
    expect(blocks.filter((block) => block.reading && !block.reading.url)).toEqual([]);
    expect(new Set(state.lenses.map((lens) => lens.slug)).size).toBe(27);
    expect(state.transcripts.size).toBe(6);
    // Every card is taken out of the text and kept: 85 card lines, 4 of the blocks are choose-x lists.
    const cards = state.lenses.flatMap((lens) => lens.cards.map((card) => card.block));
    expect(cards.join("\n").match(/^::card\[\[/gm)).toHaveLength(85);
    expect(cards.filter((block) => block.startsWith(":::require_x_optional_lenses"))).toHaveLength(4);
    expect(state.lenses.filter((lens) => lens.text.includes("::card"))).toEqual([]);
    expect(state.lenses.flatMap((lens) => lens.others)).toEqual([]);
    expect(state.commit).toBeNull();
  });

  it("names a new lens file as the hand import did", () => {
    const regular = state.lenses.filter((lens) => posix.basename(lens.path, ".md") === lensFileName(lens.title));
    expect(regular).toHaveLength(188);
  });

  it("with no change in the source and the flat layout, rewrites only frontmatter", () => {
    const plan = planCourseFiles(state, sameAsNow(state, worksheets(schedule, state), IMPORT_COMMIT), { layout: FLAT_LAYOUT });
    expect(plan.warnings).toEqual([]);
    expect(plan.steps.filter((step) => step.do !== "write")).toEqual([]);
    const written = new Map(plan.steps.flatMap((step) => (step.do === "write" ? [[step.path, step.content]] : [])));
    // 198 lenses, and the course file for its commit; no module.
    expect([...written.keys()].filter((path) => !state.lenses.some((lens) => lens.path === path))).toEqual([state.path]);
    expect(written.size).toBe(199);
    expect(plan.steps[plan.steps.length - 1]).toMatchObject({ do: "write", path: state.path });

    for (const lens of state.lenses) {
      const now = written.get(lens.path)!;
      expect(body(now), lens.path).toBe(body(lens.content));
      const before = frontmatterLines(lens.content);
      const after = frontmatterLines(now);
      expect(before.filter((line) => !after.includes(line)), lens.path).toEqual(["provenance_recorded_at: '2026-10-08'"]);
      const added = after.filter((line) => !before.includes(line)).map((line) => line.replace(/:.*/, ""));
      expect(added, lens.path).toEqual(["upstream_key", "upstream_fingerprint", "synced_from", "  source", "  url"]);
    }
    expect(written.get(state.path)).toBe(state.content.replace("\n---\n", `\nupstream_commit: '${IMPORT_COMMIT}'\n---\n`));
  });

  it("is quiet on the next run, and writes one worksheet when one changed", async () => {
    const { files } = copy();
    await applyFilePlan(files, planCourseFiles(state, sameAsNow(state, worksheets(schedule, state), IMPORT_COMMIT), { layout: FLAT_LAYOUT }));

    const synced = await readCourseState(files, FLAT_LAYOUT);
    expect(synced.commit).toBe(IMPORT_COMMIT);
    expect(synced.lenses.every((lens) => lens.upstreamKey && lens.fingerprint)).toBe(true);
    expect(planCourseFiles(synced, sameAsNow(synced, worksheets(schedule, synced), IMPORT_COMMIT), { layout: FLAT_LAYOUT }).steps).toEqual([]);

    // A later commit that changed nothing here: the course file's commit, and nothing else.
    const later = planCourseFiles(synced, sameAsNow(synced, worksheets(schedule, synced), "later"), { layout: FLAT_LAYOUT });
    expect(later.steps.map((step) => (step as { path: string }).path)).toEqual([synced.path]);

    // A later commit that changed one paragraph of one worksheet.
    const input = sameAsNow(synced, worksheets(schedule, synced), "later");
    const aixi = input.worksheets.find(({ worksheet }) => worksheet.slug === "aixi")!;
    const part = aixi.lenses[3].planned.atoms[0].parts.find((p) => p.kind === "text")!;
    if (part.kind === "text") part.markdown += "\n\nA sentence Iliad added.";
    const changed = planCourseFiles(synced, input, { layout: FLAT_LAYOUT });
    const lens = synced.lenses.filter((l) => l.slug === "aixi")[3];
    expect(changed.steps.map((step) => (step as { path: string }).path)).toEqual([lens.path, synced.path]);
    expect((changed.steps[0] as { content: string }).content).toContain("upstream_commit: 'later'");
  });

  it("numbers and places a new lens as the import would: after its neighbour's readings, in the same submodule", () => {
    const input = sameAsNow(state, worksheets(schedule, state), IMPORT_COMMIT);
    const intro = input.worksheets.find(({ worksheet }) => worksheet.slug === "ai-alignment-intro")!;
    const atom = { anchor: "session-3b-agency", level: 3 as const, title: "Session 3b: Agency", words: 3, parts: [{ kind: "text" as const, markdown: "\\### Session 3b: Agency\n\nNew." }], links: [] };
    intro.lenses.splice(4, 0, { planned: { key: "ai-alignment-intro#session-3b-agency", pinned: null, atoms: [atom] }, fingerprint: "new" });

    const plan = planCourseFiles(state, input, { layout: FLAT_LAYOUT });
    const written = new Map(plan.steps.flatMap((step) => (step.do === "write" ? [[step.path, step.content]] : [])));
    // The worksheet has used A.1.0 to A.1.8.
    expect(written.has("Lens Edu/Lenses/Iliad A.1.9 - Session 3b - Agency.md")).toBe(true);
    const module = written.get("Lens Edu/modules/Iliad A.1 - AI Alignment Introduction.md")!;
    expect(module).toContain(
      "# Lens: Basic AI drives\nsource:: [[../Lenses/omohundro-the-basic-ai-drives]]\n\n" +
        "# Lens: A.1.9 Session 3b: Agency\nsource:: [[../Lenses/Iliad A.1.9 - Session 3b - Agency]]\n\n" +
        "# Submodule: A.1 Session 4: Uncertain risks and outlook\n",
    );
    expect([...written.keys()].filter((path) => path.includes("/modules/"))).toHaveLength(1);
  });

  it("with the folder layout, moves each file once and every link still leads somewhere", async () => {
    const { files } = copy();
    const plan = planCourseFiles(state, sameAsNow(state, worksheets(schedule, state), IMPORT_COMMIT));
    expect(plan.warnings).toEqual([]);
    const moves = plan.steps.flatMap((step) => (step.do === "move" ? [step] : []));
    expect(moves).toHaveLength(198 + 8);
    expect(new Set(moves.map((move) => move.from)).size).toBe(206);
    expect(new Set(moves.map((move) => move.to)).size).toBe(206);
    for (const move of moves) expect(posix.basename(move.to)).toBe(posix.basename(move.from));
    expect(new Set(moves.map((move) => posix.dirname(move.to))).size).toBe(23 + 1); // a folder per taught day, and the modules'
    expect(plan.steps.filter((step) => step.do === "trash")).toEqual([]);
    // A move comes before the write of the same file, lenses before modules, the course file last.
    const order = plan.steps.map((step) => (step.do === "move" ? step.to : step.do === "write" ? step.path : ""));
    const kinds = order.map((path) => (path === state.path ? 2 : path.startsWith(LAYOUT.moduleDir) ? 1 : 0));
    expect(kinds).toEqual([...kinds].sort());

    const report = await applyFilePlan(files, plan);
    expect(report.moved).toHaveLength(206);
    expect(report.written).toHaveLength(198 + 8 + 1);

    // Reading the course again follows every module and lens link; it stops on one that leads nowhere.
    const moved = await readCourseState(files);
    expect(moved.modules).toHaveLength(8);
    expect(moved.lenses.map((lens) => lens.id)).toEqual(state.lenses.map((lens) => lens.id));
    expect(moved.transcripts).toEqual(state.transcripts);
    const readings = (s: CourseState) => s.modules.flatMap((module) => module.blocks.flatMap((block) => block.reading?.path ?? []));
    expect(readings(moved)).toEqual(readings(state));
    for (const lens of moved.lenses) {
      expect(lens.path.startsWith("Lens Edu/Lenses/Iliad/"), lens.path).toBe(true);
      for (const target of linkTargets(lens.content, lens.path)) expect(await files.read(target), `${lens.path} -> ${target}`).not.toBeNull();
      expect(lens.cards.length, lens.path).toBe(state.lenses.find((l) => l.id === lens.id)!.cards.length);
    }
    for (const move of moves) expect(await files.read(move.from), move.from).toBeNull();
    expect(planCourseFiles(moved, sameAsNow(moved, worksheets(schedule, moved), IMPORT_COMMIT)).steps).toEqual([]);
    expect(dirname(moved.path)).toBe(dirname(state.path));
  });

  // For the legality check: copy lens-edu/repo, point ILIAD_APPLY_TO at the
  // copy, run this, then run Lens's content validator on the copy and on the
  // original and compare what each says about the course.
  it.skipIf(!process.env.ILIAD_APPLY_TO)("applies the folder layout to the copy in ILIAD_APPLY_TO", async () => {
    const files = dirCourseFiles(process.env.ILIAD_APPLY_TO!);
    const before = await readCourseState(files, FLAT_LAYOUT);
    const report = await applyFilePlan(files, planCourseFiles(before, sameAsNow(before, worksheets(schedule, before), IMPORT_COMMIT)));
    expect(report.moved).toHaveLength(206);
    expect(report.warnings).toEqual([]);
  });
});
