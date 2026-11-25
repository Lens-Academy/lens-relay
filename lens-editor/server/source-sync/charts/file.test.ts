import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { iframeChart } from "./definition";
import { chartFileText, parseChartFile } from "./file";
import type { ChartSpec } from "./spec";

const SLUG = "annual-industrial-robots-installed";
const chart = iframeChart(`https://ourworldindata.org/grapher/${SLUG}`)!;
const spec: ChartSpec = JSON.parse(readFileSync(join(import.meta.dirname, "__fixtures__", "specs", `owid-${SLUG}.json`), "utf8"));

describe("chart files", () => {
  it("are written as the contract shows, and read back to the same spec", () => {
    const text = chartFileText(chart, spec, "AI Safety Atlas");
    expect(text).toBe(
      [
        "---",
        `id: "owid-${SLUG}"`,
        `source: https://ourworldindata.org/grapher/${SLUG}.csv?v=1&csvType=filtered&useColumnShortNames=true`,
        "retrieved: 2026-11-13",
        "---",
        "",
        "Chart data for the AI Safety Atlas, written by the Atlas sync from Our World in Data. A change made here is overwritten.",
        "",
        "```json",
        JSON.stringify(spec),
        "```",
        "",
      ].join("\n"),
    );
    expect(parseChartFile(text, chart.id)).toEqual(spec);
  });

  it("hold no CriticMarkup or %% comment, in the JSON or the line of text", () => {
    const marked = { ...spec, note: "{++added++} and 50%% {==this==}" };
    const text = chartFileText(chart, marked, "Atlas {--x--} 100%%");
    expect(text).not.toMatch(/\{(\+\+|--|~~|>>|==)|%%/);
    expect(text).toContain("Chart data for the Atlas --x-- 100, written");
    expect(parseChartFile(text, chart.id)).toEqual(marked);
  });

  it("read back ids that YAML would take for numbers or booleans, and text with U+2028 and U+2029", () => {
    for (const id of ["2024", "1e5", "true", "null"]) {
      const named = { ...chart, id };
      expect(parseChartFile(chartFileText(named, spec, "AI Safety Atlas"), id)).toEqual(spec);
    }
    const separated = { ...spec, note: "one\u2028two\u2029three" };
    const text = chartFileText(chart, separated, "AI Safety Atlas");
    expect(text).not.toMatch(/[\u2028\u2029]/);
    expect(parseChartFile(text, chart.id)).toEqual(separated);
  });

  it("are refused when anything is off", () => {
    const text = chartFileText(chart, spec, "AI Safety Atlas");
    const refused = (changed: string, id = chart.id) => () => parseChartFile(changed, id);
    expect(refused(text, "owid-other")).toThrow(/not its file name/);
    expect(refused(text.replace("retrieved: 2026-11-13", "retrieved: 2026-11-12"))).toThrow(/not its chart's credit.retrieved/);
    expect(refused(text.replace(/^source: .*\n/m, ""))).toThrow(/has the fields id, retrieved, not id, source and retrieved/);
    expect(refused(`${text}\n\`\`\`json\n{}\n\`\`\`\n`)).toThrow(/exactly one/);
    expect(refused(text.replace('"version":1', '"version":1,'))).toThrow(/does not parse/);
    expect(refused(text.replace('"kind":"line"', '"kind":"pie"'))).toThrow(/not a valid chart: kind/);
    expect(refused(text.replace("retrieved:", "note: x\nretrieved:"))).toThrow(/fields id, note, retrieved, source/);
    expect(refused(text.replace(/^source: .*$/m, "source: ftp://x"))).toThrow(/not a web address/);
    expect(refused(`${text}\n~~~\nmore\n~~~\n`)).toThrow(/exactly one code block/);
    expect(refused(text.replace('{"version":1,', '{"version": 1,'))).toThrow(/not written as the sync writes it/);
  });
});
