import { describe, expect, it } from "vitest";
import { MINI, MINI_FLAT, MINI_FOLDERS, memoryFiles, sameAsNow, worksheet, WORKSHEETS } from "./__fixtures__/files/course";
import { APPROVE_RETIREMENT_ENV, applyFilePlan, MAX_RETIRED, planCourseFiles, sameWork, type FilePlan, type LensInput, type SyncInput } from "./course-files";
import { readCourseState } from "./course-state";
import { linkTargets } from "./layout";
import { splitFrontmatter } from "./module-file";
import { lensKey, type Atom, type Worksheet } from "./types";

const COURSE = MINI_FLAT.course;
const lensPath = (name: string) => `Lens Edu/Lenses/${name}.md`;
const modulePath = (name: string) => `Lens Edu/modules/${name}.md`;

let ids = 0;
const options = { layout: MINI_FLAT, newId: () => `new-${++ids}` };

/** The mini course after its first run: every lens pinned, the course file at commit c1. */
async function synced(initial: Record<string, string> = MINI) {
  const files = memoryFiles(initial);
  const first = await readCourseState(files, MINI_FLAT);
  await applyFilePlan(files, planCourseFiles(first, sameAsNow(first, WORKSHEETS(), "c1"), options));
  files.calls.length = 0;
  const state = await readCourseState(files, MINI_FLAT);
  return { files, state, input: sameAsNow(state, WORKSHEETS(), "c2") };
}

