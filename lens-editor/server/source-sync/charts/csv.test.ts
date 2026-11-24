import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { csvToSpec, number, parseCsv } from "./csv";
import { tableChart } from "./definition";
import { pointCount, specProblems } from "./spec";

describe("parseCsv", () => {
  it("reads quoted fields with commas, quotes and line breaks, CRLF lines, and skips empty lines", () => {
    expect(parseCsv('﻿a,b,c\r\n"x, y","say ""hi""","two\nlines"\n\n1,,3\nlast')).toEqual([
      ["a", "b", "c"],
      ["x, y", 'say "hi"', "two\nlines"],
      ["1", "", "3"],
      ["last"],
    ]);
  });

  it("reads numbers as Python's float() does, finite only", () => {
    expect([" 2.4e+25 ", "-.5", "7.", "23000"].map(number)).toEqual([2.4e25, -0.5, 7, 23000]);
    expect(["", "nan", "inf", "1e999", "0x10", "1,000"].map(number)).toEqual([null, null, null, null, null, null]);
  });
});

const EPOCH = "https://epoch.ai/data/notable_ai_models.csv";
const rows = (extra: Record<string, string> = {}) =>
  new Map(Object.entries({ source: EPOCH, x: "Publication date", y: "Training compute (FLOP)", series: "Domain", label: "Model", ...extra }));
const chartOf = (extra?: Record<string, string>) => tableChart(rows(extra)).chart!;

describe("csvToSpec: an Epoch AI dataset", () => {
  const text = readFileSync(join(import.meta.dirname, "__fixtures__", "epoch-notable-ai-models.csv"), "utf8");

  it("draws one series per first domain, points labelled by model, sorted by date, rows without compute left out", () => {
    const spec = csvToSpec(chartOf(), text, "2026-11-13");
    expect(specProblems(spec)).toEqual([]);
    expect(spec).toMatchObject({
      kind: "scatter",
      title: "Training compute (FLOP)",
      x: { type: "date" },
      y: { scale: "linear", unit: "", label: "Training compute (FLOP)" },
      credit: { data: "Epoch AI", licence: "CC BY 4.0", url: "https://epoch.ai/data/notable-ai-models", retrieved: "2026-11-13" },
    });
    expect(spec.series.map((s) => s.name)).toEqual(["Language", "Earth science", "Multimodal", "Biology", "Image generation", "Vision", "Games", "Other", "Robotics"]);
    expect(pointCount(spec)).toBe(18);
    expect(spec.series[0].points.slice(0, 2)).toEqual([
      ["1959-02-01", 600000000, "Pandemonium (morse)"],
      ["2022-06-29", 2.7415e24, "Minerva (540B)"],
    ]);
  });

  it("makes a year axis of whole numbers, one series without a series column, and says which column is missing", () => {
    const years = "Year,Value\n2001,3\n2000,2\nlater,9\n";
    const spec = csvToSpec(tableChart(new Map([["source", EPOCH], ["x", "Year"], ["y", "Value"], ["kind", "line"]])).chart!, years, "2026-11-13");
    expect(spec).toMatchObject({ kind: "line", x: { type: "year" }, series: [{ name: "Value", points: [[2000, 2], [2001, 3]] }] });
    expect(() => csvToSpec(chartOf({ y: "Compute" }), text, "2026-11-13")).toThrow(/no column "Compute"/);
    // A day that is not a real one leaves its row out, not the chart.
    const days = "Publication date,Training compute (FLOP),Domain,Model\n2021-02-30,1,Language,Bad\n2021-03-01,2,Language,Good\n2021-03-02,3,Language,Also good\n";
    expect(csvToSpec(chartOf(), days, "2026-11-13").series[0].points.map((p) => p[2])).toEqual(["Good", "Also good"]);
    expect(() => csvToSpec(chartOf(), "Publication date,Training compute (FLOP),Domain,Model\nsoon,1,a,b\n", "2026-11-13")).toThrow(/no dates/);
  });

  const full = process.env.OWID_PARITY_DIR && join(process.env.OWID_PARITY_DIR, "epoch", "notable_ai_models.csv");
  it.skipIf(!full || !existsSync(full))("draws the whole notable-models file within the limits", () => {
    const spec = csvToSpec(chartOf({ y_scale: "log" }), readFileSync(full as string, "utf8"), "2026-11-13");
    expect(specProblems(spec)).toEqual([]);
    expect(pointCount(spec)).toBeGreaterThan(500);
  });
});
