/**
 * ChartSpec v1: the JSON a chart file holds, which lens-platform draws in
 * place of a figure's still image. This repository writes it; the platform's
 * content processor (content_processor/src/parser/chart.ts there) checks it
 * again, strictly, and a file it refuses fails lens-edu-relay's CI. So
 * specProblems refuses at least what that processor refuses: unknown fields
 * at any level, days that are not real days, a chart with no points, and
 * the limits on the JSON as the file holds it (chartJson).
 *
 * Drawing rules (the platform's): `line` draws one line per series;
 * `scatter` draws x as time, a series with `line: true` as a dashed line and
 * the rest as dots, coloured and labelled when the series name or point
 * label is in `highlight`; `stacked-bar` stacks the series of each x
 * category (`stack: "relative"` scales each bar to 100%), or with `facets`
 * draws one small panel per series sharing the y range.
 */

export type ChartKind = "line" | "scatter" | "stacked-bar";
export const CHART_KINDS: readonly ChartKind[] = ["line", "scatter", "stacked-bar"];

/** A year (an integer in [-10000, 10000]), a day ("2021-01-14") or a quarter ("2014-Q2"), as `x.type` says. */
export type ChartX = number | string;

export interface ChartSpec {
  version: 1;
  kind: ChartKind;
  title: string;
  subtitle?: string;
  note?: string;
  x: { type: "year" | "date" | "quarter" };
  /** `log` on line and scatter charts only. */
  y: { type: "number"; scale: "linear" | "log"; unit: string; label?: string; min?: number; max?: number };
  /** In drawing and legend order. */
  series: ChartSeries[];
  /** Scatter only: series names or point labels drawn in colour and labelled. */
  highlight?: string[];
  /** Stacked-bar only. */
  stack?: "absolute" | "relative";
  /** Stacked-bar only: one small panel per series (OWID's small multiples). */
  facets?: true;
  credit: {
    data: string;
    licence: string;
    /** Where a reader goes for the original. */
    url: string;
    /** YYYY-MM-DD: when the data was fetched; it changes only when the data does. */
    retrieved: string;
  };
}

export interface ChartSeries {
  name: string;
  /** [x, y, point label?], sorted by x. */
  points: [ChartX, number, string?][];
  /** Scatter only: drawn as a connected line (OWID's trend lines). */
  line?: true;
}

/** Every part enforces these: the JSON's size in bytes, and counts over all series. */
export const CHART_LIMITS = { bytes: 200 * 1024, series: 1000, points: 5000 };

export const pointCount = (spec: ChartSpec): number => spec.series.reduce((n, s) => n + s.points.length, 0);

/**
 * A spec as a chart file holds it: one line of JSON in which a `{` before
 * `++`, `--`, `~~`, `>>` or `==`, and the second `%` of `%%`, are written as
 * \u escapes. The Lens Editor would read those as CriticMarkup suggestions
 * and comments, and nothing removes them from a chart file: it is data.
 * U+2028 and U+2029, which JSON.stringify leaves as they are, are escaped
 * too: they end a line for a JavaScript RegExp. JSON can hold none of these
 * outside a string, so the spec is unchanged.
 */
