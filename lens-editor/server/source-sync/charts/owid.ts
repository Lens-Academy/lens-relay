/**
 * An Our World in Data chart -> a ChartSpec: its grapher config, its data as
 * the chart filters it (`<slug>.csv?v=1&csvType=filtered&useColumnShortNames=true`)
 * and that data's metadata. A port of the reference converter the contract
 * was proven with on the Atlas's 13 OWID charts (owid_to_spec.py); its
 * output is the same JSON, field for field. One change: `facets` is set on
 * stacked bars only, the one kind the platform draws in panels. A selection
 * (the `country=` of the figure's link, by entity name or code) replaces the
 * config's selectedEntityNames.
 *
 * A chart this cannot draw (a map, a chart type with no ChartSpec kind,
 * several value columns of several entities) throws, and the figure keeps
 * its still image.
 */

import { byX, number, parseCsv } from "./csv";
import type { ChartKind, ChartSeries, ChartSpec } from "./spec";

/** The parts of a grapher config the converter reads. */
export interface OwidConfig {
  chartTypes?: string[];
  tab?: string;
  title?: string;
  subtitle?: string;
  note?: string;
  sourceDesc?: string;
  selectedEntityNames?: string[];
  selectedFacetStrategy?: string;
  stackMode?: string;
  yAxis?: { scaleType?: string; label?: string; min?: unknown; max?: unknown };
}

interface OwidColumn {
  shortName?: string;
  title?: string;
  titleShort?: string;
  shortUnit?: string;
  unit?: string;
  citationShort?: string;
}

export interface OwidMetadata {
  chart?: { title?: string };
  columns?: Record<string, OwidColumn>;
}

const KINDS: Record<string, ChartKind> = { LineChart: "line", SlopeChart: "line", ScatterPlot: "scatter", StackedBar: "stacked-bar" };
const X_COLUMNS: Record<string, ChartSpec["x"]["type"]> = { year: "year", day: "date", quarter: "quarter" };

/** The chart's kind: its first chart type, or the line or slope chart its default tab shows. Throws for a map or a type with no kind. */
export function owidKind(config: OwidConfig): ChartKind {
  const tab = config.tab;
  const first = tab === "line" ? "LineChart" : tab === "slope" ? "SlopeChart" : (config.chartTypes?.[0] ?? "LineChart");
  if (tab === "map" || !Object.hasOwn(KINDS, first)) throw new Error(`OWID shows it as a ${tab === "map" ? "map" : first}, which Lens does not draw`);
  return KINDS[first];
}

/**
 * Names made from column titles drop the whole words they all share at the
 * start and end, and begin with a capital, as OWID shows them ("Bioenergy
 * levelized cost of energy", "Geothermal levelized cost of energy" ->
 * "Bioenergy", "Geothermal"); unchanged when a name would be left empty or
 * two would be the same.
 */
export function withoutSharedWords(names: string[]): string[] {
  if (names.length < 2) return names;
  const words = names.map((name) => name.split(/\s+/).filter(Boolean));
  const [first] = words;
  let lead = 0;
  while (words.every((w) => w.length > lead && w[lead] === first[lead])) lead++;
  let tail = 0;
  while (words.every((w) => w.length > lead + tail && w[w.length - 1 - tail] === first[first.length - 1 - tail])) tail++;
  const trimmed = words.map((w) => w.slice(lead, w.length - tail).join(" "));
  if (trimmed.some((name) => !name) || new Set(trimmed).size < trimmed.length) return names;
  return trimmed.map((name) => name[0].toUpperCase() + name.slice(1));
}

/** OWID writes `[label](#dod:term)` and Markdown links in subtitles and notes. */
const withoutLinks = (text = ""): string => text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim();

