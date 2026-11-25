import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { memoryFiles } from "../iliad/__fixtures__/files/course";
import { iframeChart, tableChart } from "./definition";
import { chartFileText, parseChartFile } from "./file";
import { CHECK_EVERY_MS, decide, refreshCharts, type ChartMemo, type ChartRun } from "./refresh";
import { Gone, type ChartFetch } from "./fetch";
import type { ChartSpec } from "./spec";

const SLUG = "annual-industrial-robots-installed";
const DIR = join(import.meta.dirname, "__fixtures__");
const owid = (ext: string) => readFileSync(join(DIR, "owid", `${SLUG}.${ext}`), "utf8");
const SPEC: ChartSpec = JSON.parse(readFileSync(join(DIR, "specs", `owid-${SLUG}.json`), "utf8"));
const spec = (change: (s: ChartSpec) => void = () => {}): ChartSpec => {
  const s = structuredClone(SPEC);
  change(s);
  return s;
};
/** The definition is the one the file was made from. */
const same = false;

describe("decide", () => {
  it("writes a new chart, and changed data with the new date", () => {
    expect(decide(null, SPEC, same)).toEqual({ do: "write", spec: SPEC });
    const changed = spec((s) => {
      s.series[0].points[0][1] = 1;
      s.credit.retrieved = "2026-11-14";
    });
    expect(decide(SPEC, changed, same)).toEqual({ do: "write", spec: changed });
  });

  it("keeps the file when only the date would change", () => {
    expect(decide(SPEC, spec((s) => (s.credit.retrieved = "2026-11-14")), same)).toEqual({ do: "keep" });
  });

  it("refuses a failed fetch, an invalid chart, and fewer than 2 points", () => {
    expect(decide(SPEC, new Error("https://x answered 403"), same)).toEqual({ do: "refuse", reason: "https://x answered 403" });
    expect(decide(null, spec((s) => (s.series[0].points[0][1] = Number.POSITIVE_INFINITY)), same)).toMatchObject({ do: "refuse", reason: expect.stringMatching(/not make a valid chart: .*a finite y/) });
    expect(decide(null, spec((s) => (s.series = [{ name: "one", points: [[2020, 1]] }])), same)).toEqual({ do: "refuse", reason: "the data has 1 point(s); a chart needs 2" });
  });

  it("takes a trend line whose end alone moved for no change, and anything more for new data", () => {
    const COMPUTE: ChartSpec = JSON.parse(readFileSync(join(DIR, "specs", "owid-exponential-growth-of-computation-in-the-training-of-notable-ai-systems.json"), "utf8"));
    const next = (change: (s: ChartSpec) => void) => {
      const s = structuredClone(COMPUTE);
      s.credit.retrieved = "2026-11-14";
      change(s);
      return s;
    };
    const trend = (s: ChartSpec) => s.series.find((one) => one.line && one.points.at(-1)![0] === "2026-11-13")!;
    expect(decide(COMPUTE, next((s) => (trend(s).points[1] = ["2026-11-14", 7.52e9])), same)).toEqual({ do: "keep" });
    const newSystem = next((s) => {
      trend(s).points[1] = ["2026-11-14", 7.52e9];
      s.series.push({ name: "A new model", points: [["2026-11-14", 3e10]] });
    });
    expect(decide(COMPUTE, newSystem, same)).toEqual({ do: "write", spec: newSystem });
    const refitted = next((s) => (trend(s).points[0] = ["2010-01-01", 0.2]));
    expect(decide(COMPUTE, refitted, same)).toEqual({ do: "write", spec: refitted });
  });

  it("refuses data shrunk below half, or of another kind, unless the definition changed", () => {
    const shrunk = spec((s) => (s.series = s.series.slice(0, 1)));
    expect(decide(SPEC, shrunk, same)).toEqual({ do: "refuse", reason: "the data has 8 points, under half the 40 the chart has" });
    expect(decide(SPEC, shrunk, true)).toEqual({ do: "write", spec: shrunk });
    const bars = spec((s) => Object.assign(s, { kind: "stacked-bar", stack: "absolute" }));
    expect(decide(SPEC, bars, same)).toEqual({ do: "refuse", reason: "the source now draws it as stacked-bar, not line" });
    expect(decide(SPEC, bars, true)).toEqual({ do: "write", spec: bars });
  });
});

