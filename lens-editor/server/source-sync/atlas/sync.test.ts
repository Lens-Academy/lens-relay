import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DocsDocument } from "../google-docs/docs-types";
import { splitFrontmatter } from "../iliad/module-file";
import { CHAPTERS, CONFIG, DOC1, DOC2, emptyFiles, link, memoryDocs, wordsOf, type ChapterSpec } from "./__fixtures__/course";
import { Gone } from "../charts/fetch";
import { configHash, parseAtlasCourses } from "./config";
import type { AtlasDocs } from "./snapshot";
import { logAtlasReport, startAtlasSync, syncAtlasCourse, type AtlasMemory, type AtlasSyncDeps } from "./sync";

const COURSE = CONFIG.course;
const LENSES = "Lens Edu/Lenses/Atlas Test";
const ARTICLES = "Lens Edu/articles/Atlas Test";
const MODULES = "Lens Edu/modules/Atlas Test";
const T0 = new Date("2026-11-13T10:00:00Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

/** A course that a first run has written, and what to run it again with. */
async function course(specs: ChapterSpec[] = CHAPTERS(), extra: Partial<AtlasSyncDeps> = {}) {
  const files = emptyFiles();
  const docs = memoryDocs(specs);
  let n = 0;
  let now = T0;
  const deps: AtlasSyncDeps = { files, docs, newId: () => `id-${++n}`, now: () => now, ...extra };
  const run = (options: Parameters<typeof syncAtlasCourse>[2] = {}, at?: Date) => {
    if (at) now = at;
    return syncAtlasCourse(CONFIG, deps, options);
  };
  const first = await run();
  files.calls.length = 0;
  docs.images.length = 0;
  return { files, docs, deps, specs, run, first, data: (path: string) => splitFrontmatter(files.files.get(path) ?? "").data };
}

const lensOf = (chapter: string, section: string) => `${LENSES}/Atlas - ${chapter} - ${section}.md`;
const articleOf = (chapter: string, section: string) => `${ARTICLES}/Atlas - ${chapter} - ${section}.md`;

describe("syncAtlasCourse: the first run", () => {
  it("writes the course, a module per chapter, and a lens and an article per section", async () => {
    const { first, files, data } = await course();
    expect(first.changed).toBe(true);
    expect(first.skipped).toEqual([]);
    expect(first.warnings).toEqual([]);
    const paths = [...files.files.keys()];
    expect(paths.filter((p) => p.startsWith(LENSES))).toHaveLength(8);
    expect(paths.filter((p) => p.startsWith(ARTICLES))).toHaveLength(8);
    // Articles, then lenses, then modules, then the course file last.
    expect(first.written.at(-1)).toBe(COURSE);
    expect(first.written.findIndex((p) => p.startsWith(LENSES))).toBeGreaterThan(first.written.findLastIndex((p) => p.startsWith(ARTICLES)));
    expect(first.written.findIndex((p) => p.startsWith(MODULES))).toBeGreaterThan(first.written.findLastIndex((p) => p.startsWith(LENSES)));

    expect(files.files.get(COURSE)).toBe(
      [
        "---",
        "id: id-1",
        "slug: atlas-test",
        'title: "Atlas Test"',
        'partner-name: "AI Safety Atlas"',
        "synced_from:",
        "  source: atlas",
        `  url: "${link(DOC1)}"`,
        "upstream_revisions:",
        `  "${DOC1}": "${(data(COURSE).upstream_revisions as Record<string, string>)[DOC1]}"`,
        `  "${DOC2}": "${(data(COURSE).upstream_revisions as Record<string, string>)[DOC2]}"`,
        "sync_rules: 1",
        `sync_config: "${configHash(CONFIG)}"`,
        "---",
        `# Module: [[../../modules/Atlas Test/Chapter 1 - Capabilities|Chapter 1: Capabilities]]`,
        `# Module: [[../../modules/Atlas Test/Chapter 2 - Risks|Chapter 2: Risks]]`,
        "",
      ].join("\n"),
    );

    expect(files.files.get(`${MODULES}/Chapter 2 - Risks.md`)).toBe(
      [
        "---",
        "id: id-11",
        "slug: atlas-risks",
        'title: "Chapter 2: Risks"',
        "synced_from:",
        "  source: atlas",
        `  url: "${link(DOC2)}"`,
        "---",
        "",
        "# Lens: Risk Decomposition",
        "source:: [[../../Lenses/Atlas Test/Atlas - Risks - Risk Decomposition]]",
        "",
        "# Lens: Misuse",
        "source:: [[../../Lenses/Atlas Test/Atlas - Risks - Misuse]]",
        "",
      ].join("\n"),
    );
    expect(files.files.get(`${MODULES}/Chapter 1 - Capabilities.md`)).toContain(
      "# Lens: Appendix: Expert Surveys\noptional:: true\nsource:: [[../../Lenses/Atlas Test/Atlas - Capabilities - Appendix - Expert Surveys]]\n",
    );

    const lens = files.files.get(lensOf("Capabilities", "Introduction"))!;
    expect(lens).toMatch(/^---\nid: id-2\ntitle: "Introduction"\ntldr: "Why capabilities matter."\nsummary_for_tutor: "Why capabilities matter."\nreading_minutes: 1\nsynced_from:\n {2}source: atlas\n/);
    expect(lens).toContain('upstream_key: "capabilities#introduction"\nupstream_heading: "h.intro"\nupstream_fingerprint: "');
    expect(lens.split("---\n")[2]).toBe("\n#### Article\nrender-as-non-article-text:: true\nsource:: [[../../articles/Atlas Test/Atlas - Capabilities - Introduction|Introduction]]\n");

    const article = files.files.get(articleOf("Capabilities", "Introduction"))!;
    expect(splitFrontmatter(article).data).toEqual({
      title: "Introduction",
      author: ["Markov Grey", "Charbel-Raphaël Segerie"],
      source_url: "https://atlas.test/chapters/v1/capabilities/introduction/",
      published: "2026-11-13",
      tags: ["source-sync"],
      synced_from: { source: "atlas", url: link(DOC1) },
    });
    // Its image was hosted under the chapter's stem.
    expect(article).toContain("(attachments/atlas-capabilities.png)");
    // The chapter's first section ends with its thanks, worded as the Atlas's site words them.
    expect(article.trimEnd().split("\n\n").at(-1)).toBe("We thank Jeanne Salle, Charles Martinet and Léo Dana for their valuable feedback and contributions.");
    expect(files.files.get(articleOf("Capabilities", "Scaling"))).not.toContain("We thank");
    // A chapter with authors of its own credits them.
    expect(data(articleOf("Risks", "Misuse")).author).toEqual(["Markov Grey"]);
  });

  it("only reports in a dry run", async () => {
    const files = emptyFiles();
    const report = await syncAtlasCourse(CONFIG, { files, docs: memoryDocs(CHAPTERS()) }, { dryRun: true });
    expect(report.written).toHaveLength(19);
    expect(files.files.size).toBe(0);
  });
});

describe("syncAtlasCourse: later runs", () => {
  it("writes nothing and hosts no image when the Docs are as the course file records", async () => {
    const { run, files, docs, first } = await course();
    const again = await run({}, minutes(10));
    expect(again).toMatchObject({ upToDate: true, changed: false, written: [], revision: first.revision });
    expect(files.calls).toEqual([]);
    expect(docs.images).toEqual([]);
  });

  it("rewrites only the article of an edited section, and its lens too when its description changes", async () => {
    const { run, files, specs } = await course();
    const before = new Map(files.files);
    specs[0].sections[1].words[10] = "edited";
    const typo = await run({}, minutes(10));
    expect(typo.written).toEqual([articleOf("Capabilities", "Foundation Models"), COURSE]);
    expect(files.files.get(articleOf("Capabilities", "Foundation Models"))).toContain("edited");
    // The other chapter's articles were not converted again, and no image was hosted for it.
    expect(files.files.get(articleOf("Risks", "Misuse"))).toBe(before.get(articleOf("Risks", "Misuse")));

    specs[0].sections[1].description = "Big models.";
    const described = await run({}, minutes(20));
    expect(described.written).toEqual([articleOf("Capabilities", "Foundation Models"), lensOf("Capabilities", "Foundation Models"), COURSE]);
    expect(files.files.get(lensOf("Capabilities", "Foundation Models"))).toContain('tldr: "Big models."');
  });

  it("brings a change of credits to every article at the next run", async () => {
    const { files, deps, data } = await course();
    const config = { ...CONFIG, authors: ["Markov Grey"], chapters: [{ ...CONFIG.chapters[0], acknowledgements: ["Jeanne Salle"] }, CONFIG.chapters[1]] };
    const report = await syncAtlasCourse(config, { ...deps, now: () => minutes(10) });
    expect(report.upToDate).toBe(false);
    expect(report.written).toHaveLength(7);
    expect(data(articleOf("Capabilities", "Scaling")).author).toEqual(["Markov Grey"]);
    expect(files.files.get(articleOf("Capabilities", "Introduction"))).toContain("We thank Jeanne Salle for their valuable feedback and contributions.");
    expect(await syncAtlasCourse(config, { ...deps, now: () => minutes(20) })).toMatchObject({ upToDate: true });
  });

  it("keeps a renamed section's id and moves its files", async () => {
    const { run, files, specs, data } = await course();
    const id = data(lensOf("Risks", "Misuse")).id;
    specs[1].sections[1].title = "Misuse Risks";
    const report = await run({}, minutes(10));
    expect(report.moved).toEqual([
      { from: articleOf("Risks", "Misuse"), to: articleOf("Risks", "Misuse Risks") },
      { from: lensOf("Risks", "Misuse"), to: lensOf("Risks", "Misuse Risks") },
    ]);
    expect(report.retired).toEqual([]);
    expect(files.files.has(lensOf("Risks", "Misuse"))).toBe(false);
    expect(data(lensOf("Risks", "Misuse Risks"))).toMatchObject({ id, title: "Misuse Risks", upstream_key: "risks#misuse-risks" });
    expect(files.files.get(`${MODULES}/Chapter 2 - Risks.md`)).toContain("# Lens: Misuse Risks\nsource:: [[../../Lenses/Atlas Test/Atlas - Risks - Misuse Risks]]\n");
    expect(data(articleOf("Risks", "Misuse Risks"))).toMatchObject({ title: "Misuse Risks", source_url: "https://atlas.test/chapters/v1/risks/misuse-risks/", published: "2026-11-13" });
  });

  it("keeps a removed section for an hour, then retires it", async () => {
    const { run, files, specs, data } = await course();
    const gone = specs[0].sections.splice(2, 1)[0];
    const lens = lensOf("Capabilities", gone.title);

    const missed = await run({}, minutes(5));
    expect(missed.retired).toEqual([]);
    expect(missed.warnings).toEqual([expect.stringMatching(/^"Scaling" \(.*\) is gone from Chapter 1; it stays until a run from 2026-11-13 11:05 UTC still misses it/)]);
    expect(data(COURSE).missing_since).toEqual({ [data(lens).id as string]: minutes(5).toISOString() });
    expect(files.files.get(`${MODULES}/Chapter 1 - Capabilities.md`)).toContain("# Lens: Scaling\n");

    // Within the hour nothing has changed, so the run ends at once.
    expect(await run({}, minutes(40))).toMatchObject({ upToDate: true });

    const due = await run({}, minutes(66));
    expect(due.retired).toEqual([lens, articleOf("Capabilities", gone.title)]);
    expect(due.warnings[0]).toMatch(/^Lens retired: "Scaling" .*: its section is gone from the Doc since 2026-11-13 10:05 UTC\.$/);
    expect(files.files.has(lens)).toBe(false);
    expect(files.files.has(lens.replace("Lens Edu/", "Lens Edu/_trash/"))).toBe(true);
    expect(files.files.get(`${MODULES}/Chapter 1 - Capabilities.md`)).not.toContain("Scaling");
    expect(data(COURSE).missing_since).toBeUndefined();
    expect(await run({}, minutes(80))).toMatchObject({ upToDate: true });
  });

  it("comes back with its id when a missing section is back within the hour", async () => {
    const { run, specs, data } = await course();
    const id = data(lensOf("Capabilities", "Scaling")).id;
    const [gone] = specs[0].sections.splice(2, 1);
    await run({}, minutes(5));
    specs[0].sections.splice(2, 0, gone);
    const back = await run({}, minutes(30));
    expect(back.retired).toEqual([]);
    expect(data(lensOf("Capabilities", "Scaling")).id).toBe(id);
    expect(data(COURSE).missing_since).toBeUndefined();
  });

  it("retires at most 3 in a run, or every lens of a chapter, without a person's approval", async () => {
    const { run, specs, files } = await course();
    specs[0].sections.splice(1, 4);
    await run({}, minutes(5));
    const held = await run({}, minutes(70));
    expect(held.retired).toEqual([]);
    expect(held.warnings.join("\n")).toContain(`4 lens(es) are gone from the Docs for over an hour, and the sync retires at most 3 at once by itself, so it retired none`);
    const approval = /ATLAS_SYNC_APPROVE_RETIREMENT=([0-9a-f]{12})/.exec(held.warnings.join("\n"))![1];
    // The approval names the lenses: an edit elsewhere in the Docs leaves it standing.
    specs[1].sections[0].words[0] = "edited";
    // A held retirement is reported on every run until a person acts.
    expect((await run({}, minutes(80))).upToDate).toBe(false);

    const approved = await run({ approvedRetirement: approval }, minutes(90));
    expect(approved.retired).toHaveLength(8);
    expect([...files.files.keys()].filter((p) => p.startsWith(LENSES))).toHaveLength(4);

    // A whole chapter, though only two lenses.
    specs[1].sections = [];
    await run({}, minutes(100));
    const chapter = await run({}, minutes(170));
    expect(chapter.retired).toEqual([]);
    expect(chapter.warnings.join("\n")).toContain("the sync retires no whole chapter by itself");
    expect(files.files.get(`${MODULES}/Chapter 2 - Risks.md`)).toContain("# Lens: Misuse\n");
  });

  it("stops before a file that a person saved during the run, and records nothing", async () => {
    const { files, deps, specs, data } = await course();
    const revisions = data(COURSE).upstream_revisions;
    const path = articleOf("Capabilities", "Foundation Models");
    specs[0].sections[1].words[3] = "changed";
    // The person saves the article after the run read it: before the run reads it again to write it.
    let reads = 0;
    const read = files.read;
    files.read = async (file) => {
      if (file === path && ++reads === 2) files.files.set(path, `${files.files.get(path)}\nA person's note.\n`);
      return read(file);
    };
    await expect(syncAtlasCourse(CONFIG, { ...deps, now: () => minutes(10) })).rejects.toThrow(`"${path}" was changed while this run was under way`);
    expect(files.files.get(path)).toContain("A person's note.");
    expect(data(COURSE).upstream_revisions).toEqual(revisions);
  });

  it("stops, rather than start a second course, when the course file was moved or deleted", async () => {
    const { files, deps } = await course();
    files.files.set("Lens Edu/courses/moved.md", files.files.get(COURSE)!);
    files.files.delete(COURSE);
    files.calls.length = 0;
    await expect(syncAtlasCourse(CONFIG, { ...deps, now: () => minutes(10) })).rejects.toThrow(
      `The course file "${COURSE}" is missing or was moved, but the course's files are there ("${MODULES}/Chapter 1 - Capabilities.md" and 9 more). The sync stopped and changed nothing.`,
    );
    expect(files.calls).toEqual([]);
  });

  it("goes on from a first run that stopped early, with the ids it gave", async () => {
    const files = emptyFiles();
    const write = files.write;
    files.write = async (path, content) => {
      if (path.startsWith(MODULES)) throw new Error("Relay: 503");
      return write(path, content);
    };
    await expect(syncAtlasCourse(CONFIG, { files, docs: memoryDocs(CHAPTERS()) })).rejects.toThrow(/Relay: 503/);
    const id = splitFrontmatter(files.files.get(lensOf("Risks", "Misuse"))!).data.id;
    files.write = write;
    const again = await syncAtlasCourse(CONFIG, { files, docs: memoryDocs(CHAPTERS()) });
    expect(again.warnings.filter((w) => w.includes("took it back with its id"))).toHaveLength(8);
    expect(splitFrontmatter(files.files.get(lensOf("Risks", "Misuse"))!).data.id).toBe(id);
  });
});

describe("syncAtlasCourse: what keeps a lens its id", () => {
  it("keeps every other section's lens when a section is put before them", async () => {
    const { run, files, specs, data } = await course();
    const ids = new Map([...files.files.keys()].filter((p) => p.startsWith(LENSES)).map((p) => [p, data(p).id]));
    specs[0].sections.unshift({ title: "Preface", heading: "h.pref", words: wordsOf("pref") });
    const report = await run({}, minutes(10));
    expect(report.retired).toEqual([]);
    for (const [path, id] of ids) expect(data(path).id).toBe(id);
    expect(data(lensOf("Capabilities", "Preface")).id).not.toBe(undefined);
  });

  it("gives a chapter in another script, whose sections have no ASCII address, lenses that stay theirs", async () => {
    const specs = CHAPTERS();
    specs[1] = { number: 2, title: "Риски", sections: [{ title: "Введение", heading: "h.vv", words: wordsOf("vved") }, { title: "Злоупотребление", heading: "h.zl", words: wordsOf("zloup") }] };
    const { run, files, data } = await course(specs);
    const module = `${MODULES}/Chapter 2 - Риски.md`;
    expect(data(module).slug).toBe("atlas-chapter-2");
    // Lens makes a lens's slug from its file name, in ASCII: the section number keeps the two apart.
    const lenses = () => [...files.files.keys()].filter((path) => path.startsWith(LENSES) && path.includes("Риски"));
    expect(lenses()).toEqual([lensOf("Риски", "Введение 2.1"), lensOf("Риски", "Злоупотребление 2.2")]);
    const ids = new Map(lenses().map((path) => [data(path).upstream_heading, data(path).id]));
    expect(lenses().map((path) => data(path).upstream_key)).toEqual(["chapter-2#", "chapter-2#"]);
    specs[1].sections.reverse();
    await run({}, minutes(10));
    expect(new Map(lenses().map((path) => [data(path).upstream_heading, data(path).id]))).toEqual(ids);
    expect(files.files.get(module)!.indexOf("Злоупотребление")).toBeLessThan(files.files.get(module)!.indexOf("Введение"));
  });

  it("gives sections whose titles say nothing in ASCII file names of their own", async () => {
    const specs = CHAPTERS();
    specs[0].sections.push({ title: "Конец", heading: "h.end", words: wordsOf("konets") }, { title: "???", heading: "h.q", words: wordsOf("qqq") });
    const { files } = await course(specs);
    expect(files.files.has(lensOf("Capabilities", "Конец 1.7"))).toBe(true);
    expect(files.files.has(`${LENSES}/Atlas - Capabilities - 1.8.md`)).toBe(true);
  });

  it("does not go by a heading id that several sections have, as a pasted copy has", async () => {
    const { run, specs, data } = await course();
    const id = data(lensOf("Capabilities", "Takeoff")).id;
    const takeoff = specs[0].sections[4];
    specs[0].sections.splice(2, 0, { ...takeoff, title: "Takeoff, in short", words: takeoff.words.slice(0, 20) });
    await run({}, minutes(10));
    expect(data(lensOf("Capabilities", "Takeoff")).id).toBe(id);
    expect(data(lensOf("Capabilities", "Takeoff, in short")).id).not.toBe(id);
  });

  it("finds a section that lost its heading id by its text", async () => {
    const { run, specs, data } = await course();
    const id = data(lensOf("Risks", "Misuse")).id;
    specs[1].sections[1] = { ...specs[1].sections[1], title: "Misuse Risks", heading: "h.new" };
    await run({}, minutes(10));
    expect(data(lensOf("Risks", "Misuse Risks"))).toMatchObject({ id, upstream_heading: "h.new" });
  });

  it("puts a section renamed to the name of a lens that waits to be retired beside it, and stops no chapter", async () => {
    const { run, specs, files, data } = await course();
    const scaling = data(lensOf("Capabilities", "Scaling")).id;
    const forecasting = data(lensOf("Capabilities", "Forecasting")).id;
    specs[0].sections.splice(2, 1);
    specs[0].sections[2].title = "Scaling";
    const report = await run({}, minutes(10));
    expect(report.moved).toEqual([
      { from: articleOf("Capabilities", "Forecasting"), to: articleOf("Capabilities", "Scaling 1.3") },
      { from: lensOf("Capabilities", "Forecasting"), to: lensOf("Capabilities", "Scaling 1.3") },
    ]);
    expect(data(lensOf("Capabilities", "Scaling")).id).toBe(scaling);
    expect(data(lensOf("Capabilities", "Scaling 1.3")).id).toBe(forecasting);
    // Once the old lens is retired, the next run that plans the chapter gives the name back.
    expect((await run({}, minutes(80))).retired).toContain(lensOf("Capabilities", "Scaling"));
    specs[0].sections[0].words[0] = "edited";
    await run({}, minutes(90));
    expect(data(lensOf("Capabilities", "Scaling")).id).toBe(forecasting);
    expect(files.files.has(lensOf("Capabilities", "Scaling 1.3"))).toBe(false);
  });

  it("leaves alone an article that is not the sync's, though a lens of the sync links to it", async () => {
    const { run, files, specs } = await course();
    const curated = "Lens Edu/articles/Atlas/Misuse (curated).md";
    const text = "---\ntitle: Misuse\nauthor: [Someone]\nsource_url: https://example.org\npublished: 2025-01-01\n---\n\nCurated text.\n";
    files.files.set(curated, text);
    const lens = lensOf("Risks", "Misuse");
    files.files.set(lens, files.files.get(lens)!.replace(/source:: \[\[[^\]]+\]\]/, "source:: [[../../articles/Atlas/Misuse (curated)|Misuse]]"));
    files.files.delete(articleOf("Risks", "Misuse"));
    specs[1].sections[1].words[0] = "edited";
    const report = await run({}, minutes(10));
    expect(report.warnings).toContain(`The lens "${lens}" shows "${curated}", which the Atlas sync did not write; the sync leaves that file alone and gives the lens an article of its own.`);
    expect(files.files.get(curated)).toBe(text);
    expect(report.written).toContain(articleOf("Risks", "Misuse"));
    expect(files.files.get(lens)).toContain("source:: [[../../articles/Atlas Test/Atlas - Risks - Misuse|Misuse]]");
  });
});