const written = (plan: FilePlan) => new Map(plan.steps.flatMap((step) => (step.do === "write" ? [[step.path, step.content] as const] : [])));
const summary = (plan: FilePlan) => plan.steps.map((step) => (step.do === "move" ? `move ${step.from} -> ${step.to}` : `${step.do} ${step.path}`));
const lensesOf = (input: SyncInput, slug: string): LensInput[] => input.worksheets.find((w) => w.worksheet.slug === slug)!.lenses;
const section = (anchor: string, title: string, markdown: string, links: Atom["links"] = []): Atom => ({
  anchor,
  level: 2,
  title,
  words: 0,
  parts: [{ kind: "text", markdown: `\\## ${title}\n\n${markdown}` }],
  links,
});
const fresh = (slug: string, atom: Atom): LensInput => ({ planned: { key: lensKey(slug, atom.anchor), pinned: null, atoms: [atom] }, fingerprint: "new" });
/** The `# Lens:` and `# Submodule:` titles of a module file, in order. */
const listed = (module: string) => [...module.matchAll(/^# (Lens|Submodule): (.*)$/gm)].map((m) => (m[1] === "Lens" ? m[2] : `[${m[2]}]`));

describe("readCourseState", () => {
  it("reads the course through its module files", async () => {
    const state = await readCourseState(memoryFiles(), MINI_FLAT);
    expect(state.commit).toBeNull();
    expect(state.modules.map((module) => module.title)).toEqual(["A.1 Intro", "A.2 Practice", "B — Learning"]);
    expect(state.lenses.map((lens) => [lens.id, lens.slug, lens.title])).toEqual([
      ["a11", "intro", "A.1.1 Opening"],
      ["a12", "intro", "A.1.2 Targets"],
      ["a21", "practice", "A.2.1 Overview"],
      ["b21", "mysteries", "B.2.1 Overview"],
      ["b31", "slt", "B.3.1 Introduction"],
      ["b32", "slt", "B.3.2 Degeneracy"],
    ]);
    const readings = state.modules.flatMap((module) => module.blocks.flatMap((block) => block.reading ?? []));
    expect(readings).toEqual([
      { path: lensPath("cev"), url: "https://example.org/cev" },
      { path: lensPath("corrigibility"), url: "https://example.org/corrigibility" },
      { path: lensPath("rsp"), url: "https://example.org/rsp" },
    ]);
    expect(state.transcripts).toEqual(new Map([["SzVmiN8BvCc", "Lens Edu/video_transcripts/singular.md"]]));
  });

  it("gives a lens of the hand import what the planner pins it by", async () => {
    const state = await readCourseState(memoryFiles(), MINI_FLAT);
    const [opening, targets, , , introduction, degeneracy] = state.lenses;
    expect(opening).toMatchObject({ upstreamKey: null, fingerprint: null, upstreamCommit: "c0", headingAnchors: ["roadmap"] });
    expect(opening.text).toBe("Welcome to the day.\n\n\\## Roadmap\n\nWe start at ten.");
    expect(targets).toMatchObject({ headingAnchors: ["targets", "debrief"], tldr: "What A.1.2 Targets says." });
    expect(targets.text).not.toContain("::card");
    expect(targets.cards).toEqual([
      {
        anchor: "targets",
        after: ["Read one of these: [CEV](https://example.org/cev), [Corrigibility](https://example.org/corrigibility)."],
        nth: 0,
        block: ":::require_x_optional_lenses{x=1}\n::card[[../Lenses/cev|CEV]]\n\n> Most important: section 3.\n\n::card[[../Lenses/corrigibility|Corrigibility]]\n:::",
      },
    ]);
    expect(introduction).toMatchObject({ videos: ["SzVmiN8BvCc"], headingAnchors: ["introduction"] });
    expect(degeneracy.headingAnchors).toEqual(["degeneracy", "symmetries"]);
  });

  it("numbers a repeated heading as the site does, across the lenses of a worksheet", async () => {
    const twice = { ...MINI, [lensPath("Iliad B.3.2 - Degeneracy")]: MINI[lensPath("Iliad B.3.2 - Degeneracy")].replace("\\### Symmetries", "\\### Introduction") };
    const state = await readCourseState(memoryFiles(twice), MINI_FLAT);
    expect(state.lenses[5].headingAnchors).toEqual(["degeneracy", "introduction-1"]);
  });

  const without = (path: string) => memoryFiles(Object.fromEntries(Object.entries(MINI).filter(([p]) => p !== path)));

  it("stops when a lens of its own is missing or cannot be read, and says who lists it and what to do", async () => {
    // Missing: nothing says whose the file was, but it stands where the sync keeps a day's lenses.
    const gone = await readCourseState(without(lensPath("Iliad A.2.1 - Overview")), MINI_FLAT);
    expect(() => planCourseFiles(gone, sameAsNow(gone, WORKSHEETS(), "c1"), options)).toThrow(
      'The lens file "Lens Edu/Lenses/Iliad A.2.1 - Overview.md" does not exist, and it stands in a folder where the sync keeps its lenses. The module "Lens Edu/modules/Iliad A.2 - Practice.md" lists it as "A.2.1 Overview".',
    );
    expect(() => planCourseFiles(gone, sameAsNow(gone, WORKSHEETS(), "c1"), options)).toThrow(
      /To do: restore the file from the folder's trash \(_trash\/\), where a deleted file goes; if it was moved or renamed, correct the link in the module to where it is now\. Deleting the entry from the module does not help/,
    );

    // A person's edit left the frontmatter of a synced lens unparseable.
    const broken = { ...MINI, [lensPath("Iliad B.3.2 - Degeneracy")]: MINI[lensPath("Iliad B.3.2 - Degeneracy")].replace('title: "B.3.2 Degeneracy"', "title: Degeneracy: part 2: more") };
    await expect(readCourseState(memoryFiles(broken), MINI_FLAT)).rejects.toThrow(
      /The lens file "Lens Edu\/Lenses\/Iliad B\.3\.2 - Degeneracy\.md" has frontmatter that is not valid YAML \(.+\)\. The module "Lens Edu\/modules\/Iliad B - Learning\.md" lists it as "B\.3\.2 Degeneracy"\..*To do: open the file and correct the lines between the two ---/,
    );
    const noKey = { ...MINI, [lensPath("Iliad B.3.2 - Degeneracy")]: MINI[lensPath("Iliad B.3.2 - Degeneracy")].replace("source_url: https://iliad-intensive.org/learning/slt/", 'synced_from:\n  source: "iliad"\n  url: "x"') };
    await expect(readCourseState(memoryFiles(noKey), MINI_FLAT)).rejects.toThrow("has no upstream_key and no source_url on iliad-intensive.org");
    const noId = { ...MINI, [lensPath("Iliad B.3.2 - Degeneracy")]: MINI[lensPath("Iliad B.3.2 - Degeneracy")].replace("id: 'b32'\n", "") };
    await expect(readCourseState(memoryFiles(noId), MINI_FLAT)).rejects.toThrow("has no id in its frontmatter");
    const sameId = { ...MINI, [lensPath("Iliad B.3.2 - Degeneracy")]: MINI[lensPath("Iliad B.3.2 - Degeneracy")].replace("id: 'b32'", "id: 'b31'") };
    await expect(readCourseState(memoryFiles(sameId), MINI_FLAT)).rejects.toThrow(/have the same id b31\. .*To do: /);
  });

  // Proof: a reading named "Iliad reading - ..." that was deleted, or got a bad frontmatter line, stopped the sync.
  it("knows a lens of its own by its frontmatter, never by its name", async () => {
    const named = "Lens Edu/Lenses/Iliad reading - Diffuse control.md";
    const withReading = (content: string | null) => {
      const files: Record<string, string> = {
        ...MINI,
        [modulePath("Iliad A.2 - Practice")]: `${MINI[modulePath("Iliad A.2 - Practice")]}\n\n# Lens: Diffuse control\nsource:: [[../Lenses/Iliad reading - Diffuse control]]\n`,
      };
      if (content !== null) files[named] = content;
      return memoryFiles(files);
    };
    const good = await readCourseState(withReading(MINI[lensPath("rsp")]), MINI_FOLDERS);
    expect(good.lenses).toHaveLength(6);
    expect(good.modules[1].blocks.flatMap((block) => block.reading ?? []).map((reading) => reading.path)).toContain(named);

    for (const content of [null, '---\nid: \'r1\'\ntitle: "Diffuse control\nbroken: [\n---\n\n#### Article\nsource:: [[../articles/rsp]]\n']) {
      const state = await readCourseState(withReading(content), MINI_FOLDERS);
      expect(state.warnings).toEqual([expect.stringMatching(/^The reading "Lens Edu\/Lenses\/Iliad reading - Diffuse control\.md" (does not exist|has frontmatter that is not valid YAML)/)]);
      const plan = planCourseFiles(state, sameAsNow(state, WORKSHEETS(), "c1"), { ...options, layout: MINI_FOLDERS });
      expect(plan.warnings).toEqual(state.warnings);
    }
  });

  it("stops when the course file or a module it lists is missing", async () => {
    await expect(readCourseState(without(modulePath("Iliad A.2 - Practice")), MINI_FLAT)).rejects.toThrow(
      'The course file "Lens Edu/courses/mini.md" lists the module "Lens Edu/modules/Iliad A.2 - Practice.md", which does not exist. To do: correct the "# Module:" link',
    );
    await expect(readCourseState(without(COURSE), MINI_FLAT)).rejects.toThrow('The course file "Lens Edu/courses/mini.md" does not exist.');
  });

  // 3 of the 1,903 lenses of Lens Edu had frontmatter strict YAML rejects when this was written.
  it("carries on past a reading it cannot read, with its address unknown, and says so", async () => {
    const colon = { ...MINI, [lensPath("cev")]: MINI[lensPath("cev")].replace('title: "cev"', "title: Debate: a primer: part 2") };
    const state = await readCourseState(memoryFiles(colon), MINI_FLAT);
    expect(state.lenses).toHaveLength(6);
    expect(state.modules[0].blocks.flatMap((block) => block.reading ?? [])).toEqual([
      { path: lensPath("cev"), url: null },
      { path: lensPath("corrigibility"), url: "https://example.org/corrigibility" },
    ]);
    expect(state.warnings).toEqual([
      expect.stringMatching(/^The reading "Lens Edu\/Lenses\/cev\.md" has frontmatter that is not valid YAML \(.+\)\. The module "Lens Edu\/modules\/Iliad A\.1 - Intro\.md" lists it as "CEV"\. The sync left its entry as it is and will not remove it\./),
    ]);

    const gone = await readCourseState(without(lensPath("rsp")), MINI_FOLDERS);
    expect(gone.modules[1].blocks.flatMap((block) => block.reading ?? [])).toEqual([{ path: lensPath("rsp"), url: null, missing: true }]);
    expect(gone.warnings).toEqual([expect.stringMatching(/^The reading "Lens Edu\/Lenses\/rsp\.md" does not exist\. .* lists it as "Responsible scaling"\. .*To do: correct the link in the module, or delete the entry\./)]);
    // The warnings reach the run's report, and the entry is never removed, whatever the source links to.
    const input = sameAsNow(gone, WORKSHEETS(), "c1");
    const overview = lensesOf(input, "practice")[0].planned.atoms[0];
    overview.parts = [{ kind: "text", markdown: "\\## Overview\n\nNo link any more." }];
    overview.links = [];
    const plan = planCourseFiles(gone, input, { ...options, layout: MINI_FOLDERS });
    expect(plan.warnings).toEqual(gone.warnings);
    expect(plan.removes).toEqual([]);
    expect(written(plan).get("Lens Edu/modules/Iliad/Iliad A.2 - Practice.md")).toContain("# Lens: Responsible scaling\nsource:: [[../../Lenses/rsp]]");
  });
});

describe("planCourseFiles", () => {
  it("adopts the hand import: each lens gains its pin, text and modules stay as they are", async () => {
    const files = memoryFiles();
    const state = await readCourseState(files, MINI_FLAT);
    const plan = planCourseFiles(state, sameAsNow(state, WORKSHEETS(), "c1"), options);

    expect(plan.changed).toBe(true);
    expect(plan.warnings).toEqual([]);
    expect(summary(plan)).toEqual([...state.lenses.map((lens) => `write ${lens.path}`), `write ${COURSE}`]);
    const files_ = written(plan);
    for (const lens of state.lenses) {
      const before = splitFrontmatter(lens.content);
      const after = splitFrontmatter(files_.get(lens.path)!);
      expect(after.body).toBe(before.body);
      expect(after.data).toMatchObject({ id: lens.id, title: lens.title, tldr: lens.tldr, authors: ["Ada L (Iliad)"], upstream_commit: "c1" });
    }
    expect(splitFrontmatter(files_.get(lensPath("Iliad A.1.2 - Targets"))!).data).toMatchObject({
      upstream_key: "intro#targets",
      upstream_fingerprint: expect.stringMatching(/^chars:/),
      synced_from: { source: "iliad", url: "https://iliad-intensive.org/alignment/intro/#targets" },
    });
    expect(files_.get(COURSE)).toBe(MINI[COURSE].replace('title: "Mini"\n', "title: \"Mini\"\nupstream_commit: 'c1'\n"));
  });

  it("writes nothing when nothing changed", async () => {
    const { state } = await synced();
    const plan = planCourseFiles(state, sameAsNow(state, WORKSHEETS(), "c1"), options);
    expect(plan).toEqual({ commit: "c1", changed: false, steps: [], removes: [], warnings: [] });
  });

  it("for a new commit that changed nothing here, writes the course file's commit and nothing else", async () => {
    const { state, input } = await synced();
    const plan = planCourseFiles(state, input, options);
    expect(plan.changed).toBe(true);
    expect(summary(plan)).toEqual([`write ${COURSE}`]);
    expect(written(plan).get(COURSE)).toContain("upstream_commit: 'c2'");
  });

  it("writes only the lens whose text changed, under the new commit", async () => {
    const { state, input } = await synced();
    const part = lensesOf(input, "slt")[1].planned.atoms[1].parts[0];
    if (part.kind === "text") part.markdown += "\n\nA sentence Iliad added.";
    lensesOf(input, "slt")[1].fingerprint = "f2";

    const plan = planCourseFiles(state, input, options);
    expect(summary(plan)).toEqual([`write ${lensPath("Iliad B.3.2 - Degeneracy")}`, `write ${COURSE}`]);
    const lens = written(plan).get(lensPath("Iliad B.3.2 - Degeneracy"))!;
    expect(lens).toContain("Continuous ones.\n\nA sentence Iliad added.\n");
    expect(splitFrontmatter(lens).data).toMatchObject({ id: "b32", upstream_commit: "c2", upstream_fingerprint: "f2", title: "B.3.2 Degeneracy" });
    expect(state.lenses[4].upstreamCommit).toBe("c1"); // B.3.1 keeps the commit that last changed it
  });

  it("takes new summaries, and keeps the old ones when it gets none", async () => {
    const { state, input } = await synced();
    lensesOf(input, "practice")[0].tldr = "A better summary.";
    const plan = planCourseFiles(state, input, options);
    expect(summary(plan)).toEqual([`write ${lensPath("Iliad A.2.1 - Overview")}`, `write ${COURSE}`]);
    expect(splitFrontmatter(written(plan).get(lensPath("Iliad A.2.1 - Overview"))!).data).toMatchObject({ tldr: "A better summary.", summary_for_tutor: "For the tutor: A.2.1 Overview." });
  });

  it("puts a card back when its text changed around it, and keeps the reading it points to", async () => {
    const { state, input } = await synced();
    const targets = lensesOf(input, "intro")[1].planned.atoms[0];
    targets.parts = [{ kind: "text", markdown: "\\## Targets\n\nRead one of these four texts.\n\nThen discuss in groups." }];
    targets.links = [];

    const plan = planCourseFiles(state, input, options);
    expect(plan.warnings).toEqual([expect.stringContaining('The lens "A.1.2 Targets" (Lens Edu/Lenses/Iliad A.1.2 - Targets.md) has a card whose place is gone from the text')]);
    expect(summary(plan)).toEqual([`write ${lensPath("Iliad A.1.2 - Targets")}`, `write ${COURSE}`]); // the module still lists both readings
    expect(splitFrontmatter(written(plan).get(lensPath("Iliad A.1.2 - Targets"))!).body).toBe(
      `\n#### Text\ncontent::\n\\## Targets\n\nRead one of these four texts.\n\nThen discuss in groups.\n\n${state.lenses[1].cards[0].block}\n\n\\### Debrief\n\nTen minutes.\n`,
    );
  });

  describe("a new lens", () => {
    it("gets an id, the next number of its worksheet and the import's file name, and its entry follows the lens before it", async () => {
      const { state, input } = await synced();
      lensesOf(input, "intro").push(fresh("intro", section("wrap-up", "Wrap-up: questions_and answers", "Bring questions.")));
      lensesOf(input, "slt").splice(1, 0, fresh("slt", section("preliminaries", "Preliminaries", "Notation.")));

      const plan = planCourseFiles(state, input, options);
      expect(summary(plan)).toEqual([
        `write ${lensPath("Iliad A.1.3 - Wrap-up - questions and answers")}`,
        `write ${lensPath("Iliad B.3.3 - Preliminaries")}`,
        `write ${modulePath("Iliad A.1 - Intro")}`,
        `write ${modulePath("Iliad B - Learning")}`,
        `write ${COURSE}`,
      ]);
      const files_ = written(plan);
      const lens = files_.get(lensPath("Iliad A.1.3 - Wrap-up - questions and answers"))!;
      expect(splitFrontmatter(lens).data).toMatchObject({ id: expect.stringMatching(/^new-/), title: "A.1.3 Wrap-up: questions and answers", upstream_key: "intro#wrap-up", upstream_commit: "c2" });
      expect(lens).not.toMatch(/^tldr:/m);
      expect(lens).toContain("#### Text\ncontent::\n\\## Wrap-up: questions_and answers\n\nBring questions.\n");

      // After A.1.2 and the two readings that belong to it.
      expect(files_.get(modulePath("Iliad A.1 - Intro"))).toBe(
        `${MINI[modulePath("Iliad A.1 - Intro")]}# Lens: A.1.3 Wrap-up: questions and answers\nsource:: [[../Lenses/Iliad A.1.3 - Wrap-up - questions and answers]]\n\n`,
      );
      // Numbered 3, placed second: the number is a label, the module holds the order.
      expect(listed(files_.get(modulePath("Iliad B - Learning"))!)).toEqual([
        "[B.2 Mysteries of Deep Learning]",
        "B.2.1 Overview",
        "[B.3 Singular Learning Theory]",
        "B.3.1 Introduction",
        "B.3.3 Preliminaries",
        "B.3.2 Degeneracy",
      ]);
    });

    it("is named after the exercise it starts at, not after a heading further down", async () => {
      const { state, input } = await synced();
      const exercise = { ...section("ex-leverage", "", ""), level: 5 as const, parts: [{ kind: "text" as const, markdown: ':::callout {title="Exercise" tone="amber"}\n**Exercise 2.3 (Leverage).** Show it.\n:::' }] };
      lensesOf(input, "slt").push({ ...fresh("slt", exercise), planned: { key: "slt#ex-leverage", pinned: null, atoms: [exercise, section("further-reading", "Further reading", "More.")] } });
      const titles = listed(written(planCourseFiles(state, input, options)).get(modulePath("Iliad B - Learning"))!);
      expect(titles.at(-1)).toBe("B.3.3 From Exercise 2.3");
    });

    // Seen in a scenario: "B.7.2 2. Chinchilla".
    it("gets a title without the section number of its heading", async () => {
      const { state, input } = await synced();
      const headings = ["2. Chinchilla", "2.1 Setup", "A. Proof of Pinsker's inequality", "(b) The other case", "IV. Results", "A definition", "2026 roadmap", "3D shapes"];
      for (const [i, heading] of headings.entries()) lensesOf(input, "slt").push(fresh("slt", section(`h${i}`, heading, "Text.")));
      const titles = planCourseFiles(state, input, options).steps.flatMap((step) => (step.do === "write" && step.path.includes("/Lenses/Iliad B.3.") ? [splitFrontmatter(step.content).data.title] : []));
      expect(titles).toEqual(["B.3.3 Chinchilla", "B.3.4 Setup", "B.3.5 Proof of Pinsker's inequality", "B.3.6 The other case", "B.3.7 Results", "B.3.8 A definition", "B.3.9 2026 roadmap", "B.3.10 3D shapes"]);
    });

    it("goes before the first lens of its worksheet when it is the new first", async () => {
      const { state, input } = await synced();
      lensesOf(input, "practice").unshift(fresh("practice", { ...section("", "", "Before the overview."), level: 0, parts: [{ kind: "text", markdown: "Before the overview." }] }));
      const module = written(planCourseFiles(state, input, options)).get(modulePath("Iliad A.2 - Practice"))!;
      expect(listed(module)).toEqual(["A.2.2 Overview", "A.2.1 Overview", "Responsible scaling"]);
      // The file had no newline at its end; what follows the new entry is as it was.
      expect(module.endsWith("# Lens: A.2.1 Overview\nsource:: [[../Lenses/Iliad A.2.1 - Overview]]\n\n# Lens: Responsible scaling\nsource:: [[../Lenses/rsp]]")).toBe(true);
    });

    it("never takes the path of a file that is there", async () => {
      // A lens of the hand import whose title has no number, in a file named like the next number.
      const named = {
        ...MINI,
        [lensPath("Iliad B.3.3 - Appendix")]: MINI[lensPath("Iliad B.3.2 - Degeneracy")].replace("id: 'b32'", "id: 'b3x'").replace("B.3.2 Degeneracy", "Appendix").replaceAll("Degeneracy", "Appendix").replace("Symmetries", "Tables"),
        [modulePath("Iliad B - Learning")]: `${MINI[modulePath("Iliad B - Learning")]}\n# Lens: Appendix\nsource:: [[../Lenses/Iliad B.3.3 - Appendix]]\n`,
      };
      const { state, input } = await synced(named);
      lensesOf(input, "slt").push(fresh("slt", section("appendix-2", "Appendix", "More tables.")));
      const plan = planCourseFiles(state, input, options);
      expect(summary(plan)).toEqual([`write ${lensPath("Iliad B.3.4 - Appendix")}`, `write ${modulePath("Iliad B - Learning")}`, `write ${COURSE}`]);
      expect(splitFrontmatter(written(plan).get(lensPath("Iliad B.3.4 - Appendix"))!).data.title).toBe("B.3.4 Appendix");
    });

    it("counts the number of a lens that is retired in the same run as used", async () => {
      const { state, input } = await synced();
      lensesOf(input, "slt").pop();
      lensesOf(input, "slt").push(fresh("slt", section("degeneracy-again", "Degeneracy", "Rewritten from scratch.")));
      const plan = planCourseFiles(state, input, options);
      expect(summary(plan)).toContain(`write ${lensPath("Iliad B.3.3 - Degeneracy")}`);
      expect(summary(plan)).toContain(`trash ${lensPath("Iliad B.3.2 - Degeneracy")}`);
    });
  });

  describe("a lens that is gone from the source", () => {
    it("leaves its module first and goes to the trash after", async () => {
      const { state, input } = await synced();
      lensesOf(input, "slt").pop();
      const plan = planCourseFiles(state, input, options);
      expect(summary(plan)).toEqual([`write ${modulePath("Iliad B - Learning")}`, `trash ${lensPath("Iliad B.3.2 - Degeneracy")}`, `write ${COURSE}`]);
      expect(written(plan).get(modulePath("Iliad B - Learning"))).toBe(MINI[modulePath("Iliad B - Learning")].replace("# Lens: B.3.2 Degeneracy\nsource:: [[../Lenses/Iliad B.3.2 - Degeneracy]]\n", ""));
    });

    it("takes its submodule heading with it when nothing is left under it", async () => {
      const { state, input } = await synced();
      input.worksheets = input.worksheets.filter(({ worksheet: w }) => w.slug !== "mysteries");
      const plan = planCourseFiles(state, input, options);
      expect(listed(written(plan).get(modulePath("Iliad B - Learning"))!)).toEqual(["[B.3 Singular Learning Theory]", "B.3.1 Introduction", "B.3.2 Degeneracy"]);
      expect(summary(plan)).toContain(`trash ${lensPath("Iliad B.2.1 - Overview")}`);
    });

    // Proof: one deploy with the links turned to plain text took 21 of 106 readings out of the modules for good.
    it("counts the readings and cards it would take away with the lenses, and needs approval past the limit", async () => {
      const { state, input } = await synced();
      lensesOf(input, "intro").pop();
      expect(() => planCourseFiles(state, input, options)).toThrow("The run for source commit c2 would remove 5 things; a run removes at most 3 without approval.");

      const plan = planCourseFiles(state, input, { ...options, approvedRetirement: "c2", retireReasons: new Map([["a12", "its section \"targets\" is gone from \"intro\""]]) });
      expect(plan.removes).toEqual([
        'Lens retired: "A.1.2 Targets" (Lens Edu/Lenses/Iliad A.1.2 - Targets.md). Why: its section "targets" is gone from "intro".',
        'Card dropped: "CEV" in the lens "A.1.2 Targets" (Lens Edu/Lenses/Iliad A.1.2 - Targets.md). Why: the lens is retired, and the heading the card stood under is gone from the source.',
        'Card dropped: "Corrigibility" in the lens "A.1.2 Targets" (Lens Edu/Lenses/Iliad A.1.2 - Targets.md). Why: the lens is retired, and the heading the card stood under is gone from the source.',
        `Reading taken out of the module "A.1 Intro": "CEV" (https://example.org/cev). Why: the source of A.1 no longer links to it. The reading's own files stay.`,
        `Reading taken out of the module "A.1 Intro": "Corrigibility" (https://example.org/corrigibility). Why: the source of A.1 no longer links to it. The reading's own files stay.`,
      ]);
      expect(plan.warnings).toEqual([]);
      expect(listed(written(plan).get(modulePath("Iliad A.1 - Intro"))!)).toEqual(["A.1.1 Opening"]);
      expect(summary(plan).filter((step) => step.startsWith("trash"))).toEqual([`trash ${lensPath("Iliad A.1.2 - Targets")}`]);
    });

    it("moves a card with its heading when the heading goes to another lens", async () => {
      const { state, input } = await synced();
      const [opening, targets] = lensesOf(input, "intro");
      opening.planned.atoms.push(...targets.planned.atoms);
      lensesOf(input, "intro").pop();
      const plan = planCourseFiles(state, input, options);
      expect(plan.warnings).toEqual([]);
      expect(written(plan).get(lensPath("Iliad A.1 - Intro"))).toContain("[Corrigibility](https://example.org/corrigibility).\n\n:::require_x_optional_lenses{x=1}\n::card[[../Lenses/cev|CEV]]");
    });

    // A source that loses worksheets for one deploy: the reviewer emptied four, and 46 lenses lost their ids for good.
    describe("in numbers", () => {
      const big = (): Record<string, string> => {
        const files: Record<string, string> = { ...MINI };
        const names = Array.from({ length: 4 }, (_, i) => `Iliad B.2.${i + 2} - Part ${i}`);
        for (const [i, name] of names.entries()) files[lensPath(name)] = MINI[lensPath("Iliad B.2.1 - Overview")].replace("id: 'b21'", `id: 'extra-${i}'`).replace("B.2.1 Overview", `B.2.${i + 2} Part ${i}`).replace("\\## Overview", `\\## Part ${i}`);
        files[modulePath("Iliad B - Learning")] = files[modulePath("Iliad B - Learning")].replace("\n# Submodule: B.3", `${names.map((name) => `\n# Lens: ${name.replace("Iliad ", "").replace(" - ", " ")}\nsource:: [[../Lenses/${name}]]\n`).join("")}\n# Submodule: B.3`);
        return files;
      };
      const emptied = async () => {
        const { files, state, input } = await synced(big());
        expect(state.lenses).toHaveLength(10);
        lensesOf(input, "mysteries").length = 0; // the worksheet is listed, and has no text
        return { files, state, input };
      };

      it(`stops a run that would remove more than ${MAX_RETIRED}, writes nothing, and names each removal, why, and the way to approve`, async () => {
        const { files, state, input } = await synced(big());
        lensesOf(input, "mysteries").splice(1, 4); // B.2.1 stays: the page is not empty
        const reasons = new Map([["extra-0", "its section \"part-0\" is gone from \"mysteries\""]]);
        const before = new Map(files.files);
        let message = "";
        try {
          await applyFilePlan(files, planCourseFiles(state, input, { ...options, retireReasons: reasons }));
        } catch (err) {
          message = (err as Error).message;
        }
        expect(message.split("\n")).toEqual([
          "The run for source commit c2 stopped and changed nothing: it needs a person's approval.",
          "The run for source commit c2 would remove 4 things; a run removes at most 3 without approval.",
          'At source commit c2: Lens retired: "B.2.2 Part 0" (Lens Edu/Lenses/Iliad B.2.2 - Part 0.md). Why: its section "part-0" is gone from "mysteries".',
          'At source commit c2: Lens retired: "B.2.3 Part 1" (Lens Edu/Lenses/Iliad B.2.3 - Part 1.md). Why: its text is not in the source any more.',
          'At source commit c2: Lens retired: "B.2.4 Part 2" (Lens Edu/Lenses/Iliad B.2.4 - Part 2.md). Why: its text is not in the source any more.',
          'At source commit c2: Lens retired: "B.2.5 Part 3" (Lens Edu/Lenses/Iliad B.2.5 - Part 3.md). Why: its text is not in the source any more.',
          "If source commit c2 lost this text by mistake, do nothing: when a later commit has the text again, the sync carries on by itself and nothing is lost.",
          "If Iliad removed this text for good, approve source commit c2: set ILIAD_SYNC_APPROVE_RETIREMENT=c2 and restart the lens-editor container. Learners lose their progress on the lenses it retires.",
        ]);
        expect(APPROVE_RETIREMENT_ENV).toBe("ILIAD_SYNC_APPROVE_RETIREMENT");
        expect(files.files).toEqual(before);
      });

      it("carries on with the same ids when the next deploy has the text again", async () => {
        const { state, input } = await emptied();
        expect(() => planCourseFiles(state, input, options)).toThrow("needs a person's approval");
        const restored = planCourseFiles(state, sameAsNow(state, WORKSHEETS(), "c3"), options);
        expect(summary(restored)).toEqual([`write ${COURSE}`]);
      });

      it("retires them when a person approved it for this source commit, and for no other", async () => {
        const { state, input } = await emptied();
        expect(() => planCourseFiles(state, input, { ...options, approvedRetirement: "c1" })).toThrow("needs a person's approval");
        const plan = planCourseFiles(state, input, { ...options, approvedRetirement: "c2" });
        expect(summary(plan).filter((step) => step.startsWith("trash"))).toHaveLength(5);
        expect(plan.removes).toHaveLength(5);
      });

      it("removes a few without asking, and lists them for the log", async () => {
        const { state, input } = await synced(big());
        lensesOf(input, "mysteries").splice(2, 3);
        const plan = planCourseFiles(state, input, options);
        expect(summary(plan).filter((step) => step.startsWith("trash"))).toHaveLength(3);
        expect(plan.removes).toEqual([
          'Lens retired: "B.2.3 Part 1" (Lens Edu/Lenses/Iliad B.2.3 - Part 1.md). Why: its text is not in the source any more.',
          'Lens retired: "B.2.4 Part 2" (Lens Edu/Lenses/Iliad B.2.4 - Part 2.md). Why: its text is not in the source any more.',
          'Lens retired: "B.2.5 Part 3" (Lens Edu/Lenses/Iliad B.2.5 - Part 3.md). Why: its text is not in the source any more.',
        ]);
      });
    });

    // Proof: 7 of the 27 worksheets have 3 lenses or fewer, so a count alone never stops their page going empty for one deploy.
    it("needs approval to retire every lens of a worksheet the schedule still lists, however few", async () => {
      const { state, input } = await synced();
      lensesOf(input, "practice").length = 0; // the page is empty, or all of it hidden
      expect(() => planCourseFiles(state, input, options)).toThrow(
        "The run for source commit c2 would retire every lens of the worksheet A.2 Practice (https://iliad-intensive.org/alignment/practice/), which the schedule still lists; a page that goes empty is far more often broken than edited.",
      );
      expect(planCourseFiles(state, input, { ...options, approvedRetirement: "c2" }).removes).toHaveLength(2); // the lens, and the reading it linked to
      // A worksheet the schedule no longer lists is a decision, not a broken page.
      input.worksheets = input.worksheets.filter(({ worksheet: w }) => w.slug !== "practice");
      expect(planCourseFiles(state, input, options).removes).toHaveLength(2);
    });

    it("refuses a plan that continues a lens the course does not have, or one lens twice", async () => {
      const { state, input } = await synced();
      const [first, second] = lensesOf(input, "slt");
      second.planned.pinned = first.planned.pinned;
      expect(() => planCourseFiles(state, input, options)).toThrow('continues the lens "B.3.1 Introduction" (b31) twice');
      second.planned.pinned = { key: "slt#x", id: "nope", fingerprint: "" };
      expect(() => planCourseFiles(state, input, options)).toThrow("continues the lens nope (slt#x), which no module of the course lists");
    });
  });

  describe("a reading", () => {
    const withoutLink = (input: SyncInput) => {
      const overview = lensesOf(input, "practice")[0].planned.atoms[0];
      overview.parts = [{ kind: "text", markdown: "\\## Overview\n\nLabs publish policies." }];
      overview.links = [];
    };

    it("leaves its module when the source of its day stops linking to it", async () => {
      const { state, input } = await synced();
      withoutLink(input);
      const plan = planCourseFiles(state, input, options);
      expect(summary(plan)).toEqual([`write ${lensPath("Iliad A.2.1 - Overview")}`, `write ${modulePath("Iliad A.2 - Practice")}`, `write ${COURSE}`]);
      expect(listed(written(plan).get(modulePath("Iliad A.2 - Practice"))!)).toEqual(["A.2.1 Overview"]);
      expect(plan.warnings).toEqual([]);
      expect(plan.removes).toEqual([
        `Reading taken out of the module "A.2 Practice": "Responsible scaling" (https://example.org/rsp). Why: the source of A.2 no longer links to it. The reading's own files stay.`,
      ]);
      // The reading lens and its article are shared: the sync does not touch them.
      expect(summary(plan).some((step) => step.includes("rsp"))).toBe(false);
    });

    it("stays when another worksheet of the day still links to it", async () => {
      const { state, input } = await synced();
      withoutLink(input);
      const more = worksheet("practice-2", input.worksheets[1].worksheet.cluster, "A.2", "Practice", "A.2.2");
      input.worksheets.splice(2, 0, { worksheet: more, lenses: [fresh("practice-2", section("policies", "Policies", "See the RSP.", [{ text: "RSP", url: "https://www.example.org/rsp/#top" }]))] });
      const plan = planCourseFiles(state, input, options);
      expect(listed(written(plan).get(modulePath("Iliad A.2 - Practice"))!)).toEqual(["A.2.1 Overview", "Responsible scaling", "A.2.2.1 Policies"]);
    });

    it("stays when the source never linked to it by that address", async () => {
      const cited = { ...MINI, [lensPath("Iliad A.2.1 - Overview")]: MINI[lensPath("Iliad A.2.1 - Overview")].replace("[RSP](https://example.org/rsp)", "RSP (Anthropic 2023)") };
      const { files, state, input } = await synced(cited); // the first run kept it,
      expect(files.files.get(modulePath("Iliad A.2 - Practice"))).toBe(MINI[modulePath("Iliad A.2 - Practice")]);
      expect(summary(planCourseFiles(state, input, options))).toEqual([`write ${COURSE}`]); // and so does the next
    });

    it("stays while a card points to it", async () => {
      const { state, input } = await synced();
      const targets = lensesOf(input, "intro")[1].planned.atoms[0];
      targets.parts = [{ kind: "text", markdown: "\\## Targets\n\nRead the texts below." }];
      targets.links = [];
      const plan = planCourseFiles(state, input, options);
      expect(written(plan).has(modulePath("Iliad A.1 - Intro"))).toBe(false);
    });

    // Iliad changes how a link is written, not what it links to: nothing is removed (21 of 106 readings were exposed).
    it("stays when its link changes form: another page of the same arXiv paper, a query on a forum post, a mirror", async () => {
      const article = (id: string, url: string) => ({ [lensPath(id)]: MINI[lensPath("rsp")].replaceAll("rsp", id), [`Lens Edu/articles/${id}.md`]: MINI["Lens Edu/articles/rsp.md"].replace("https://example.org/rsp", url) });
      const links = "[paper](https://arxiv.org/abs/2310.03789), [post](https://www.lesswrong.com/posts/RQpNHSiWaXTvDxt6R/coherent-decisions-imply-consistent-utilities), [talk](https://www.youtube.com/watch?v=gJQTFhkhwPA), [essay](http://www.example.org/essay/?utm_source=x#top)";
      const three = {
        ...MINI,
        ...article("paper", "https://arxiv.org/abs/2310.03789"),
        ...article("post", "https://www.lesswrong.com/posts/RQpNHSiWaXTvDxt6R/coherent-decisions-imply-consistent-utilities"),
        ...article("talk", "https://www.youtube.com/watch?v=gJQTFhkhwPA"),
        ...article("essay", "https://example.org/essay"),
        [lensPath("Iliad A.2.1 - Overview")]: MINI[lensPath("Iliad A.2.1 - Overview")].replace("[RSP](https://example.org/rsp)", `[RSP](https://example.org/rsp), ${links}`),
        [modulePath("Iliad A.2 - Practice")]: `${MINI[modulePath("Iliad A.2 - Practice")]}\n${["paper", "post", "talk", "essay"].map((id) => `\n# Lens: ${id}\nsource:: [[../Lenses/${id}]]\n`).join("")}`,
      };
      const { state, input } = await synced(three);
      const overview = lensesOf(input, "practice")[0].planned.atoms[0];
      const respelled = "[paper](https://arxiv.org/pdf/2310.03789v2), [post](https://www.lesswrong.com/posts/RQpNHSiWaXTvDxt6R/coherent-decisions-imply-consistent-utilities?commentId=abc), [talk](https://youtu.be/gJQTFhkhwPA?t=42), [essay](https://example.org/essay)";
      overview.parts = [{ kind: "text", markdown: `\\## Overview\n\nLabs publish policies such as the [RSP](https://example.org/rsp/), ${respelled}.` }];
      overview.links = [];

      const plan = planCourseFiles(state, input, options);
      expect(plan.warnings).toEqual([]);
      expect(plan.removes).toEqual([]);
      expect(summary(plan)).toEqual([`write ${lensPath("Iliad A.2.1 - Overview")}`, `write ${COURSE}`]);

      // A link that really goes takes its reading along.
      overview.parts = [{ kind: "text", markdown: `\\## Overview\n\n${respelled.replace("[paper](https://arxiv.org/pdf/2310.03789v2), ", "")}, [RSP](https://example.org/rsp).` }];
      expect(planCourseFiles(state, input, options).removes).toEqual([expect.stringContaining('"paper" (https://arxiv.org/abs/2310.03789). Why: the source of A.2 no longer links to it.')]);
    });

    it("knows two addresses as one work the way the importers do", () => {
      const same = (a: string, b: string) => sameWork(a).some((spelling) => sameWork(b).includes(spelling));
      expect(same("http://www.Example.org/Paper/?utm_source=x#section", "https://example.org/Paper")).toBe(true);
      expect(same("https://arxiv.org/abs/2310.03789", "https://arxiv.org/pdf/2310.03789v3")).toBe(true);
      expect(same("https://arxiv.org/abs/2310.03789", "https://arxiv.org/html/2310.03789")).toBe(true);
      expect(same("https://www.lesswrong.com/posts/RQpNHSiWaXTvDxt6R/coherent-decisions", "https://www.lesswrong.com/s/SgomvxZ3cJWy2SBCu/p/RQpNHSiWaXTvDxt6R")).toBe(true);
      expect(same("https://www.youtube.com/watch?v=gJQTFhkhwPA", "https://youtu.be/gJQTFhkhwPA")).toBe(true);
      // LessWrong and the Alignment Forum are one forum: a post has one id on both.
      expect(same("https://www.lesswrong.com/posts/AqsjZwxHNqH64C2b6/let-s-see", "https://www.alignmentforum.org/posts/AqsjZwxHNqH64C2b6/let-s-see-you-write")).toBe(true);
      expect(same("https://www.alignmentforum.org/w/corrigibility", "https://www.lesswrong.com/tag/Corrigibility")).toBe(true);
      expect(same("https://www.lesswrong.com/posts/AqsjZwxHNqH64C2b6/x", "https://www.alignmentforum.org/posts/BqsjZwxHNqH64C2b6/x")).toBe(false);
      expect(same("https://forum.effectivealtruism.org/posts/AqsjZwxHNqH64C2b6/x", "https://www.lesswrong.com/posts/AqsjZwxHNqH64C2b6/x")).toBe(false);
      expect(same("https://arxiv.org/abs/2310.03789", "https://arxiv.org/abs/2310.03790")).toBe(false);
      expect(same("https://www.youtube.com/watch?v=aaaaaaaaaaa", "https://www.youtube.com/watch?v=bbbbbbbbbbb")).toBe(false);
      expect(same("https://example.org/paper", "https://example.org/other")).toBe(false);
    });
  });

  describe("a worksheet new to the course", () => {
    const A = WORKSHEETS()[0].cluster;
    const B = WORKSHEETS()[2].cluster;
    const add = (input: SyncInput, at: number, sheet: Worksheet, ...titles: string[]) =>
      input.worksheets.splice(at, 0, { worksheet: sheet, lenses: titles.map((title) => fresh(sheet.slug, section(title.toLowerCase(), title, "Text."))) });

    it("joins its day when the day is there: after the day's last lens", async () => {
      const { state, input } = await synced();
      add(input, 4, worksheet("slt-2", B, "B.3", "SLT", "B.3.2"), "Exercises", "Solutions");
      const plan = planCourseFiles(state, input, options);
      expect(plan.warnings).toEqual([]);
      expect(listed(written(plan).get(modulePath("Iliad B - Learning"))!).slice(2)).toEqual([
        "[B.3 Singular Learning Theory]",
        "B.3.1 Introduction",
        "B.3.2 Degeneracy",
        "B.3.2.1 Exercises",
        "B.3.2.2 Solutions",
      ]);
      expect(written(plan).has(COURSE)).toBe(true);
      expect(written(plan).get(COURSE)).toBe(state.content.replace("'c1'", "'c2'"));
    });

    it("gets a submodule in a cluster that has one module: after the day before it", async () => {
      const { state, input } = await synced();
      add(input, 3, worksheet("dynamics", B, "B.2b", "Training Dynamics"), "Setup");
      add(input, 5, worksheet("attribution", B, "B.5", "Data Attribution"), "Influence");
      const plan = planCourseFiles(state, input, options);
      expect(listed(written(plan).get(modulePath("Iliad B - Learning"))!)).toEqual([
        "[B.2 Mysteries of Deep Learning]",
        "B.2.1 Overview",
        "[B.2b Training Dynamics]",
        "B.2b.1 Setup",
        "[B.3 Singular Learning Theory]",
        "B.3.1 Introduction",
        "B.3.2 Degeneracy",
        "[B.5 Data Attribution]",
        "B.5.1 Influence",
      ]);
      expect(written(plan).get(modulePath("Iliad B - Learning"))).toContain(
        "# Lens: B.3.2 Degeneracy\nsource:: [[../Lenses/Iliad B.3.2 - Degeneracy]]\n\n# Submodule: B.5 Data Attribution\n\n# Lens: B.5.1 Influence\nsource:: [[../Lenses/Iliad B.5.1 - Influence]]\n\n",
      );
      expect(summary(plan).filter((step) => step.includes("/modules/"))).toEqual([`write ${modulePath("Iliad B - Learning")}`]);
    });

    it("gets a submodule before the first day of its cluster's module when it is taught first", async () => {
      const { state, input } = await synced();
      add(input, 2, worksheet("basics", B, "B.1", "Basics"), "Basics");
      const module = written(planCourseFiles(state, input, options)).get(modulePath("Iliad B - Learning"))!;
      expect(listed(module).slice(0, 3)).toEqual(["[B.1 Basics]", "B.1.1 Basics", "[B.2 Mysteries of Deep Learning]"]);
      expect(module.startsWith('---\nid: \'m-b\'\nslug: iliad-learning\ntitle: "B — Learning"\n---\n\n# Submodule: B.1 Basics\n\n# Lens: B.1.1 Basics\n')).toBe(true);
    });

    it("gets a module of its own in a cluster that has a module per day, and a line in the course file", async () => {
      const { state, input } = await synced();
      add(input, 2, worksheet("reward", A, "A.3", "Reward: learning"), "Overview", "Exercises");
      const plan = planCourseFiles(state, input, options);
      expect(summary(plan)).toEqual([
        `write ${lensPath("Iliad A.3.1 - Overview")}`,
        `write ${lensPath("Iliad A.3.2 - Exercises")}`,
        `write ${modulePath("Iliad A.3 - Reward - learning")}`,
        `write ${COURSE}`,
      ]);
      expect(written(plan).get(modulePath("Iliad A.3 - Reward - learning"))).toBe(
        `---\nid: '${splitFrontmatter(written(plan).get(modulePath("Iliad A.3 - Reward - learning"))!).data.id}'\nslug: iliad-a-3-reward-learning\ntitle: "A.3 Reward: learning"\n---\n\n` +
          "# Lens: A.3.1 Overview\nsource:: [[../Lenses/Iliad A.3.1 - Overview]]\n\n# Lens: A.3.2 Exercises\nsource:: [[../Lenses/Iliad A.3.2 - Exercises]]\n\n",
      );
      expect(written(plan).get(COURSE)).toBe(
        state.content
          .replace("'c1'", "'c2'")
          .replace("|A.2 Practice]]\n", "|A.2 Practice]]\n# Module: [[../modules/Iliad A.3 - Reward - learning|A.3 Reward: learning]]\n"),
      );
      expect(plan.warnings).toEqual([
        'The source has a new day, "A.3 Reward: learning". The sync made the module "Lens Edu/modules/Iliad A.3 - Reward - learning.md" for it and added its "# Module:" line to the course file "Lens Edu/courses/mini.md". ' +
          'To do: open the course file, move that line if it stands in the wrong place, and add a "# Meeting:" line after it if the module needs a meeting of its own.',
      ]);
    });

    it("gets a module for its cluster when the cluster is new, after the last cluster's meeting, and later days join it", async () => {
      const { state, input } = await synced();
      const C = { id: "C", label: "C — Interpretability", urlSlug: "interpretability" };
      add(input, 4, worksheet("ml-engineering", C, "C.1", "ML Engineering"), "Setup");
      add(input, 5, worksheet("mech-interp", C, "C.2", "Mechanistic Interpretability"), "Content");
      const plan = planCourseFiles(state, input, options);
      const module = written(plan).get(modulePath("Iliad C - Interpretability"))!;
      expect(splitFrontmatter(module).data).toMatchObject({ slug: "iliad-interpretability", title: "C — Interpretability" });
      expect(listed(module)).toEqual(["[C.1 ML Engineering]", "C.1.1 Setup", "[C.2 Mechanistic Interpretability]", "C.2.1 Content"]);
      expect(written(plan).get(COURSE)).toBe(`${state.content.replace("'c1'", "'c2'")}\n\n# Module: [[../modules/Iliad C - Interpretability|C — Interpretability]]\n\n`);
      expect(plan.warnings).toHaveLength(1);
    });

    it("puts a cluster taught first before the course's first module", async () => {
      const { state, input } = await synced();
      add(input, 0, worksheet("prerequisites", { id: "0", label: "Foundations", urlSlug: "foundations" }, "0", "Prerequisites"), "Linear algebra");
      const plan = planCourseFiles(state, input, options);
      expect(summary(plan)).toContain(`write ${modulePath("Iliad 0 - Foundations")}`);
      expect(written(plan).get(COURSE)).toContain('title: "Mini"\nupstream_commit: \'c2\'\n---\n# Module: [[../modules/Iliad 0 - Foundations|Foundations]]\n\n# Module: [[../modules/Iliad A.1 - Intro|A.1 Intro]]\n');
    });
  });

  it("leaves alone a module of the course that lists no lens of its own", async () => {
    const shared = {
      ...MINI,
      [COURSE]: MINI[COURSE].replace("# Module: [[../modules/Iliad A.1", "# Module: [[../modules/How Lens works|How Lens works]]\n# Module: [[../modules/Iliad A.1"),
      [modulePath("How Lens works")]: '---\nid: \'m-shared\'\nslug: how-lens-works\ntitle: "How Lens works"\n---\n\n# Lens: Responsible scaling\nsource:: [[../Lenses/rsp]]\n',
    };
    const { state, input } = await synced(shared);
    const plan = planCourseFiles(state, input, { ...options, layout: MINI_FOLDERS });
    expect(summary(plan).filter((step) => step.includes("How Lens works"))).toEqual([]);
    expect(written(plan).get(COURSE)).toContain("# Module: [[../modules/How Lens works|How Lens works]]\n# Module: [[../modules/Iliad/Iliad A.1 - Intro|A.1 Intro]]\n");
  });

  describe("a section that Iliad moved", () => {
    it("to a worksheet of another day takes its lens along: same id and file, new place", async () => {
      const { state, input } = await synced();
      const [degeneracy] = lensesOf(input, "slt").splice(1, 1);
      lensesOf(input, "mysteries").push(degeneracy);

      const plan = planCourseFiles(state, input, { ...options, layout: MINI_FOLDERS });
      expect(plan.warnings).toEqual([]);
      expect(summary(plan)).toContain(`move ${lensPath("Iliad B.3.2 - Degeneracy")} -> Lens Edu/Lenses/Iliad/B.2 Mysteries/Iliad B.3.2 - Degeneracy.md`);
      expect(summary(plan).filter((step) => step.startsWith("trash"))).toEqual([]);
      expect(listed(written(plan).get("Lens Edu/modules/Iliad/Iliad B - Learning.md")!)).toEqual([
        "[B.2 Mysteries of Deep Learning]",
        "B.2.1 Overview",
        "B.3.2 Degeneracy",
        "[B.3 Singular Learning Theory]",
        "B.3.1 Introduction",
      ]);
    });

    it("to a worksheet with a new name leaves every lens and reading where it is", async () => {
      const { state, input } = await synced();
      for (const [slug, name] of [["slt", "singular-learning"], ["practice", "alignment-in-practice"]]) {
        const renamed = input.worksheets.find(({ worksheet: w }) => w.slug === slug)!;
        renamed.worksheet = worksheet(name, renamed.worksheet.cluster, renamed.worksheet.dayCode, renamed.worksheet.dayTitle);
      }
      const plan = planCourseFiles(state, input, options);
      // The lenses record their new page; the modules are as they were.
      expect(plan.warnings).toEqual([]);
      expect(summary(plan)).toEqual([
        `write ${lensPath("Iliad A.2.1 - Overview")}`,
        `write ${lensPath("Iliad B.3.1 - Introduction")}`,
        `write ${lensPath("Iliad B.3.2 - Degeneracy")}`,
        `write ${COURSE}`,
      ]);
      expect(written(plan).get(lensPath("Iliad B.3.2 - Degeneracy"))).toContain("source_url: https://iliad-intensive.org/learning/singular-learning/\n");
    });
  });

  it("warns when the source orders a worksheet's lenses another way than the module, and keeps the module's order", async () => {
    const { state, input } = await synced();
    lensesOf(input, "slt").reverse();
    const plan = planCourseFiles(state, input, options);
    expect(summary(plan)).toEqual([`write ${COURSE}`]);
    expect(plan.warnings).toEqual([expect.stringMatching(/^B\.3 SLT: the source now has these sections in another order than the module lists their lenses\. The sync kept the module's order\. To do: /)]);
  });

  describe("videos", () => {
    const withVideo = (input: SyncInput, youtubeId: string) =>
      lensesOf(input, "mysteries")[0].planned.atoms[0].parts.push({ kind: "video", youtubeId, title: "A lecture" }, { kind: "text", markdown: "After the lecture." });

    it("plays a video whose transcript another lens of the course already uses", async () => {
      const { state, input } = await synced();
      withVideo(input, "SzVmiN8BvCc");
      const plan = planCourseFiles(state, input, options);
      expect(plan.warnings).toEqual([]);
      expect(written(plan).get(lensPath("Iliad B.2.1 - Overview"))).toContain("Why does deep learning work?\n\n#### Video\nsource:: [[../video_transcripts/singular]]\n\n#### Text\ncontent::\nAfter the lecture.\n");
    });

    it("links to a video no lens of the course plays, and plays it once a person has added it to the lens", async () => {
      const { files, state, input } = await synced();
      withVideo(input, "newvideo123");
      const linked = planCourseFiles(state, input, options);
      expect(written(linked).get(lensPath("Iliad B.2.1 - Overview"))).toContain("[Video: A lecture](https://www.youtube.com/watch?v=newvideo123)");
      expect(linked.warnings).toEqual([expect.stringMatching(/links to the video .* and does not play it.*To make it play: import the video into Lens Edu, then add a "#### Video" segment/)]);
      await applyFilePlan(files, linked);

      // The person imports the video and does what the warning says.
      files.files.set("Lens Edu/video_transcripts/a-lecture.md", '---\ntitle: "A lecture"\nchannel: "Iliad"\nurl: "https://youtu.be/newvideo123"\n---\n\nWords.\n');
      files.files.set(lensPath("Iliad B.2.1 - Overview"), `${files.files.get(lensPath("Iliad B.2.1 - Overview"))}\n#### Video\nsource:: [[../video_transcripts/a-lecture]]\n`);
      const next = await readCourseState(files, MINI_FLAT);
      const again = sameAsNow(state, WORKSHEETS(), "c3");
      withVideo(again, "newvideo123");
      const played = planCourseFiles(next, again, options);
      expect(played.warnings).toEqual([]);
      expect(written(played).get(lensPath("Iliad B.2.1 - Overview"))).toContain("Why does deep learning work?\n\n#### Video\nsource:: [[../video_transcripts/a-lecture]]\n\n#### Text\ncontent::\nAfter the lecture.\n");
      expect(written(played).get(lensPath("Iliad B.2.1 - Overview"))).not.toContain("[Video:");
    });
  });

  describe("with the folder layout", () => {
    it("moves each file to its folder, then writes what links changed in, lenses before modules before the course file", async () => {
      const { files, state, input } = await synced();
      const plan = planCourseFiles(state, input, { ...options, layout: MINI_FOLDERS });
      const to = (day: string, name: string) => `Lens Edu/Lenses/Iliad/${day}/${name}.md`;
      expect(summary(plan)).toEqual([
        `move ${lensPath("Iliad A.1 - Intro")} -> ${to("A.1 Intro", "Iliad A.1 - Intro")}`,
        `move ${lensPath("Iliad A.1.2 - Targets")} -> ${to("A.1 Intro", "Iliad A.1.2 - Targets")}`,
        `write ${to("A.1 Intro", "Iliad A.1.2 - Targets")}`, // its cards link from a new place
        `move ${lensPath("Iliad A.2.1 - Overview")} -> ${to("A.2 Practice", "Iliad A.2.1 - Overview")}`,
        `move ${lensPath("Iliad B.2.1 - Overview")} -> ${to("B.2 Mysteries", "Iliad B.2.1 - Overview")}`,
        `move ${lensPath("Iliad B.3.1 - Introduction")} -> ${to("B.3 SLT", "Iliad B.3.1 - Introduction")}`,
        `write ${to("B.3 SLT", "Iliad B.3.1 - Introduction")}`, // and so does its video
        `move ${lensPath("Iliad B.3.2 - Degeneracy")} -> ${to("B.3 SLT", "Iliad B.3.2 - Degeneracy")}`,
        ...["Iliad A.1 - Intro", "Iliad A.2 - Practice", "Iliad B - Learning"].flatMap((name) => [
          `move ${modulePath(name)} -> Lens Edu/modules/Iliad/${name}.md`,
          `write Lens Edu/modules/Iliad/${name}.md`,
        ]),
        `write ${COURSE}`,
      ]);

      const files_ = written(plan);
      expect(files_.get(to("A.1 Intro", "Iliad A.1.2 - Targets"))).toContain("::card[[../../cev|CEV]]\n\n> Most important: section 3.\n\n::card[[../../corrigibility|Corrigibility]]");
      expect(files_.get(to("B.3 SLT", "Iliad B.3.1 - Introduction"))).toContain("source:: [[../../../video_transcripts/singular]]");
      expect(files_.get("Lens Edu/modules/Iliad/Iliad A.1 - Intro.md")).toContain(
        "# Lens: A.1.2 Targets\nsource:: [[../../Lenses/Iliad/A.1 Intro/Iliad A.1.2 - Targets]]\n\n# Lens: CEV\nsource:: [[../../Lenses/cev]]\noptional:: true\n",
      );
      expect(files_.get(COURSE)).toContain("# Module: [[../modules/Iliad/Iliad B - Learning|B — Learning]]\n\n# Meeting: Unit B");

      // Applied, every link leads to a file, the ids are the same, and the next run has nothing to do.
      await applyFilePlan(files, plan);
      const moved = await readCourseState(files, MINI_FOLDERS);
      expect(moved.lenses.map((lens) => lens.id)).toEqual(state.lenses.map((lens) => lens.id));
      for (const lens of moved.lenses) for (const target of linkTargets(lens.content, lens.path)) expect(files.files.has(target), target).toBe(true);
      expect(planCourseFiles(moved, sameAsNow(moved, WORKSHEETS(), "c2"), { ...options, layout: MINI_FOLDERS }).steps).toEqual([]);
      expect([...files.files.keys()].filter((path) => path.includes("/Lenses/Iliad ") || /modules\/Iliad [AB]/.test(path))).toEqual([]);
    });

    // Seen on a relay: it respells a card as a bare name when the reading is in the lens's own folder.
    it("carries a card over that names its reading without a path", async () => {
      const bare = { ...MINI, [lensPath("Iliad A.1.2 - Targets")]: MINI[lensPath("Iliad A.1.2 - Targets")].replace("::card[[../Lenses/cev|CEV]]", "::card[[cev|CEV]]") };
      const { state, input } = await synced(bare);
      const plan = planCourseFiles(state, input, { ...options, layout: MINI_FOLDERS });
      expect(written(plan).get("Lens Edu/Lenses/Iliad/A.1 Intro/Iliad A.1.2 - Targets.md")).toContain("::card[[../../cev|CEV]]\n\n> Most important: section 3.\n\n::card[[../../corrigibility|Corrigibility]]");
    });

    it("puts a new lens and a new module in their folders", async () => {
      const { state, input } = await synced();
      input.worksheets.splice(2, 0, { worksheet: worksheet("reward", WORKSHEETS()[0].cluster, "A.3", "Reward"), lenses: [fresh("reward", section("overview", "Overview", "Text."))] });
      const plan = planCourseFiles(state, input, { ...options, layout: MINI_FOLDERS });
      expect(written(plan).get("Lens Edu/modules/Iliad/Iliad A.3 - Reward.md")).toContain("# Lens: A.3.1 Overview\nsource:: [[../../Lenses/Iliad/A.3 Reward/Iliad A.3.1 - Overview]]\n");
      expect(written(plan).get(COURSE)).toContain("|A.2 Practice]]\n# Module: [[../modules/Iliad/Iliad A.3 - Reward|A.3 Reward]]\n# Meeting: Unit A");
    });
  });

  // Proof: two headings on the source site held "%%", and Lens then read the module's entries between them as a comment.
  describe("text of the source site in names", () => {
    it("never carries markup into a title, a file name, a folder name, a module or the course file", async () => {
      const { state, input } = await synced();
      const hostile = (text: string) => `${text} %% draft [[x|y]] {++ins++} source:: z\nnext line`;
      const C = { id: "C", label: hostile("C — New"), urlSlug: "new" };
      input.worksheets.push({
        worksheet: { ...worksheet("results", C, "C.1", hostile("Results")), contributors: [hostile("Ada")] },
        lenses: [fresh("results", section("so-far", hostile("# So far"), "Text.")), fresh("results", section("open", "Open problems %% end", "Text."))],
      });
      lensesOf(input, "slt").push(fresh("slt", section("more", "More %% later", "Text.")));

      const plan = planCourseFiles(state, input, { ...options, layout: MINI_FOLDERS });
      const made = [...written(plan)].filter(([path]) => !state.lenses.some((lens) => path.endsWith(lens.path.split("/").pop()!)));
      for (const [path, content] of made) {
        // What Lens strips from a whole file, or reads as structure on one line of a module or course file.
        expect(path).not.toMatch(/%%|\[\[|\]\]|\||\{\+\+|\n/);
        const head = splitFrontmatter(content).head + (path.includes("/Lenses/") ? "" : splitFrontmatter(content).body);
        expect(head, path).not.toMatch(/%%|\{\+\+|\+\+\}/);
      }
      const module = written(plan).get("Lens Edu/modules/Iliad/Iliad C - New % draft x y { ++ins++ } source - z next line.md")!;
      expect(module).toBe(
        `---\nid: '${splitFrontmatter(module).data.id}'\nslug: iliad-new\ntitle: "C — New % draft x y { ++ins++ } source: z next line"\n---\n\n` +
          "# Submodule: C.1 Results % draft x y { ++ins++ } source: z next line\n\n" +
          "# Lens: C.1.1 So far % draft x y { ++ins++ } source: z next line\nsource:: [[../../Lenses/Iliad/C.1 Results % draft x y { ++ins++ } source - z next line/Iliad C.1.1 - So far % draft x y { ++ins++ } source - z next line]]\n\n" +
          "# Lens: C.1.2 Open problems % end\nsource:: [[../../Lenses/Iliad/C.1 Results % draft x y { ++ins++ } source - z next line/Iliad C.1.2 - Open problems % end]]\n\n",
      );
      expect(written(plan).get(COURSE)).toContain("\n# Module: [[../modules/Iliad/Iliad C - New % draft x y { ++ins++ } source - z next line|C — New % draft x y { ++ins++ } source: z next line]]\n");
      expect(written(plan).get("Lens Edu/modules/Iliad/Iliad B - Learning.md")).toContain("# Lens: B.3.3 More % later\nsource:: [[../../Lenses/Iliad/B.3 SLT/Iliad B.3.3 - More % later]]\n");
      const lens = splitFrontmatter(written(plan).get("Lens Edu/Lenses/Iliad/C.1 Results % draft x y { ++ins++ } source - z next line/Iliad C.1.1 - So far % draft x y { ++ins++ } source - z next line.md")!);
      expect(lens.data).toMatchObject({ title: "C.1.1 So far % draft x y { ++ins++ } source: z next line", authors: ["Ada % draft x y { ++ins++ } source: z next line"] });
    });

    it("leaves the names of the hand import as they are", async () => {
      const { state, input } = await synced();
      const plan = planCourseFiles(state, input, { ...options, layout: MINI_FOLDERS });
      expect(summary(plan).filter((step) => step.startsWith("move")).map((step) => step.split("/").pop())).toEqual([
        "Iliad A.1 - Intro.md",
        "Iliad A.1.2 - Targets.md",
        "Iliad A.2.1 - Overview.md",
        "Iliad B.2.1 - Overview.md",
        "Iliad B.3.1 - Introduction.md",
        "Iliad B.3.2 - Degeneracy.md",
        "Iliad A.1 - Intro.md",
        "Iliad A.2 - Practice.md",
        "Iliad B - Learning.md",
      ]);
    });
  });

  // Other tools of the team write fields such as these onto lenses.
  it("keeps the frontmatter fields a person or another tool added to a synced lens", async () => {
    const { files, state } = await synced();
    const path = lensPath("Iliad B.3.2 - Degeneracy");
    files.files.set(path, files.files.get(path)!.replace("tldr:", "duration_minutes: 20\ntldr:").replace("\n---\n\n", "\ntags:\n  - slt\n  - hard\n---\n\n"));
    const edited = await readCourseState(files, MINI_FLAT);

    // Nothing changed in the source: the lens is left alone, fields and all.
    expect(summary(planCourseFiles(edited, sameAsNow(edited, WORKSHEETS(), "c2"), options))).toEqual([`write ${COURSE}`]);

    // The source changes the lens: its text is the source's, the person's fields stay where they were.
    const input = sameAsNow(edited, WORKSHEETS(), "c2");
    const part = lensesOf(input, "slt")[1].planned.atoms[0].parts[0];
    if (part.kind === "text") part.markdown += "\n\nA sentence Iliad added.";
    const lens = written(planCourseFiles(edited, input, options)).get(path)!;
    expect(lens).toContain("A sentence Iliad added.");
    expect(lens).toContain('title: "B.3.2 Degeneracy"\nduration_minutes: 20\ntldr: ');
    expect(lens).toContain("\ntags:\n  - slt\n  - hard\n---\n\n#### Text\n");
    expect(splitFrontmatter(lens).data).toMatchObject({ duration_minutes: 20, tags: ["slt", "hard"], upstream_commit: "c2", id: "b32" });
    expect(state.lenses[5].id).toBe("b32");
  });

  it("reports that it changed something exactly when it has a step to do", async () => {
    const { state, input } = await synced();
    expect(planCourseFiles(state, input, options)).toMatchObject({ changed: true, steps: [{ do: "write", path: COURSE }] });
    expect(planCourseFiles(state, sameAsNow(state, WORKSHEETS(), "c1"), options)).toMatchObject({ changed: false, steps: [] });
    // The same source commit, and a file a person edited: the run writes it back, and says it changed something.
    const edited = structuredClone(state);
    edited.lenses[0].content = edited.lenses[0].content.replace("Welcome to the day.", "Welcome, edited by hand.");
    const again = planCourseFiles(edited, sameAsNow(state, WORKSHEETS(), "c1"), options);
    expect(again).toMatchObject({ changed: true, steps: [{ do: "write", path: lensPath("Iliad A.1 - Intro") }] });
  });
});

describe("applyFilePlan", () => {
  const retireOne = async () => {
    const { files, state, input } = await synced();
    lensesOf(input, "slt").pop();
    const part = lensesOf(input, "slt")[0].planned.atoms[0].parts[0];
    if (part.kind === "text") part.markdown += "\n\nMore.";
    return { files, state, plan: planCourseFiles(state, input, options) };
  };
  const expected = {
    commit: "c2",
    changed: true,
    written: [lensPath("Iliad B.3.1 - Introduction"), modulePath("Iliad B - Learning"), COURSE],
    moved: [],
    retired: [lensPath("Iliad B.3.2 - Degeneracy")],
    warnings: [],
  };

  it("does the steps in order and reports them", async () => {
    const { files, plan } = await retireOne();
    expect(await applyFilePlan(files, plan)).toEqual(expected);
    expect(files.calls).toEqual([
      `write ${lensPath("Iliad B.3.1 - Introduction")}`,
      `write ${modulePath("Iliad B - Learning")}`,
      `trash ${lensPath("Iliad B.3.2 - Degeneracy")}`,
      `write ${COURSE}`,
    ]);
    expect(files.files.has("Lens Edu/_trash/Lenses/Iliad B.3.2 - Degeneracy.md")).toBe(true);
    expect((await readCourseState(files, MINI_FLAT)).commit).toBe("c2");
  });

  it("in a dry run touches nothing and reports the same", async () => {
    const { files, plan } = await retireOne();
    const before = new Map(files.files);
    expect(await applyFilePlan(files, plan, { dryRun: true })).toEqual(expected);
    expect(files.calls).toEqual([]);
    expect(files.files).toEqual(before);
  });

  it("stops at a failed write, leaving the old commit so that the next run does it all again", async () => {
    const { files, state, plan } = await retireOne();
    const write = files.write;
    files.write = async (path, content) => {
      if (path.includes("/modules/")) throw new Error("relay is down");
      await write(path, content);
    };
    await expect(applyFilePlan(files, plan)).rejects.toThrow(/stopped at step 2 of 4, writing "Lens Edu\/modules\/Iliad B - Learning\.md": relay is down/);
    expect(files.calls).toEqual([`write ${lensPath("Iliad B.3.1 - Introduction")}`]);

    files.write = write;
    const again = await readCourseState(files, MINI_FLAT);
    expect(again.commit).toBe("c1");
    // The lens written before the stop is not written again; the rest is.
    const input = sameAsNow(state, WORKSHEETS(), "c2");
    lensesOf(input, "slt").pop();
    const part = lensesOf(input, "slt")[0].planned.atoms[0].parts[0];
    if (part.kind === "text") part.markdown += "\n\nMore.";
    expect(summary(planCourseFiles(again, input, options))).toEqual([`write ${modulePath("Iliad B - Learning")}`, `trash ${lensPath("Iliad B.3.2 - Degeneracy")}`, `write ${COURSE}`]);
  });

  // Proof: a meeting added to the course file and a reading added to a module during a run were overwritten.
  describe("when a person saves a file while the run is under way", () => {
    const meeting = "# Meeting: Unit B\n\n# Meeting: Extra review session (added by a person)";
    const reading = "\n# Lens: A reading a person just added\nsource:: [[../Lenses/cev]]\noptional:: true\n";
    /** The person saves while the sync writes its first file. */
    const racing = (files: ReturnType<typeof memoryFiles>, edit: () => void) => {
      const write = files.write;
      let done = false;
      files.write = async (path, content) => {
        if (!done) edit();
        done = true;
        await write(path, content);
      };
    };

    it("stops before touching that file, so the edit is kept, and the next run plans from it", async () => {
      const { files, plan } = await retireOne();
      racing(files, () => files.files.set(modulePath("Iliad B - Learning"), files.files.get(modulePath("Iliad B - Learning"))! + reading));
      await expect(applyFilePlan(files, plan)).rejects.toThrow(
        '"Lens Edu/modules/Iliad B - Learning.md" was changed while this run was under way, by a person or another tool. The sync stopped at step 2 of 4, before touching the file, so that the change is kept. ' +
          "Nothing to do: the course file keeps the old source commit, so the next run starts again from the files as they are then.",
      );
      expect(files.calls).toEqual([`write ${lensPath("Iliad B.3.1 - Introduction")}`]);
      expect(files.files.get(modulePath("Iliad B - Learning"))).toContain("A reading a person just added");
      expect(files.files.has(lensPath("Iliad B.3.2 - Degeneracy"))).toBe(true); // not trashed: its module still lists it

      // The next run: the module loses the retired lens and keeps the person's reading.
      const again = await readCourseState(files, MINI_FLAT);
      expect(again.commit).toBe("c1");
      const input = sameAsNow(again, WORKSHEETS(), "c2");
      lensesOf(input, "slt").pop();
      await applyFilePlan(files, planCourseFiles(again, input, options));
      const module = files.files.get(modulePath("Iliad B - Learning"))!;
      expect(listed(module)).toEqual(["[B.2 Mysteries of Deep Learning]", "B.2.1 Overview", "[B.3 Singular Learning Theory]", "B.3.1 Introduction", "A reading a person just added"]);
      expect((await readCourseState(files, MINI_FLAT)).commit).toBe("c2");
    });

    it("stops before the course file too, and before a lens it would trash or move", async () => {
      const course = await retireOne();
      racing(course.files, () => course.files.files.set(COURSE, course.files.files.get(COURSE)!.replace("# Meeting: Unit B", meeting)));
      await expect(applyFilePlan(course.files, course.plan)).rejects.toThrow(/courses\/mini\.md" was changed while this run was under way.*stopped at step 4 of 4/);
      expect(course.files.files.get(COURSE)).toContain("Extra review session");
      expect(course.files.files.get(COURSE)).toContain("upstream_commit: 'c1'");

      const trashed = await retireOne();
      racing(trashed.files, () => trashed.files.files.set(lensPath("Iliad B.3.2 - Degeneracy"), trashed.files.files.get(lensPath("Iliad B.3.2 - Degeneracy"))!.replace("A definition.", "A definition, improved by hand.")));
      await expect(applyFilePlan(trashed.files, trashed.plan)).rejects.toThrow(/Iliad B\.3\.2 - Degeneracy\.md" was changed while this run was under way.*stopped at step 3 of 4/);
      expect(trashed.files.files.has(lensPath("Iliad B.3.2 - Degeneracy"))).toBe(true);

      const moved = await synced();
      const plan = planCourseFiles(moved.state, moved.input, { ...options, layout: MINI_FOLDERS });
      moved.files.files.delete(lensPath("Iliad A.2.1 - Overview")); // a person renamed it away
      await expect(applyFilePlan(moved.files, plan)).rejects.toThrow(/Iliad A\.2\.1 - Overview\.md" was moved or deleted while this run was under way/);
    });

    it("reads each file that was there once, just before its first step, and none in a dry run", async () => {
      const { files, state, input } = await synced();
      lensesOf(input, "intro").push(fresh("intro", section("wrap-up", "Wrap-up", "Bring questions.")));
      const plan = planCourseFiles(state, input, { ...options, layout: MINI_FOLDERS });
      const reads: string[] = [];
      const read = files.read;
      files.read = (path) => (reads.push(path), read(path));
      await applyFilePlan(files, plan, { dryRun: true });
      expect(reads).toEqual([]);
      await applyFilePlan(files, plan);
      // 6 lenses, 3 modules and the course file were there; the new lens was not.
      expect(reads).toEqual([...state.lenses.map((lens) => lens.path), ...state.modules.map((module) => module.path), COURSE]);
    });

    it("does not take the relay's respelling of links to a moved file for an edit", async () => {
      const { files, state, input } = await synced();
      // As the relay does: a move rewrites the links to the file in every file that has one, in its own spelling.
      const move = files.move;
      files.move = async (from, to) => {
        await move(from, to);
        for (const [path, content] of files.files) {
          const dir = path.slice(0, path.lastIndexOf("/"));
          const old = from.replace(/\.md$/, "");
          const up = dir.split("/").length - 1;
          const spelling = `${"../".repeat(up)}${old.slice("Lens Edu/".length)}`;
          const respelled = `${"../".repeat(up)}${to.slice("Lens Edu/".length)}`; // with the extension, unlike the sync's own links
          if (content.includes(`[[${spelling}`)) files.files.set(path, content.replaceAll(`[[${spelling}`, `[[${respelled.replace(/\.md$/, ".md")}`));
        }
      };
      const report = await applyFilePlan(files, planCourseFiles(state, input, { ...options, layout: MINI_FOLDERS }));
      expect(report.moved).toHaveLength(9);
      const after = await readCourseState(files, MINI_FOLDERS);
      expect(after.commit).toBe("c2");
      expect(planCourseFiles(after, sameAsNow(after, WORKSHEETS(), "c2"), { ...options, layout: MINI_FOLDERS }).steps).toEqual([]);
    });
  });

  it("goes on when a retired lens cannot be trashed, and says which", async () => {
    const { files, plan } = await retireOne();
    files.trash = async () => {
      throw new Error("another file links to it");
    };
    const report = await applyFilePlan(files, plan);
    expect(report.written).toEqual(expected.written);
    expect(report.warnings).toEqual([
      'The lens "Lens Edu/Lenses/Iliad B.3.2 - Degeneracy.md" is gone from the source, and no module of the course lists it any more, so learners do not see it. Moving it to the trash failed (another file links to it). ' +
        "To do: delete the file in the Lens Editor; if another file still links to it, correct that link first. Until then the file does no harm, but it stays in search.",
    ]);
    expect((await readCourseState(files, MINI_FLAT)).commit).toBe("c2");
  });
});