const CHART = iframeChart(`https://ourworldindata.org/grapher/${SLUG}`)!;
const FOLDER = "Lens Edu/charts/Atlas Test";
const PATH = `${FOLDER}/${CHART.id}.md`;
const T0 = new Date("2026-11-13T10:00:00Z");

/** OWID answering for CHART (its CSV as given), and 404 for anything else. */
function source(csv = owid("filtered.csv")) {
  const urls: string[] = [];
  const answers: Record<string, () => string> = {
    [`https://ourworldindata.org/grapher/${SLUG}.config.json`]: () => owid("config.json"),
    [`https://ourworldindata.org/grapher/${SLUG}.csv?v=1&csvType=filtered&useColumnShortNames=true`]: () => csv,
    [`https://ourworldindata.org/grapher/${SLUG}.metadata.json?v=1&csvType=filtered&useColumnShortNames=true`]: () => owid("metadata.json"),
  };
  const get = async (url: string) => {
    urls.push(url);
    if (!answers[url]) throw new Gone(`${url} answered 404`);
    return answers[url]();
  };
  return { urls, get, set: (text: string) => (csv = text) };
}

function setup(initial: Record<string, string> = {}) {
  const files = memoryFiles(initial);
  const memory = new Map<string, ChartMemo>();
  const src = source();
  const run = (over: Partial<ChartRun> = {}) =>
    refreshCharts({ folder: FOLDER, courseTitle: "Atlas Test", used: [CHART], recorded: new Map(), mayDelete: true, files, get: src.get, memory, now: T0, ...over });
  return { files, memory, src, run };
}