describe("syncAtlasCourse: a run that is blocked", () => {
  it("looks again in full only once an hour while the Docs stay as they were", async () => {
    const { files, docs, deps } = await course();
    docs.fail.set(DOC2, new Error("Google Doc is not readable (403)"));
    const memory: AtlasMemory = { images: new Map(), charts: new Map() };
    const first = await syncAtlasCourse(CONFIG, { ...deps, memory, now: () => minutes(10) });
    expect(first.skipped).toEqual([`${link(DOC2)} was left out of this run, and its files kept as they are: Google Doc is not readable (403). The sync reads it again at its first run from 11:10 UTC, or sooner if a Doc of the course changes.`]);
    files.calls.length = 0;
    const reads = vi.spyOn(files, "read");
    const again = await syncAtlasCourse(CONFIG, { ...deps, memory, now: () => minutes(30) });
    expect(again.stillBlocked).toBe("1 chapter(s) left out");
    // The course file only, for its charts (and the chart files, of which this course has none).
    expect(reads.mock.calls).toEqual([[COURSE]]);
    const log = { log: vi.fn(), error: vi.fn() };
    logAtlasReport(again, log);
    expect(log.log.mock.calls).toEqual([[`[atlas-sync] ${COURSE} at ${again.revision}: still blocked (1 chapter(s) left out); the Docs are as they were, so the run looks again in full within the hour`]]);
    expect((await syncAtlasCourse(CONFIG, { ...deps, memory, now: () => minutes(75) })).skipped).toHaveLength(1);
    docs.fail.clear();
    expect((await syncAtlasCourse(CONFIG, { ...deps, memory, now: () => minutes(80) })).skipped).toEqual([]);
    expect(memory.blocked).toBeUndefined();
  });
});

