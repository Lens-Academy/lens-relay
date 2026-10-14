import { describe, expect, it, vi } from "vitest";
import { memoryFiles } from "./__fixtures__/files/course";
import type { Layout } from "./layout";
import { startCourseSync, syncCourse } from "./sync";
import type { Snapshot, Worksheet } from "./types";

// A course of one module and one lens, as a hand import leaves it: no pin,
// no commit on the course file. Its source page has the lens's section and
// one more, too short to stand alone.
const LAYOUT: Layout = { course: "Lens Edu/courses/t.md", moduleDir: "Lens Edu/modules/Iliad", lensDir: () => "Lens Edu/Lenses/Iliad/B.1 One" };
const LENS = "Lens Edu/Lenses/Iliad B.1.1 - Alpha.md";
const SYNCED_LENS = "Lens Edu/Lenses/Iliad/B.1 One/Iliad B.1.1 - Alpha.md";

const alpha = "Alpha is the first idea of the day, and this sentence says so plainly.";
const course = (): Record<string, string> => ({
  [LAYOUT.course]: `---\nslug: t\ntitle: "T"\n---\n# Module: [[../modules/Iliad B - Learning|B — Learning]]\n`,
  "Lens Edu/modules/Iliad B - Learning.md": `---\nid: 'm-b'\nslug: iliad-b\ntitle: "B — Learning"\n---\n\n# Submodule: B.1 One\n\n# Lens: B.1.1 Alpha\nsource:: [[../Lenses/Iliad B.1.1 - Alpha]]\n`,
  [LENS]: `---\nid: 'lens-1'\ntitle: "B.1.1 Alpha"\ntldr: "By hand."\nsummary_for_tutor: "By hand, for the tutor."\nsource_url: https://iliad-intensive.org/learning/one/\n---\n\n#### Text\ncontent::\n\\## Alpha\n\n${alpha}\n`,
});

const worksheet = (mdx: string): Worksheet => ({
  slug: "one",
  cluster: { id: "B", label: "B — Learning", urlSlug: "learning" },
  dayCode: "B.1",
  dayTitle: "One",
  code: "B.1",
  title: "One",
  summary: null,
  contributors: ["Ada L"],
  slides: null,
  pageUrl: "https://iliad-intensive.org/learning/one/",
  mdx,
});

const PAGE = `## Alpha\n\n${alpha}\n\n## Beta\n\nBeta is new.\n`;

// Deployed long ago unless a test says otherwise: a fresh deploy holds back changes that lose something.
function source(commit: string, mdx = PAGE, asset: Snapshot["asset"] = async () => new Uint8Array(), deployedAt: Date | null = new Date(0)) {
  const snapshot = vi.fn(async (): Promise<Snapshot> => ({ commit, worksheets: [worksheet(mdx)], asset, warnings: [], deployedAt }));
  return { commit: async () => commit, snapshot };
}

