import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { owidKind, owidToSpec, withoutSharedWords } from "./owid";
import { specProblems } from "./spec";

/**
 * Parity with the reference converter (owid_to_spec.py): `specs/owid-<slug>.json`
 * is its output for `owid/<slug>.{config.json,filtered.csv,metadata.json}`,
 * retrieved 2026-11-13. The fixtures here are the Atlas's 13 OWID charts,
 * trimmed to a few rows each (their unused fields dropped) and converted by
 * the reference again. OWID_PARITY_DIR names a directory of the same layout
 * holding the full ones, for a check on a machine that has them.
 * Python writes 23000 as 23000.0; both parse to the same number, so the
 * reference output is compared once parsed and written again.
 */
const dirs = [join(import.meta.dirname, "__fixtures__"), process.env.OWID_PARITY_DIR].filter((dir): dir is string => !!dir && existsSync(join(dir, "specs")));

describe.each(dirs)("owidToSpec matches the reference converter (%s)", (dir) => {
  const slugs = readdirSync(join(dir, "specs")).flatMap((name) => /^owid-(.+)\.json$/.exec(name)?.[1] ?? []);
  it("has the Atlas's 13 charts", () => expect(slugs).toHaveLength(13));
  it.each(slugs)("%s", (slug) => {
    const read = (ext: string) => readFileSync(join(dir, "owid", `${slug}.${ext}`), "utf8");
    const spec = owidToSpec(slug, JSON.parse(read("config.json")), read("filtered.csv"), JSON.parse(read("metadata.json")), "2026-11-13");
    const reference = readFileSync(join(dir, "specs", `owid-${slug}.json`), "utf8");
    expect(JSON.stringify(spec)).toBe(JSON.stringify(JSON.parse(reference)));
    expect(specProblems(spec)).toEqual([]);
  });
});

describe("owidToSpec: what it cannot draw", () => {
  const csv = "entity,year,a,b\nX,2020,1,2\nY,2020,3,4\n";
  it("refuses a map, a chart type with no kind, and several values of several entities", () => {
    expect(() => owidKind({ tab: "map", chartTypes: ["LineChart"] })).toThrow(/map/);
    expect(() => owidKind({ chartTypes: ["DiscreteBar"] })).toThrow(/DiscreteBar/);
    expect(owidKind({ tab: "slope", chartTypes: ["DiscreteBar"] })).toBe("line");
    expect(() => owidToSpec("s", {}, csv, {}, "2026-11-13")).toThrow(/2 value columns for 2 entities/);
    expect(() => owidToSpec("s", {}, "code,year,a\n", {}, "2026-11-13")).toThrow(/no rows/);
  });

  it("shortens names made from column titles by the words they all share, never an entity's", () => {
    expect(withoutSharedWords(["Bioenergy levelized cost of energy", "Offshore wind levelized cost of energy"])).toEqual(["Bioenergy", "Offshore wind"]);
    expect(withoutSharedWords(["Share who say  yes", "Share who say no"])).toEqual(["Yes", "No"]);
    expect(withoutSharedWords(["cost of solar", "cost of wind"])).toEqual(["Solar", "Wind"]);
    expect(withoutSharedWords(["A total", "A total"])).toEqual(["A total", "A total"]);
    expect(withoutSharedWords(["Total cost", "Total"])).toEqual(["Total cost", "Total"]);
    expect(withoutSharedWords(["Only one name"])).toEqual(["Only one name"]);
    const meta = { columns: { a: { shortName: "a", title: "Solar cost" }, b: { shortName: "b", title: "Wind cost" } } };
    expect(owidToSpec("s", {}, "entity,year,a,b\nWorld,2020,1,2\n", meta, "2026-11-13").series.map((s) => s.name)).toEqual(["Solar", "Wind"]);
    expect(owidToSpec("s", {}, "entity,year,a\nChina cost,2020,1\nJapan cost,2020,2\n", {}, "2026-11-13").series.map((s) => s.name)).toEqual(["China cost", "Japan cost"]);
  });

  it("leads with, and on a scatter chart highlights, the entities a link selects, by name or code", () => {
    const csv = "entity,code,year,v\nChina,CHN,2020,1\nChina,CHN,2021,2\nJapan,JPN,2020,3\nJapan,JPN,2021,4\nKenya,KEN,2020,5\nKenya,KEN,2021,6\n";
    const config = { chartTypes: ["ScatterPlot"], selectedEntityNames: ["China"] };
    const spec = owidToSpec("s", config, csv, {}, "2026-11-13", { selection: ["KEN", "Japan"] });
    expect(spec.series.map((s) => s.name)).toEqual(["Kenya", "Japan", "China"]);
    expect(spec.highlight).toEqual(["Kenya", "Japan"]);
    expect(owidToSpec("s", config, csv, {}, "2026-11-13").highlight).toEqual(["China"]);
  });

  it("draws a stacked bar on a linear axis, and refuses a year out of range", () => {
    const bars = owidToSpec("s", { chartTypes: ["StackedBar"], yAxis: { scaleType: "log" } }, "entity,year,a\nX,2020,1\nX,2021,2\n", {}, "2026-11-13");
    expect(bars.y.scale).toBe("linear");
    expect(() => owidToSpec("s", {}, "entity,year,a\nX,20000,1\n", {}, "2026-11-13")).toThrow(/not a whole number in \[-10000, 10000\]/);
  });

  it("sets facets on stacked bars only", () => {
    const one = "entity,year,a\nX,2020,1\nX,2021,2\nY,2020,3\nY,2021,4\n";
    const facets = (chartTypes: string[]) => owidToSpec("s", { chartTypes, selectedFacetStrategy: "entity" }, one, {}, "2026-11-13").facets;
    expect(facets(["StackedBar"])).toBe(true);
    expect(facets(["LineChart"])).toBeUndefined();
  });
});