describe("refreshCharts", () => {
  it("writes a new chart's file and records it, then reads it again only after a day", async () => {
    const { files, src, run } = setup();
    const first = await run();
    expect(first.outcomes).toEqual([{ id: CHART.id, path: PATH, action: "written", reason: "new", bytes: Buffer.byteLength(files.files.get(PATH)!) }]);
    expect(parseChartFile(files.files.get(PATH)!, CHART.id)).toEqual(SPEC);
    expect(first.kept).toEqual(new Map([[CHART.id, CHART.hash]]));
    expect(src.urls).toHaveLength(3);

    const soon = await run({ now: new Date(T0.getTime() + CHECK_EVERY_MS - 1), recorded: first.kept });
    expect(soon.outcomes[0].action).toBe("not due");
    expect(soon.kept).toEqual(first.kept);
    expect(src.urls).toHaveLength(3);

    const next = await run({ now: new Date(T0.getTime() + CHECK_EVERY_MS), recorded: first.kept });
    expect(next.outcomes[0].action).toBe("unchanged");
    expect(src.urls).toHaveLength(6);
    expect(files.calls).toEqual([`write ${PATH}`]);
  });

  it("reads a chart at once when its definition changed, and rewrites the file only when the data did", async () => {
    const { files, src, run, memory } = setup();
    await run();
    const titled = { ...CHART, rows: { title: "Robots" }, hash: "other" };
    const again = await run({ used: [titled], now: new Date(T0.getTime() + 60_000), recorded: new Map([[CHART.id, CHART.hash]]) });
    expect(again.outcomes[0]).toMatchObject({ action: "written", reason: "the data changed" });
    expect(parseChartFile(files.files.get(PATH)!, CHART.id).title).toBe("Robots");
    expect(memory.get(CHART.id)?.read?.definition).toBe("other");
    expect(src.urls).toHaveLength(6);
  });

  it("keeps the file, with a warning, when new data fails a check; without a file the figure stays a still image", async () => {
    const { files, src, run } = setup();
    await run();
    const before = files.files.get(PATH);
    src.set(owid("filtered.csv").split("\n").slice(0, 5).join("\n"));
    const later = await run({ now: new Date(T0.getTime() + CHECK_EVERY_MS), recorded: new Map([[CHART.id, CHART.hash]]) });
    expect(later.outcomes[0]).toMatchObject({ action: "kept", reason: "the data has 4 points, under half the 40 the chart has" });
    expect(later.warnings).toEqual([`The chart "${CHART.id}" (https://ourworldindata.org/grapher/${SLUG}.csv?v=1&csvType=filtered&useColumnShortNames=true) keeps its data of 2026-11-13: the data has 4 points, under half the 40 the chart has.`]);
    expect(files.files.get(PATH)).toBe(before);
    expect(later.kept.has(CHART.id)).toBe(true);

    const retired = iframeChart("https://ourworldindata.org/grapher/retired-chart")!;
    const gone = await run({ used: [retired] });
    expect(gone.outcomes[0]).toMatchObject({ id: "owid-retired-chart", action: "absent", reason: "https://ourworldindata.org/grapher/retired-chart.config.json answered 404" });
    expect(gone.kept.has(retired.id)).toBe(false);
    expect(gone.warnings[0]).toMatch(/has no data, so its figure stays a still image/);
  });

  it("does not take a file it cannot read for the chart's data", async () => {
    const { run } = setup({ [PATH]: "---\nid: someone-else\nsource: https://x.test\nretrieved: 2026-11-13\n---\n" });
    const result = await run({ memory: new Map([[CHART.id, { read: { at: T0.getTime(), definition: CHART.hash } }]]) });
    expect(result.outcomes[0].action).toBe("absent");
    expect(result.kept.size).toBe(0);
    expect(result.warnings[0]).toMatch(/is not a chart file the sync can read \(its id is "someone-else"/);
  });

  it("trashes a recorded chart no figure draws, only when every chapter was read, and writes nothing in a dry run", async () => {
    const old = iframeChart("https://ourworldindata.org/grapher/old-chart")!;
    const oldPath = `${FOLDER}/${old.id}.md`;
    const { files, run } = setup({ [oldPath]: chartFileText(old, SPEC, "Atlas Test") });
    const recorded = new Map([[old.id, old.hash]]);

    const partial = await run({ recorded, mayDelete: false, dryRun: true });
    expect(partial.outcomes.map((o) => o.action)).toEqual(["written"]);
    expect([...partial.kept.keys()]).toEqual([CHART.id, old.id]);
    const dry = await run({ recorded, dryRun: true });
    expect(dry.outcomes.map((o) => `${o.id} ${o.action}`)).toEqual([`${CHART.id} written`, `${old.id} deleted`]);
    expect(files.calls).toEqual([]);

    const real = await run({ recorded });
    expect(real.outcomes.at(-1)).toMatchObject({ id: old.id, action: "deleted" });
    expect(files.calls).toEqual([`write ${PATH}`, `trash ${oldPath}`]);
    expect([...real.kept.keys()]).toEqual([CHART.id]);
  });

  it("reads charts with a file first, then new ones, then retries of those gone, for at most the run's time", async () => {
    const { src, run, memory } = setup();
    const gone = iframeChart("https://ourworldindata.org/grapher/retired-chart")!;
    const fresh = iframeChart("https://ourworldindata.org/grapher/new-chart")!;
    await run({ used: [gone, CHART] });
    vi.useFakeTimers();
    try {
      // Every request takes 30 s, unless the run's time runs out first.
      const slow: ChartFetch = (url, signal) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => src.get(url).then(resolve, reject), 30_000);
          signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
        });
      const later = (days: number) => new Date(T0.getTime() + days * CHECK_EVERY_MS + 60_000);
      const timed = async (options: Partial<ChartRun>) => {
        const started = run({ used: [gone, fresh, CHART], get: slow, budgetMs: 100_000, ...options });
        await vi.advanceTimersByTimeAsync(300_000);
        return (await started).outcomes.map((o) => `${o.id} ${o.action}`);
      };
      // A week on, all three are due. The robots chart takes 3 requests (90 s); the next is cut off at 100 s.
      expect(await timed({ now: later(7) })).toEqual([`${gone.id} deferred`, `${fresh.id} deferred`, `${CHART.id} unchanged`]);
      expect(memory.get(fresh.id)?.read).toBeUndefined();
      // The next run reads the new chart, then the one gone.
      expect(await timed({ now: later(7) })).toEqual([`${gone.id} absent`, `${fresh.id} absent`, `${CHART.id} not due`]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tries a chart whose source answered 404 or 403 again a week later, and says so once, when it starts", async () => {
    const { src, run } = setup();
    const gone = iframeChart("https://ourworldindata.org/grapher/retired-chart")!;
    const first = await run({ used: [gone] });
    expect(first.warnings).toEqual([
      `The chart "${gone.id}" (https://ourworldindata.org/grapher/retired-chart.csv?v=1&csvType=filtered&useColumnShortNames=true) has no data, so its figure stays a still image: https://ourworldindata.org/grapher/retired-chart.config.json answered 404; it is tried again weekly.`,
    ]);
    const day = await run({ used: [gone], now: new Date(T0.getTime() + CHECK_EVERY_MS) });
    expect(day).toMatchObject({ outcomes: [{ action: "absent" }], warnings: [] });
    expect(src.urls).toHaveLength(1);
    const week = await run({ used: [gone], now: new Date(T0.getTime() + 7 * CHECK_EVERY_MS) });
    expect(week).toMatchObject({ outcomes: [{ action: "absent", reason: expect.stringMatching(/answered 404/) }], warnings: [] });
    expect(src.urls).toHaveLength(2);
  });

  it("names, once for each definition, the highlight names that match nothing in the data", async () => {
    const rows = new Map([["source", "https://epoch.ai/data/a.csv"], ["x", "Day"], ["y", "Compute"], ["label", "Model"], ["highlight", "GPT-4;AlexNet;Not a model"]]);
    const chart = tableChart(rows).chart!;
    const get = async () => "Day,Compute,Model\n2012-09-30,470,AlexNet\n2023-03-15,2e10,GPT-4 (Mar 2023)\n";
    const { files, run } = setup();
    const first = await run({ used: [chart], get });
    expect(first.warnings).toEqual([`The chart "${chart.id}" (https://epoch.ai/data/a.csv): its highlight row's "GPT-4", "Not a model" name no series or point label of its data.`]);
    expect(parseChartFile(files.files.get(`${FOLDER}/${chart.id}.md`)!, chart.id).highlight).toEqual(["AlexNet"]);
    expect((await run({ used: [chart], get, now: new Date(T0.getTime() + CHECK_EVERY_MS) })).warnings).toEqual([]);
  });

  it("reads a chart's file from Relay only when the chart is due, and warns of an unreadable one once a day", async () => {
    const { files, run } = setup({ [PATH]: "---\nid: broken\n---\n" });
    const reads = vi.spyOn(files, "read");
    // OWID refuses, so the broken file stays as it is.
    const refusing: ChartFetch = async (url) => Promise.reject(new Error(`${url} answered 403`));
    const first = await run({ get: refusing });
    expect(first.warnings.filter((w) => w.includes("is not a chart file"))).toHaveLength(1);
    expect(reads.mock.calls).toEqual([[PATH]]);
    const soon = await run({ get: refusing, now: new Date(T0.getTime() + 60_000) });
    expect(soon.warnings).toEqual([]);
    expect(reads).toHaveBeenCalledTimes(1);
    const day = await run({ get: refusing, now: new Date(T0.getTime() + CHECK_EVERY_MS) });
    expect(day.warnings.filter((w) => w.includes("is not a chart file"))).toHaveLength(1);
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it("knows the files it wrote while the course file could not record them: checks them, and trashes one no figure draws", async () => {
    const { files, src, run } = setup();
    // The course file records nothing: every run here is one that did not finish.
    await run();
    src.set(owid("filtered.csv").split("\n").slice(0, 5).join("\n"));
    const shrunk = await run({ now: new Date(T0.getTime() + CHECK_EVERY_MS) });
    expect(shrunk.outcomes[0]).toMatchObject({ action: "kept", reason: "the data has 4 points, under half the 40 the chart has" });
    const removed = await run({ used: [], now: new Date(T0.getTime() + CHECK_EVERY_MS + 60_000) });
    expect(removed.outcomes).toMatchObject([{ id: CHART.id, action: "deleted" }]);
    expect(files.calls).toEqual([`write ${PATH}`, `trash ${PATH}`]);
  });

  it("draws one chart for one id, and warns when two tables give it different rows", async () => {
    const rows = (title: string) => new Map([["source", "https://epoch.ai/data/a.csv"], ["x", "x"], ["y", "y"], ["id", "shared"], ["title", title]]);
    const [a, b] = [tableChart(rows("A")).chart!, tableChart(rows("B")).chart!];
    const { run } = setup();
    const result = await run({ used: [CHART, CHART, a, b], get: async (url) => (url.includes("epoch") ? "x,y\n2020,1\n2021,2\n" : source().get(url)) });
    expect(result.outcomes.map((o) => o.id)).toEqual([CHART.id, "shared"]);
    expect(result.warnings).toEqual([`Two figures draw the chart "shared" with different definitions; both draw the first one's chart. To draw both, give a chart table an id row of its own.`]);
  });
});