describe("syncCourse", () => {
  it("adopts a hand-import lens: same id, pinned, moved into its folder, with the new section in it", async () => {
    const files = memoryFiles(course());
    const report = await syncCourse({ files, layout: LAYOUT, source: source("c1") });

    expect(report).toMatchObject({ commit: "c1", changed: true, retired: [], moved: expect.arrayContaining([{ from: LENS, to: SYNCED_LENS }]) });
    const lens = files.files.get(SYNCED_LENS)!;
    expect(lens).toContain("id: 'lens-1'");
    expect(lens).toContain('upstream_key: "one#alpha"');
    expect(lens).toContain("Beta is new.");
    expect(lens).toContain('tldr: "By hand."');
    expect(files.files.has(LENS)).toBe(false);
    expect(files.files.get(LAYOUT.course)).toContain("upstream_commit: 'c1'");
    // The course file's commit is the last thing written.
    expect(files.calls.at(-1)).toBe(`write ${LAYOUT.course}`);
  });

  it("reads one file and nothing of the source when the course already records the published commit", async () => {
    const files = memoryFiles(course());
    await syncCourse({ files, layout: LAYOUT, source: source("c1") });
    files.calls.length = 0;
    const read = vi.spyOn(files, "read");
    const again = source("c1");

    expect(await syncCourse({ files, layout: LAYOUT, source: again })).toMatchObject({ changed: false, written: [], moved: [] });
    expect(again.snapshot).not.toHaveBeenCalled();
    expect(read.mock.calls).toEqual([[LAYOUT.course]]);
    expect(files.calls).toEqual([]);
  });

  it("writes only the commit when a new source commit changes nothing of the course", async () => {
    const files = memoryFiles(course());
    await syncCourse({ files, layout: LAYOUT, source: source("c1") });
    files.calls.length = 0;

    const report = await syncCourse({ files, layout: LAYOUT, source: source("c2") });
    expect(report.written).toEqual([LAYOUT.course]);
    expect(files.calls).toEqual([`write ${LAYOUT.course}`]);
  });

  it("asks for summaries only for a lens that is new or changed since the sync last wrote it", async () => {
    const files = memoryFiles(course());
    const ask = vi.fn(async () => JSON.stringify({ tldr: "A new one-sentence summary of the lens, long enough to pass.", summary_for_tutor: "Worksheet B.1. A new summary for the tutor that names the worksheet and what the lens covers, in enough words to pass the length check that the parser applies to it." }));

    // The hand import's summaries are kept: its content was never synced, so nothing says it changed.
    await syncCourse({ files, layout: LAYOUT, source: source("c1"), ask });
    expect(ask).not.toHaveBeenCalled();

    await syncCourse({ files, layout: LAYOUT, source: source("c2", PAGE.replace("Beta is new.", `Beta is new. ${"It now says a good deal more than it did. ".repeat(12)}`)), ask });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  const FIGURE = `${PAGE}\n<Figure src="/uploads/one/plot.svg" alt="A plot" />\n`;
  const bytes = (text: string) => async () => new TextEncoder().encode(text);

  it("puts a link in the lens, warns and still finishes when a figure can never be hosted", async () => {
    const files = memoryFiles(course());
    // An SVG that loads a file from outside itself is refused for good.
    const reachesOut = bytes('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><image href="/etc/hostname" width="4" height="4"/></svg>');
    const report = await syncCourse({ files, layout: LAYOUT, source: source("c1", FIGURE, reachesOut) });

    expect(report.changed).toBe(true);
    expect(report.warnings.join("\n")).toContain("/uploads/one/plot.svg");
    expect(files.files.get(SYNCED_LENS)).not.toContain("![");
    expect(files.files.get(LAYOUT.course)).toContain("upstream_commit: 'c1'");
  });

  it("links to a figure the site answers for with something that is no image, and still finishes", async () => {
    const files = memoryFiles(course());
    const report = await syncCourse({ files, layout: LAYOUT, source: source("c1", FIGURE, bytes("<html>Not found</html>")) });
    expect(report.warnings.join("\n")).toContain("/uploads/one/plot.svg");
    expect(files.files.get(LAYOUT.course)).toContain("upstream_commit: 'c1'");
  });

  it("fails, and records no commit, when a figure cannot be downloaded", async () => {
    const files = memoryFiles(course());
    const offline = async () => {
      throw new Error("fetch failed");
    };
    await expect(syncCourse({ files, layout: LAYOUT, source: source("c1", FIGURE, offline) })).rejects.toThrow("fetch failed");
    expect(files.calls).toEqual([]);
    expect(files.files.get(LAYOUT.course)).not.toContain("upstream_commit");
  });

  it("stops when the course file is missing: a wrong path must not look like an empty course", async () => {
    await expect(syncCourse({ files: memoryFiles({}), layout: LAYOUT, source: source("c1") })).rejects.toThrow('"Lens Edu/courses/t.md" does not exist');
  });
});

describe("a change that loses something", () => {
  // Delta is new and long enough to be a lens of its own; then Alpha's section goes.
  const delta = Array.from({ length: 240 }, (_, i) => `delta${i}`).join(" ");
  const TWO = `## Alpha\n\n${alpha}\n\n## Delta\n\n${delta}\n`;
  const ALPHA_GONE = `## Delta\n\n${delta}\n`;
  const synced = async () => {
    const files = memoryFiles(course());
    await syncCourse({ files, layout: LAYOUT, source: source("c1", TWO) });
    files.calls.length = 0;
    return files;
  };
  const NOW = new Date("2026-10-14T12:00:00Z");

  it("waits while the deploy is under an hour old, and changes nothing", async () => {
    const files = await synced();
    const report = await syncCourse({ files, layout: LAYOUT, source: source("c2", ALPHA_GONE, undefined, new Date("2026-10-14T11:30:00Z")), now: () => NOW });
    expect(report).toMatchObject({ changed: false, waitingUntil: new Date("2026-10-14T12:30:00Z") });
    expect(report.warnings[0]).toContain("nothing was changed yet");
    expect(report.warnings.join("\n")).toContain('"B.1.1 Alpha" would be retired');
    expect(files.calls).toEqual([]);
  });

  it("applies once the deploy has stood an hour, and says what it retired and why", async () => {
    const files = await synced();
    const report = await syncCourse({ files, layout: LAYOUT, source: source("c2", ALPHA_GONE, undefined, new Date("2026-10-14T10:30:00Z")), now: () => NOW });
    expect(report.retired).toEqual([SYNCED_LENS]);
    expect(report.warnings[0]).toContain("B.1.1 Alpha");
  });

  it("applies at once a commit a person approved", async () => {
    const files = await synced();
    const report = await syncCourse({ files, layout: LAYOUT, source: source("c2", ALPHA_GONE, undefined, NOW), now: () => NOW, approvedRetirement: "c2" });
    expect(report.retired).toEqual([SYNCED_LENS]);
  });

  it("waits for a person when the site does not say when it was deployed", async () => {
    const files = await synced();
    const report = await syncCourse({ files, layout: LAYOUT, source: source("c2", ALPHA_GONE, undefined, null), now: () => NOW });
    expect(report.changed).toBe(false);
    expect(report.waitingUntil).toBeUndefined();
    expect(report.warnings[0]).toContain("ILIAD_SYNC_APPROVE_RETIREMENT=c2");
    expect(files.calls).toEqual([]);
  });

  it("still needs a person, however old the deploy, to empty a page the schedule lists", async () => {
    const files = await synced();
    const empty = `## Gamma\n\n${Array.from({ length: 240 }, (_, i) => `gamma${i}`).join(" ")}\n`;
    await expect(syncCourse({ files, layout: LAYOUT, source: source("c2", empty), now: () => NOW })).rejects.toThrow("ILIAD_SYNC_APPROVE_RETIREMENT=c2");
    expect(files.calls).toEqual([]);
  });

  it("does not hold back a change that loses nothing", async () => {
    const files = await synced();
    const report = await syncCourse({ files, layout: LAYOUT, source: source("c2", TWO.replace("delta7 ", "delta7 more "), undefined, NOW), now: () => NOW });
    expect(report.changed).toBe(true);
  });
});

describe("startCourseSync", () => {
  it("logs a failed run and runs again", async () => {
    vi.useFakeTimers();
    const log = { log: vi.fn(), error: vi.fn() };
    const files = memoryFiles(course());
    let commits = 0;
    const flaky = {
      commit: async () => {
        if (commits++ === 0) throw new Error("site down");
        return "c1";
      },
      snapshot: source("c1").snapshot,
    };
    const stop = startCourseSync({ files, layout: LAYOUT, source: flaky }, 60_000, log);
    await vi.advanceTimersByTimeAsync(0);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("[iliad-sync] failed: site down\n[iliad-sync] Nothing was recorded as done"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(files.files.get(LAYOUT.course)).toContain("upstream_commit: 'c1'");
    stop();
    vi.useRealTimers();
  });
});