describe("syncAtlasCourse: a chapter that cannot be read", () => {
  it("is left out with its files as they are, and nothing of it is retired", async () => {
    const { run, files, docs, specs, data } = await course();
    const before = new Map(files.files);
    const revisions = data(COURSE).upstream_revisions as Record<string, string>;
    docs.fail.set(DOC2, new Error("Google Doc is not readable (404: not found)"));
    specs[0].sections[0].words[0] = "changed";

    const report = await run({}, minutes(10));
    expect(report.skipped).toEqual([`${link(DOC2)} was left out of this run, and its files kept as they are: Google Doc is not readable (404: not found). The next run reads it again.`]);
    expect(report.written).toEqual([articleOf("Capabilities", "Introduction"), COURSE]);
    expect(report.retired).toEqual([]);
    for (const path of before.keys()) if (path.includes("Risks")) expect(files.files.get(path)).toBe(before.get(path));
    expect(files.files.get(COURSE)).toContain("# Module: [[../../modules/Atlas Test/Chapter 2 - Risks|Chapter 2: Risks]]");
    expect((data(COURSE).upstream_revisions as Record<string, string>)[DOC2]).toBe(revisions[DOC2]);
    expect((await run({}, minutes(80))).retired).toEqual([]);
  });

  it("is left out when its TITLE does not read as a chapter", async () => {
    const { run, docs, files } = await course();
    const before = files.files.get(`${MODULES}/Chapter 2 - Risks.md`);
    docs.titles.set(DOC2, "Risks, a draft");
    const report = await run({}, minutes(10));
    expect(report.skipped).toEqual([expect.stringContaining('its TITLE does not read "Chapter <N> - <Title>"')]);
    expect(report.written).toEqual([]);
    expect(files.files.get(`${MODULES}/Chapter 2 - Risks.md`)).toBe(before);
  });

  it("writes nothing for a chapter whose image fails to download", async () => {
    const files = emptyFiles();
    const docs = memoryDocs(CHAPTERS());
    docs.getImage = async () => {
      throw new Error("Google: fetch failed");
    };
    const report = await syncAtlasCourse(CONFIG, { files, docs });
    expect(report.skipped).toEqual([expect.stringContaining("1 image(s) could not be hosted: image kix.one: Google: fetch failed")]);
    expect([...files.files.keys()].some((p) => p.includes("Capabilities"))).toBe(false);
    expect(files.files.get(COURSE)).toContain("Chapter 2: Risks");
    expect(files.files.get(COURSE)).not.toContain(DOC1 + '": "');
  });
});