export function owidToSpec(
  slug: string,
  config: OwidConfig,
  csv: string,
  metadata: OwidMetadata,
  retrieved: string,
  { kind = owidKind(config), selection }: { kind?: ChartKind; selection?: string[] } = {},
): ChartSpec {
  const [head = [], ...records] = parseCsv(csv);
  if (!records.length) throw new Error("OWID's data has no rows");
  const xi = head.findIndex((h) => Object.hasOwn(X_COLUMNS, h));
  if (xi < 0 || head[0] !== "entity") throw new Error(`OWID's data has the columns ${head.join(", ")}, not entity, a year, day or quarter, and values`);
  const xType = X_COLUMNS[head[xi]];
  const values = head.flatMap((h, i) => (h === "entity" || h === "code" || i === xi ? [] : [i]));
  const entities = new Set(records.map((r) => r[0]));
  const columns = Object.values(metadata.columns ?? {});
  const columnName = (short: string) => {
    const info = columns.find((c) => c.shortName === short);
    return info?.titleShort || info?.title || short.replaceAll("_", " ");
  };
  const xOf = (text: string) => {
    if (xType !== "year") return text;
    const year = /^\s*[+-]?\d+\s*$/.test(text) ? Number(text) : Number.NaN;
    if (!(Math.abs(year) <= 10000)) throw new Error(`OWID's data has the year "${text}", not a whole number in [-10000, 10000]`);
    return year;
  };

  // One series per entity of the one value column, or per value column of the one entity.
  let series = new Map<string, ChartSeries["points"]>();
  const add = (name: string, record: string[], i: number) => {
    const y = number(record[i]);
    if (y === null) return;
    if (!series.has(name)) series.set(name, []);
    series.get(name)!.push([xOf(record[xi]), y]);
  };
  if (values.length === 1) for (const record of records) add(record[0], record, values[0]);
  else if (entities.size === 1) for (const i of values) for (const record of records) add(columnName(head[i]), record, i);
  else throw new Error(`OWID's data has ${values.length} value columns for ${entities.size} entities, which Lens does not draw`);
  if (values.length > 1) {
    const points = [...series.values()];
    series = new Map(withoutSharedWords([...series.keys()]).map((name, i) => [name, points[i]]));
  }

  const codes = head[1] === "code" ? new Map(records.map((r) => [r[1], r[0]])) : new Map<string, string>();
  const chosen = selection?.map((entity) => codes.get(entity) ?? entity) ?? config.selectedEntityNames ?? [];
  const selected = [...new Set(chosen)].filter((name) => series.has(name));
  const order = [...selected, ...[...series.keys()].filter((name) => !selected.includes(name))];
  const first = columns[0] ?? {};
  const yAxis = config.yAxis ?? {};
  const { min, max } = yAxis;
  const subtitle = withoutLinks(config.subtitle);
  const note = withoutLinks(config.note);
  return {
    version: 1,
    kind,
    title: config.title || metadata.chart?.title || slug,
    ...(subtitle && { subtitle }),
    ...(note && { note }),
    x: { type: xType },
    y: {
      type: "number",
      scale: yAxis.scaleType === "log" && kind !== "stacked-bar" ? "log" : "linear",
      unit: first.shortUnit || first.unit || "",
      ...(yAxis.label && { label: yAxis.label }),
      // A max of 0 makes OWID ignore the min; a max at or below the min is ignored.
      ...(typeof min === "number" && (max ?? 1) !== 0 && { min }),
      ...(typeof max === "number" && max > (typeof min === "number" ? min : 0) && { max }),
    },
    series: order.map((name) => ({
      name,
      points: series.get(name)!.sort(byX),
      ...(kind === "scatter" && series.get(name)!.length > 1 && { line: true as const }),
    })),
    ...(kind === "scatter" && { highlight: selected }),
    ...(kind === "stacked-bar" && { stack: config.stackMode === "relative" ? ("relative" as const) : ("absolute" as const) }),
    // OWID's small multiples: one panel per entity.
    ...(kind === "stacked-bar" && config.selectedFacetStrategy === "entity" && values.length === 1 && series.size > 1 && { facets: true as const }),
    credit: {
      data: config.sourceDesc || first.citationShort || "Our World in Data",
      licence: "CC BY 4.0",
      url: `https://ourworldindata.org/grapher/${slug}`,
      retrieved,
    },
  };
}