export const chartJson = (spec: ChartSpec): string =>
  JSON.stringify(spec)
    .replace(/\{(?=\+\+|--|~~|>>|==)/g, "\\u007b")
    .replace(/%%/g, "%\\u0025")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

/** A real day, "YYYY-MM-DD". */
export function isDay(v: unknown): boolean {
  const day = typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : null;
  return !!day && !Number.isNaN(day.getTime()) && day.toISOString().startsWith(v as string);
}

const X_FORMS: Record<string, (x: unknown) => boolean> = {
  year: (x) => Number.isInteger(x) && Math.abs(x as number) <= 10000,
  date: isDay,
  quarter: (x) => typeof x === "string" && /^\d{4}-Q[1-4]$/.test(x),
};
/** The fields of each object of a spec; any other is refused. */
const FIELDS = {
  spec: ["version", "kind", "title", "subtitle", "note", "x", "y", "series", "highlight", "stack", "facets", "credit"],
  x: ["type"],
  y: ["type", "scale", "unit", "label", "min", "max"],
  series: ["name", "points", "line"],
  credit: ["data", "licence", "url", "retrieved"],
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const optional = (v: unknown, check: (v: unknown) => boolean) => v === undefined || check(v);

/** Why a value is not a ChartSpec v1 within the limits, one line each; empty when it is. */
export function specProblems(value: unknown): string[] {
  if (!isObject(value)) return ["the chart is not a JSON object"];
  const problems: string[] = [];
  const unknown = (object: unknown, fields: string[], where: string) => {
    const extra = isObject(object) ? Object.keys(object).filter((key) => !fields.includes(key)) : [];
    if (extra.length) problems.push(`${where}has unknown field(s): ${extra.join(", ")}`);
  };
  const s = value;
  const kind = s.kind as ChartKind;
  unknown(s, FIELDS.spec, "the chart ");
  unknown(s.x, FIELDS.x, "x ");
  unknown(s.y, FIELDS.y, "y ");
  unknown(s.credit, FIELDS.credit, "credit ");
  if (s.version !== 1) problems.push("version must be 1");
  if (!CHART_KINDS.includes(kind)) problems.push(`kind must be one of ${CHART_KINDS.join(", ")}`);
  if (!isText(s.title)) problems.push("title must be text");
  for (const key of ["subtitle", "note"]) if (!optional(s[key], (v) => typeof v === "string")) problems.push(`${key} must be text`);

  const x = s.x;
  const xForm = isObject(x) ? X_FORMS[x.type as string] : undefined;
  if (!isObject(x) || !xForm) problems.push("x must be { type: year, date or quarter }");
  const y = s.y;
  const finite = (v: unknown) => Number.isFinite(v);
  if (
    !isObject(y) ||
    y.type !== "number" ||
    !["linear", "log"].includes(y.scale as string) ||
    typeof y.unit !== "string" ||
    !optional(y.label, (v) => typeof v === "string") ||
    !optional(y.min, finite) ||
    !optional(y.max, finite) ||
    (typeof y.min === "number" && typeof y.max === "number" && y.max <= y.min)
  ) {
    problems.push("y must be { type: number, scale: linear or log, unit, label?, min?, max? } with max above min");
  } else if (y.scale === "log" && kind === "stacked-bar") problems.push("y.scale may be log on line and scatter charts only");

  const series = Array.isArray(s.series) ? s.series : null;
  if (!series?.length) problems.push("series must be a non-empty list");
  for (const [i, one] of (series ?? []).entries()) {
    const at = `series[${i}]`;
    if (!isObject(one) || !isText(one.name) || !Array.isArray(one.points)) {
      problems.push(`${at} must be { name, points }`);
      continue;
    }
    unknown(one, FIELDS.series, `${at} `);
    if (one.line !== undefined && (one.line !== true || kind !== "scatter")) problems.push(`${at}.line may only be true, on a scatter chart`);
    let previous: unknown;
    for (const [j, point] of (one.points as unknown[]).entries()) {
      const ok =
        Array.isArray(point) &&
        (point.length === 2 || (point.length === 3 && typeof point[2] === "string")) &&
        (!xForm || xForm(point[0])) &&
        Number.isFinite(point[1]);
      if (!ok) {
        problems.push(`${at}.points[${j}] must be [x as x.type says, a finite y, label?]: ${JSON.stringify(point)}`);
        break;
      }
      if (j > 0 && (previous as number | string) > point[0]) {
        problems.push(`${at}.points are not sorted by x`);
        break;
      }
      previous = point[0];
    }
  }
  if (!optional(s.highlight, (v) => kind === "scatter" && Array.isArray(v) && v.every((name) => typeof name === "string"))) problems.push("highlight must be a list of names, on a scatter chart");
  if (!optional(s.stack, (v) => kind === "stacked-bar" && (v === "absolute" || v === "relative"))) problems.push("stack must be absolute or relative, on a stacked-bar chart");
  if (!optional(s.facets, (v) => kind === "stacked-bar" && v === true)) problems.push("facets may only be true, on a stacked-bar chart");

  const c = s.credit;
  if (
    !isObject(c) ||
    !isText(c.data) ||
    !isText(c.licence) ||
    !(typeof c.url === "string" && /^https:\/\/\S+$/.test(c.url)) ||
    !isDay(c.retrieved)
  ) {
    problems.push("credit must be { data, licence, url (https), retrieved (YYYY-MM-DD) }");
  }

  if (problems.length) return problems;
  const spec = value as unknown as ChartSpec;
  if (!pointCount(spec)) problems.push("the chart has no points");
  const bytes = Buffer.byteLength(chartJson(spec));
  if (bytes > CHART_LIMITS.bytes) problems.push(`the chart is ${Math.ceil(bytes / 1024)} KB of JSON, over the ${CHART_LIMITS.bytes / 1024} KB limit`);
  if (spec.series.length > CHART_LIMITS.series) problems.push(`the chart has ${spec.series.length} series, over the limit of ${CHART_LIMITS.series}`);
  if (pointCount(spec) > CHART_LIMITS.points) problems.push(`the chart has ${pointCount(spec)} points, over the limit of ${CHART_LIMITS.points}`);
  return problems;
}