describe("startAtlasSync", () => {
  it("syncs each course, logs its report, and logs a failed run without stopping", async () => {
    const files = emptyFiles();
    const log = { log: vi.fn(), error: vi.fn() };
    const stop = startAtlasSync([CONFIG], 60_000, { files: () => files, docs: () => memoryDocs(CHAPTERS()) }, log);
    await vi.waitFor(() => expect(files.files.has(COURSE)).toBe(true));
    stop();
    expect(log.log).toHaveBeenCalledWith(`[atlas-sync] ${COURSE}, every 1 min`);
    await vi.waitFor(() => expect(log.log).toHaveBeenCalledWith(expect.stringMatching(/^\[atlas-sync\] .* at [0-9a-f]{12}: 19 written, 0 moved, 0 retired$/)));

    const broken = { log: vi.fn(), error: vi.fn() };
    const stop2 = startAtlasSync([CONFIG], 60_000, { files: () => files, docs: () => { throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not set"); } }, broken);
    await vi.waitFor(() => expect(broken.error).toHaveBeenCalled());
    stop2();
    expect(broken.error.mock.calls[0][0]).toBe(`[atlas-sync] ${COURSE}: failed: GOOGLE_SERVICE_ACCOUNT_JSON is not set\n[atlas-sync] Nothing was recorded as done; the next run, in 1 min, tries again.`);
  });

  it("prints every line of a warning with the prefix", () => {
    const log = { log: vi.fn(), error: vi.fn() };
    logAtlasReport({ course: COURSE, revision: "abc", upToDate: false, changed: false, written: [], moved: [], retired: [], skipped: [], charts: [], warnings: ["one\ntwo"] }, log);
    expect(log.log.mock.calls.map(([line]) => line)).toEqual([`[atlas-sync] ${COURSE} at abc: unchanged, 1 warning(s)`, "[atlas-sync]   one\n[atlas-sync]   two"]);
  });
});

describe("syncAtlasCourse: charts", () => {
  const SLUG = "annual-industrial-robots-installed";
  const ID = `owid-${SLUG}`;
  const CHART = `Lens Edu/charts/Atlas Test/${ID}.md`;
  const DAY = 24 * 60 * 60_000;
  const owidFile = (name: string) => readFileSync(join(__dirname, "../charts/__fixtures__/owid", name), "utf8");

  /** OWID serving the robots chart from the chart fixtures (`csv`; 403 when it is null, 503 while `down`); 404 for any other chart. */
  function owid() {
    const urls: string[] = [];
    const served = { csv: owidFile(`${SLUG}.filtered.csv`) as string | null, down: false };
    const get = async (url: string) => {
      urls.push(url);
      const [, slug, rest] = /^https:\/\/ourworldindata\.org\/grapher\/([^./?]+)\.(.*)$/.exec(url) ?? [];
      if (slug !== SLUG) throw new Gone(`${url} answered 404`);
      if (rest.startsWith("config.json")) return owidFile(`${SLUG}.config.json`);
      if (rest.startsWith("metadata.json")) return owidFile(`${SLUG}.metadata.json`);
      if (served.down) throw new Error(`${url} answered 503`);
      if (served.csv === null) throw new Gone(`${url} answered 403`);
      return served.csv;
    };
    return { urls, served, get };
  }

  /** The course with the robots chart in Risks > Misuse and a retired OWID chart in Risks > Risk Decomposition. */
  async function charted() {
    const specs = CHAPTERS();
    specs[1].sections[1].chart = SLUG;
    specs[1].sections[0].chart = "retired-chart";
    const source = owid();
    const memory: AtlasMemory = { images: new Map(), charts: new Map() };
    const result = await course(specs, { fetchChart: source.get, memory });
    return { ...result, source, memory };
  }

  it("writes the chart file before the articles, names it on its figure's still image, and records it in the course file", async () => {
    const { first, files, data } = await charted();
    expect(first.charts.map(({ id, action }) => `${id} ${action}`)).toEqual(["owid-retired-chart absent", `${ID} written`]);
    expect(first.warnings).toEqual([
      `The chart "owid-retired-chart" (https://ourworldindata.org/grapher/retired-chart.csv?v=1&csvType=filtered&useColumnShortNames=true) has no data, so its figure stays a still image: https://ourworldindata.org/grapher/retired-chart.config.json answered 404; it is tried again weekly.`,
    ]);
    expect(files.files.get(CHART)).toMatch(/^---\nid: "owid-annual-industrial-robots-installed"\nsource: https:\/\/ourworldindata.org\/grapher\/annual-industrial-robots-installed.csv\?v=1&csvType=filtered&useColumnShortNames=true\nretrieved: 2026-11-13\n---\n/);
    expect(files.files.get(articleOf("Risks", "Misuse"))).toContain(`![Interactive figure 2.2](attachments/atlas-risks.png "chart:${ID}")`);
    expect(files.files.get(articleOf("Risks", "Risk Decomposition"))).toContain("![Interactive figure 2.1](attachments/atlas-risks.png)\n");
    expect(Object.keys(data(COURSE).sync_charts as Record<string, string>)).toEqual([ID]);
  });

  it("reads each chart at most once a day, also while the Docs stay as they were, and rewrites only the chart file when its data changes", async () => {
    const { run, files, source } = await charted();
    source.urls.length = 0;
    expect(await run({}, minutes(10))).toMatchObject({ upToDate: true, written: [], charts: [{ action: "absent" }, { action: "not due" }] });
    expect(source.urls).toEqual([]);

    const day = await run({}, new Date(T0.getTime() + DAY));
    expect(day).toMatchObject({ upToDate: true, charts: [{ action: "absent" }, { action: "unchanged" }] });
    // The robots chart's three files; the retired chart is tried again only a week on.
    expect(source.urls).toHaveLength(3);
    expect(files.calls).toEqual([]);

    source.served.csv = source.served.csv!.replace("CHN,2024,295000", "CHN,2024,300000");
    const changed = await run({}, new Date(T0.getTime() + 2 * DAY));
    expect(changed).toMatchObject({ upToDate: true, written: [], charts: [{ action: "absent" }, { action: "written", reason: "the data changed" }] });
    expect(files.calls).toEqual([`write ${CHART}`]);
    expect(files.files.get(CHART)).toContain("retrieved: 2026-11-15\n");
  });

  it("writes the chapter's articles again when a chart gets its file, and keeps the last good data when a check fails", async () => {
    const specs = CHAPTERS();
    specs[1].sections[1].chart = SLUG;
    const source = owid();
    source.served.down = true;
    const memory: AtlasMemory = { images: new Map(), charts: new Map() };
    const { run, files } = await course(specs, { fetchChart: source.get, memory });
    expect(files.files.has(CHART)).toBe(false);
    expect(files.files.get(articleOf("Risks", "Misuse"))).not.toContain("chart:");

    source.served.down = false;
    const later = await run({}, new Date(T0.getTime() + DAY));
    expect(later.written).toEqual([articleOf("Risks", "Misuse"), COURSE]);
    expect(files.files.get(articleOf("Risks", "Misuse"))).toContain(`"chart:${ID}")`);

    const good = files.files.get(CHART);
    source.served.csv = null;
    const failed = await run({}, new Date(T0.getTime() + 2 * DAY));
    expect(failed).toMatchObject({ upToDate: true, charts: [{ action: "kept" }] });
    expect(failed.warnings[0]).toMatch(/keeps its data of 2026-11-14: .* answered 403; it is tried again weekly\.$/);
    expect(files.files.get(CHART)).toBe(good);
  });

  it("trashes a chart file once no figure draws it, but not while a chapter cannot be read", async () => {
    const { run, files, specs, docs, data } = await charted();
    specs[1].sections[1].chart = undefined;
    docs.fail.set(DOC1, new Error("Google Doc is not readable (403)"));
    expect((await run({}, minutes(10))).charts.map((c) => c.action)).toEqual(["absent"]);
    expect(files.files.has(CHART)).toBe(true);

    docs.fail.clear();
    const report = await run({}, minutes(20));
    expect(report.charts.map((c) => `${c.id} ${c.action}`)).toEqual(["owid-retired-chart absent", `${ID} deleted`]);
    expect(files.files.has(CHART)).toBe(false);
    expect(files.files.get(articleOf("Risks", "Misuse"))).not.toContain("chart:");
    expect(data(COURSE).sync_charts).toBeUndefined();
  });

  it("trashes a chart written while the course was blocked, once no figure draws it", async () => {
    const specs = CHAPTERS();
    specs[1].sections[1].chart = SLUG;
    const files = emptyFiles();
    const docs = memoryDocs(specs);
    // No chapter can be used, so the run ends without recording its charts in the course file.
    docs.titles.set(DOC1, "Not a chapter");
    docs.titles.set(DOC2, "Not a chapter either");
    let now = T0;
    const deps: AtlasSyncDeps = { files, docs, fetchChart: owid().get, memory: { images: new Map(), charts: new Map() }, now: () => now };
    const blocked = await syncAtlasCourse(CONFIG, deps);
    expect(blocked.skipped).toHaveLength(2);
    expect(files.files.has(CHART)).toBe(true);
    expect(splitFrontmatter(files.files.get(COURSE) ?? "").data.sync_charts).toBeUndefined();

    specs[1].sections[1].chart = undefined;
    docs.titles.clear();
    now = minutes(10);
    const cleared = await syncAtlasCourse(CONFIG, deps);
    expect(cleared.charts).toMatchObject([{ id: ID, action: "deleted" }]);
    expect(files.files.has(CHART)).toBe(false);
  });

  it("lists the charts in a dry run, and names them on the articles it would write, writing nothing", async () => {
    const specs = CHAPTERS();
    specs[1].sections[1].chart = SLUG;
    const files = emptyFiles();
    const report = await syncAtlasCourse(CONFIG, { files, docs: memoryDocs(specs), fetchChart: owid().get }, { dryRun: true });
    expect(report.charts).toMatchObject([{ id: ID, path: CHART, action: "written", reason: "new", bytes: expect.any(Number) }]);
    expect(files.files.size).toBe(0);
  });
});

/** Opt-in: ATLAS_FIXTURE is the saved copy of the 8 chapter Docs, `{ <docId>: <document> }`. */
describe.skipIf(!process.env.ATLAS_FIXTURE)("the real course", () => {
  it("is written whole on a first run, and a second run of the same Docs writes nothing", async () => {
    const documents = JSON.parse(readFileSync(process.env.ATLAS_FIXTURE!, "utf8")) as Record<string, DocsDocument>;
    const [config] = parseAtlasCourses(`[${readFileSync(join(__dirname, "../../../scripts/atlas-sync.config.example.json"), "utf8")}]`);
    const docs: AtlasDocs = { getDocument: async (id) => documents[id], getImage: async () => new Uint8Array([1]) };
    const files = emptyFiles();
    // Its charts are not read: the test stays off the network, and its figures stay still images.
    const deps = { files, docs, fetchChart: async (url: string) => Promise.reject(new Error(`${url}: not read in tests`)) };
    const first = await syncAtlasCourse(config, deps);
    expect(first.skipped).toEqual([]);
    expect(first.written.filter((path) => path.includes("/Lenses/"))).toHaveLength(71);
    expect(await syncAtlasCourse(config, deps)).toMatchObject({ upToDate: true, written: [] });
    const forced = await syncAtlasCourse(config, deps, { force: true });
    expect(forced).toMatchObject({ changed: false, written: [] });
  });
});
