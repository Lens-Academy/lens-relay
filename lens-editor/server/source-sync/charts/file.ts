/**
 * A chart file, `charts/<course folder>/<id>.md` in Lens Edu: frontmatter
 * (`id`, the file's stem; `source`, the data file read; `retrieved`, the
 * spec's credit.retrieved), a line for whoever opens it, and the ChartSpec
 * as one line of JSON (chartJson) in the body's only code block. lens-platform
 * reads it with the same rules, and removes no CriticMarkup or `%%` comment
 * from it, so the file holds neither (spec.ts chartJson; braces and `%` are
 * kept out of the line of text). When the sync writes one: refresh.ts.
 */

import { yamlQuote } from "../../yaml";
import { splitFrontmatter } from "../iliad/module-file";
import { CHART_ID, dataUrl, publisherOf, type ChartDefinition } from "./definition";
import { chartJson, specProblems, type ChartSpec } from "./spec";

export function chartFileText(chart: ChartDefinition, spec: ChartSpec, courseTitle: string): string {
  return [
    "---",
    // Quoted: an id such as "2024", "1e5" or "true" would read back as a number or a boolean.
    `id: ${yamlQuote(chart.id)}`,
    `source: ${dataUrl(chart)}`,
    `retrieved: ${spec.credit.retrieved}`,
    "---",
    "",
    `Chart data for the ${courseTitle.replace(/[{}%]/g, "")}, written by the Atlas sync from ${publisherOf(chart)}. A change made here is overwritten.`,
    "",
    "```json",
    chartJson(spec),
    "```",
    "",
  ].join("\n");
}

/** A chart file's spec, read back; throws what is wrong with the file. `id` is its file's stem. */
export function parseChartFile(text: string, id: string): ChartSpec {
  const { data, body } = splitFrontmatter(text);
  const fields = Object.keys(data).sort().join(", ");
  if (fields !== "id, retrieved, source") throw new Error(`its frontmatter has the fields ${fields || "none"}, not id, source and retrieved`);
  if (data.id !== id || !CHART_ID.test(id)) throw new Error(`its id is ${JSON.stringify(data.id)}, not its file name, "${id}"`);
  if (typeof data.source !== "string" || !/^https?:\/\/\S+$/.test(data.source)) throw new Error("its source is not a web address");
  // Lines end at "\n" only, as the platform reads them (a RegExp's ^ and $ would also end one at U+2028).
  const lines = body.split("\n");
  const open = lines.indexOf("```json");
  const json = lines[open + 1];
  if (open < 0 || lines[open + 2] !== "```" || lines.filter((line) => /^ {0,3}(`{3,}|~{3,})/.test(line)).length !== 2) {
    throw new Error("its body must hold exactly one code block, a ```json one with the chart on one line");
  }
  let spec: unknown;
  try {
    spec = JSON.parse(json);
  } catch (err) {
    throw new Error(`its JSON does not parse: ${(err as Error).message}`);
  }
  const problems = specProblems(spec);
  if (problems.length) throw new Error(`it is not a valid chart: ${problems.join("; ")}`);
  // What specProblems measured against the limits is what the file holds.
  if (json !== chartJson(spec as ChartSpec)) throw new Error("its JSON is not written as the sync writes it");
  const retrieved = (spec as ChartSpec).credit.retrieved;
  if (String(data.retrieved) !== retrieved) throw new Error(`its retrieved (${String(data.retrieved)}) is not its chart's credit.retrieved (${retrieved})`);
  return spec as ChartSpec;
}
