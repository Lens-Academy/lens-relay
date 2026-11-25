/**
 * What a figure of a Doc says about its chart, before anything is fetched:
 * where the data comes from, how to draw it, and the chart file's id.
 *
 * Two kinds of figure have one:
 *   - an `iframe` table whose src is an OWID grapher page draws that chart,
 *     with the id `owid-<slug>`. Of its query only two parameters count:
 *     `tab=map` (OWID's map, which Lens does not draw: no chart), and
 *     `country=a~b`, the entities it shows, which the data is read for and
 *     which lead the series (and are highlighted on a scatter chart);
 *   - a `chart` table names its source (an OWID grapher page, or a CSV file
 *     on an allowed host) and how to draw it. Its id is its `id` row, else
 *     `<host word>-<dataset>-<first 8 hex of the definition's hash>`, so a
 *     changed definition is a new chart file.
 * Only https links to ALLOWED_HOSTS are ever fetched.
 */

import { createHash } from "node:crypto";
import { CHART_KINDS, type ChartKind } from "./spec";

/** The hosts chart data is fetched from, with the word ids start with and the name credits give. */
export const ALLOWED_HOSTS: Record<string, { word: string; name: string }> = {
  "ourworldindata.org": { word: "owid", name: "Our World in Data" },
  "epoch.ai": { word: "epoch", name: "Epoch AI" },
};

export const CHART_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OWID = "https://ourworldindata.org/grapher";
/** What an OWID chart shows: its data as the chart filters it, with the columns' short names. */
export const OWID_QUERY = "v=1&csvType=filtered&useColumnShortNames=true";

/** The `chart` table's rows that shape the chart. */
export interface ChartRows {
  /** CSV only (default scatter). */
  kind?: ChartKind;
  /** CSV only: the columns of x, y, the series a row belongs to, and its point's label. */
  x?: string;
  y?: string;
  series?: string;
  label?: string;
  /** Names separated by ";" in the Doc; honoured on scatter charts. */
  highlight?: string[];
  yScale?: "linear" | "log";
  title?: string;
}

/** An OWID chart: its slug, and the entities its link selects (names or codes), in order; none for the chart's own selection. */
export interface OwidSource {
  owid: string;
  selection?: string[];
}

export interface ChartDefinition {
  id: string;
  source: OwidSource | { csv: string };
  rows: ChartRows;
  /** sha256 (hex) of the source and the shaping rows: another definition has another. */
  hash: string;
}

/** The chart table's rows that make up its definition, in hash order. */
const ROW_KEYS = ["kind", "x", "y", "series", "label", "highlight", "y_scale", "title"] as const;

/**
 * An https URL on an allowed host, normalised; null for anything else. It
 * may hold no braces or `%%`: it is written into a chart file, which must
 * hold no CriticMarkup or comment (file.ts).
 */
export function allowedUrl(text: string): URL | null {
  try {
    const url = new URL(text.trim());
    const ok = url.protocol === "https:" && !url.username && !url.password && !url.port && Object.hasOwn(ALLOWED_HOSTS, url.hostname) && !/[{}]|%%/.test(url.href);
    return ok ? url : null;
  } catch {
    return null;
  }
}

/** An OWID grapher page ("https://ourworldindata.org/grapher/<slug>?country=a~b&tab=map") read, or null for any other link. */
function grapher(url: URL): { source: OwidSource; map: boolean } | null {
  const slug = url.hostname === "ourworldindata.org" ? /^\/grapher\/([^/.]+)\/?$/.exec(url.pathname)?.[1] : undefined;
  if (!slug || !CHART_ID.test(slug)) return null;
  const selection = url.searchParams.get("country")?.split("~").filter(Boolean) ?? [];
  return { source: { owid: slug, ...(selection.length ? { selection } : {}) }, map: url.searchParams.get("tab") === "map" };
}

/** The `country=` parameter of a selection, as OWID reads it. */
const countryParam = (selection: string[]) => `country=${selection.map(encodeURIComponent).join("~")}`;

/** What identifies a source in a definition's hash: a chart's page (with its selection), or a CSV file. */
const sourceKey = (source: ChartDefinition["source"]) =>
  "owid" in source ? `${OWID}/${source.owid}${source.selection ? `?${countryParam(source.selection)}` : ""}` : source.csv;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The chart an iframe's src draws: an OWID grapher page that is not its map; null for any other embed. */
