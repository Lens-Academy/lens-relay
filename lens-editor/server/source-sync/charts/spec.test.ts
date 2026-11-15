import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHART_LIMITS, chartJson, specProblems, type ChartSpec } from "./spec";

const fixture = (name: string): ChartSpec => JSON.parse(readFileSync(join(import.meta.dirname, "__fixtures__", "specs", `owid-${name}.json`), "utf8"));
const scatter = () => fixture("exponential-growth-of-computation-in-the-training-of-notable-ai-systems");
const bars = () => fixture("share-companies-using-artificial-intelligence");

describe("specProblems", () => {
  it("passes the converter's charts of each kind", () => {
    for (const spec of [scatter(), bars(), fixture("annual-industrial-robots-installed"), fixture("nvidia-quarterly-revenue-segment")]) expect(specProblems(spec)).toEqual([]);
  });

  it("names what is wrong", () => {
    const cases: [string, (s: Record<string, unknown> & ChartSpec) => void, RegExp][] = [
      ["version", (s) => ((s as Record<string, unknown>).version = 2), /version must be 1/],
      ["kind", (s) => ((s as Record<string, unknown>).kind = "pie"), /kind must be one of/],
      ["unknown field", (s) => (s.extra = 1), /the chart has unknown field\(s\): extra/],
      ["unknown x field", (s) => ((s.x as Record<string, unknown>).format = "%Y"), /x has unknown field\(s\): format/],
      ["unknown y field", (s) => ((s.y as Record<string, unknown>).ticks = 5), /y has unknown field\(s\): ticks/],
      ["unknown series field", (s) => ((s.series[0] as unknown as Record<string, unknown>).color = "red"), /series\[0\] has unknown field\(s\): color/],
      ["unknown credit field", (s) => ((s.credit as Record<string, unknown>).year = 2026), /credit has unknown field\(s\): year/],
      ["not a real day", (s) => (s.series[0].points[0][0] = "2021-02-30"), /x as x.type says/],
      ["retrieved not a real day", (s) => (s.credit.retrieved = "2026-13-01"), /credit must be/],
      ["no points", (s) => s.series.forEach((one) => (one.points = [])), /the chart has no points/],
      ["x label (revision 2)", (s) => ((s.x as Record<string, unknown>).label = "Year"), /x has unknown field\(s\): label/],
      ["credit chart (revision 2)", (s) => ((s.credit as Record<string, unknown>).chart = "Our World in Data"), /credit has unknown field\(s\): chart/],
      ["x type", (s) => ((s.x as Record<string, unknown>).type = "month"), /x must be/],
      ["y max at min", (s) => Object.assign(s.y, { min: 5, max: 5 }), /max above min/],
      ["no series", (s) => (s.series = []), /non-empty list/],
      ["non-finite y", (s) => (s.series[0].points[0][1] = Number.NaN), /a finite y/],
      ["x of another type", (s) => (s.series[0].points[0][0] = 2020), /x as x.type says/],
      ["unsorted", (s) => s.series.find((one) => one.points.length > 1)!.points.reverse(), /not sorted by x/],
      ["line on a bar chart", (s) => (s.series[0].line = true), /line may only be true, on a scatter/],
      ["credit url", (s) => (s.credit.url = "http://x"), /credit must be/],
    ];
    for (const [what, change, problem] of cases) {
      const spec = what === "line on a bar chart" ? bars() : scatter();
      change(spec as Record<string, unknown> & ChartSpec);
      expect(specProblems(spec).join("\n"), what).toMatch(problem);
    }
    expect(specProblems({ ...bars(), highlight: ["x"] })).toEqual(["highlight must be a list of names, on a scatter chart"]);
    expect(specProblems({ ...scatter(), facets: true })).toEqual(["facets may only be true, on a stacked-bar chart"]);
    expect(specProblems({ ...bars(), y: { ...bars().y, scale: "log" } })).toEqual(["y.scale may be log on line and scatter charts only"]);
    const years = fixture("annual-industrial-robots-installed");
    years.series[0].points[0][0] = -10001;
    expect(specProblems(years).join()).toMatch(/x as x.type says/);
    expect(specProblems("{}")).toEqual(["the chart is not a JSON object"]);
  });

  it("enforces the limits: series, points and bytes", () => {
    const base = scatter();
    const many = (series: number, points: number, name = "s"): ChartSpec => ({
      ...base,
      series: Array.from({ length: series }, (_, i) => ({ name: `${name}${i}`, points: Array.from({ length: points }, (_, j): [string, number] => [`2000-01-${String((j % 28) + 1).padStart(2, "0")}`, 1]).sort() })),
    });
    expect(specProblems(many(CHART_LIMITS.series + 1, 1))).toEqual([`the chart has ${CHART_LIMITS.series + 1} series, over the limit of ${CHART_LIMITS.series}`]);
    expect(specProblems(many(2, 2501))).toContain(`the chart has 5002 points, over the limit of ${CHART_LIMITS.points}`);
    expect(specProblems(many(800, 2, "x".repeat(240))).join()).toMatch(/KB of JSON, over the 200 KB limit/);
  });

  it("measures the JSON as the file holds it: no CriticMarkup opener or %% comment, the spec unchanged", () => {
    const spec = { ...scatter(), title: "a {++b++} {--c--} {~~d~>e~~} {>>f<<} {==g==} 100%% {x}" };
    const json = chartJson(spec);
    expect(json).not.toMatch(/\{(\+\+|--|~~|>>|==)|%%/);
    expect(JSON.parse(json)).toEqual(spec);
    expect(json).toContain('"title":"a \\u007b++b++} \\u007b--c--}');
  });
});
