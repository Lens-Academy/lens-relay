/**
 * CSV text -> records, and a CSV file named by a Doc `chart` table (Epoch
 * AI's data) -> a ChartSpec.
 */

import { pageUrl, publisherOf, type ChartDefinition } from "./definition";
import { isDay, type ChartSeries, type ChartSpec, type ChartX } from "./spec";

/**
 * Records as Python's csv module reads them (OWID's and Epoch's files are
 * written so): a field that starts with `"` is quoted and may hold commas,
 * line breaks and `""` for a quote; empty lines are skipped.
 */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  const end = () => {
    record.push(field);
    if (record.length > 1 || field !== "") records.push(record);
    record = [];
    field = "";
  };
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') field += text[i++];
      else quoted = false;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      record.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      end();
    } else field += c;
  }
  if (field !== "" || record.length) end();
  return records;
}

/** A finite number written as decimal text (as Python's float() reads it), or null. */
export function number(text: string | undefined): number | null {
  const t = text?.trim() ?? "";
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return null;
  const value = Number(t);
  return Number.isFinite(value) ? value : null;
}

const isYear = (x: string) => /^-?\d+$/.test(x) && Math.abs(Number(x)) <= 10000;

/** Points in x order (years are numbers; dates and quarters sort as text). */
export const byX = (a: [ChartX, ...unknown[]], b: [ChartX, ...unknown[]]): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

/**
 * The chart table's CSV (its title, y scale and highlight are laid over by
 * fetch.ts, as on an OWID chart): rows with an x and a finite y, x a real
 * day (YYYY-MM-DD) or else a year in [-10000, 10000], any other row left
 * out; one series per value of the `series` column
 * (its first item: "Language,Vision" is "Language"; "Other" when empty), or
 * one named after the y column; the `label` column labels each point.
 */
export function csvToSpec(chart: ChartDefinition, text: string, retrieved: string): ChartSpec {
  const { rows } = chart;
  const [head = [], ...records] = parseCsv(text);
  const column = (name: string | undefined) => {
    if (name === undefined) return -1;
    const i = head.findIndex((h) => h.trim() === name);
    if (i < 0) throw new Error(`the CSV has no column "${name}"; its columns are ${head.slice(0, 12).join(", ")}${head.length > 12 ? ", …" : ""}`);
    return i;
  };
  const [xi, yi, si, li] = [rows.x, rows.y, rows.series, rows.label].map(column);
  const xs = records.map((r) => r[xi]?.trim() ?? "");
  const type = xs.some(isDay) ? "date" : xs.some(isYear) ? "year" : null;
  if (!type) throw new Error(`the column "${rows.x}" holds no dates (YYYY-MM-DD) or years`);

  const series = new Map<string, ChartSeries["points"]>();
  for (const [n, record] of records.entries()) {
    const y = number(record[yi]);
    if (y === null || !(type === "date" ? isDay(xs[n]) : isYear(xs[n]))) continue;
    const name = si < 0 ? rows.y! : record[si]?.split(",")[0].trim() || "Other";
    const x = type === "year" ? Number(xs[n]) : xs[n];
    const label = li < 0 ? "" : (record[li]?.trim() ?? "");
    if (!series.has(name)) series.set(name, []);
    series.get(name)!.push(label ? [x, y, label] : [x, y]);
  }
  const kind = rows.kind ?? "scatter";
  return {
    version: 1,
    kind,
    title: rows.y!,
    x: { type },
    y: { type: "number", scale: "linear", unit: "", label: rows.y! },
    series: [...series].map(([name, points]) => ({ name, points: points.sort(byX) })),
    ...(kind === "stacked-bar" ? { stack: "absolute" as const } : {}),
    credit: { data: publisherOf(chart), licence: "CC BY 4.0", url: pageUrl(chart), retrieved },
  };
}