export function iframeChart(src: string): ChartDefinition | null {
  const url = allowedUrl(src);
  const page = url && grapher(url);
  if (!page || page.map) return null;
  const { source } = page;
  return { id: `owid-${source.owid}`, source, rows: {}, hash: sha256(JSON.stringify([sourceKey(source)])) };
}

/** A `chart` table's definition from its rows' text (lower-case keys), and what is wrong with it. */
export function tableChart(rows: Map<string, string>): { chart: ChartDefinition | null; problems: string[] } {
  const problems: string[] = [];
  const given = (key: string) => rows.get(key)?.trim() || undefined;
  const sourceText = given("source");
  const url = sourceText ? allowedUrl(sourceText) : null;
  if (!url) {
    const hosts = Object.keys(ALLOWED_HOSTS).join(" or ");
    return { chart: null, problems: [sourceText ? `its source ${sourceText} is not an https link to ${hosts}` : `a chart table needs a source row: an OWID chart, or a CSV file on ${hosts}`] };
  }
  const page = grapher(url);
  if (page?.map) return { chart: null, problems: [`its source ${sourceText} is OWID's map of the chart, which Lens does not draw; link the chart's line or bar view`] };
  const slug = page?.source.owid;
  const source = page?.source ?? { csv: url.href };

  const out: ChartRows = {};
  for (const key of ["x", "y", "series", "label", "title"] as const) if (given(key)) out[key] = given(key);
  const kind = given("kind")?.toLowerCase() as ChartKind | undefined;
  if (kind && !CHART_KINDS.includes(kind)) return { chart: null, problems: [`its kind "${given("kind")}" is not one of ${CHART_KINDS.join(", ")}`] };
  if (kind) out.kind = kind;
  const yScale = given("y_scale")?.toLowerCase();
  if (yScale && yScale !== "log" && yScale !== "linear") return { chart: null, problems: [`its y_scale "${given("y_scale")}" is not log or linear`] };
  if (yScale) out.yScale = yScale as ChartRows["yScale"];
  const highlight = given("highlight")?.split(";").map((name) => name.trim()).filter(Boolean);
  if (highlight?.length) out.highlight = highlight;
  if (slug) {
    const csvOnly = (["kind", "x", "y", "series", "label"] as const).filter((key) => out[key]);
    if (csvOnly.length) problems.push(`the rows ${csvOnly.join(", ")} apply to a CSV source only; an OWID chart is drawn as OWID draws it`);
    for (const key of csvOnly) delete out[key];
  } else if (!out.x || !out.y) {
    return { chart: null, problems: ["a chart of a CSV file needs x and y rows, naming its columns"] };
  }

  const hash = sha256(JSON.stringify([sourceKey(source), ...ROW_KEYS.map((key) => given(key) ?? "")]));
  const named = given("id");
  if (named && !CHART_ID.test(named)) return { chart: null, problems: [`its id "${named}" is not lower-case letters and digits joined by "-"`] };
  const dataset = slug ?? (url.pathname.split("/").pop() ?? "").replace(/\.[^.]*$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const id = named ?? [ALLOWED_HOSTS[url.hostname].word, dataset, hash.slice(0, 8)].filter(Boolean).join("-");
  return { chart: { id, source, rows: out, hash }, problems };
}

/** Where the chart's data is read: the file a chart file's `source` names. */
export function dataUrl({ source }: ChartDefinition): string {
  if (!("owid" in source)) return source.csv;
  return `${OWID}/${source.owid}.csv?${OWID_QUERY}${source.selection ? `&${countryParam(source.selection)}` : ""}`;
}

/**
 * Where a reader goes for the original (credit.url, and a chart table's
 * "Open the interactive version" link): the OWID chart; for an Epoch CSV
 * `https://epoch.ai/data/<dataset>.csv`, its page `https://epoch.ai/data/<data-set>`;
 * else the CSV itself.
 */
export function pageUrl(chart: ChartDefinition): string {
  if ("owid" in chart.source) return `${OWID}/${chart.source.owid}`;
  const epoch = /^https:\/\/epoch\.ai\/data\/([\w-]+)\.csv$/.exec(chart.source.csv);
  return epoch ? `https://epoch.ai/data/${epoch[1].replace(/_/g, "-")}` : chart.source.csv;
}

/** The name of whoever publishes the chart's data ("Our World in Data", "Epoch AI"). */
export const publisherOf = (chart: ChartDefinition): string => ALLOWED_HOSTS[new URL(dataUrl(chart)).hostname].name;
