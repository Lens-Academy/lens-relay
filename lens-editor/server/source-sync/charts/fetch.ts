/**
 * Reading a chart's data over the network: only https links to the allowed
 * hosts (definition.ts ALLOWED_HOSTS), every redirect checked the same way,
 * 30 s and 10 MB at most per file, one request every 2 s at most, and a
 * plain User-Agent that says who asks.
 */

import { bytesToText, fetchBytesWithTimeout } from "../../fetch-timeout";
import { csvToSpec } from "./csv";
import { allowedUrl, dataUrl, OWID_QUERY, type ChartDefinition } from "./definition";
import { owidKind, owidToSpec, type OwidConfig, type OwidMetadata } from "./owid";
import type { ChartSpec } from "./spec";

const TIMEOUT_MS = 30_000;
export const MAX_CHART_BYTES = 10 * 1024 * 1024;
const USER_AGENT = "LensAcademy-atlas-sync/1.0 (+https://lensacademy.org)";
const GAP_MS = 2_000;
const MAX_REDIRECTS = 3;

/** The source answered 404 (the chart is retired) or 403 (its data may not be downloaded), after any redirects. */
export class Gone extends Error {}

/**
 * The text of a file of chart data; throws with the URL and why when it
 * cannot be had. An abort of `signal` stops the request, and throws its reason.
 */
export type ChartFetch = (url: string, signal?: AbortSignal) => Promise<string>;

export function chartFetch({ gapMs = GAP_MS, fetchBytes = fetchBytesWithTimeout } = {}): ChartFetch {
  let last = 0;
  return async (first, signal) => {
    let url = first;
    for (let redirects = 0; ; redirects++) {
      if (!allowedUrl(url)) throw new Error(`${url} is not an https link to an allowed host`);
      const wait = last + gapMs - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      signal?.throwIfAborted();
      last = Date.now();
      let resp;
      try {
        resp = await fetchBytes(url, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_CHART_BYTES, headers: { "User-Agent": USER_AGENT }, signal });
      } catch (err) {
        if (signal?.aborted) throw signal.reason;
        throw new Error(`${url}: ${(err as Error).message}`);
      }
      const location = resp.headers.get("location");
      if (resp.status >= 300 && resp.status < 400 && location && redirects < MAX_REDIRECTS) {
        url = new URL(location, url).href;
        continue;
      }
      if (!resp.ok) throw new (resp.status === 404 || resp.status === 403 ? Gone : Error)(`${url} answered ${resp.status}`);
      return bytesToText(resp.bytes);
    }
  };
}

/**
 * Fetch and convert a chart, with the chart table's `title`, `y_scale` (a
 * stacked bar stays linear) and, on a scatter chart, `highlight` laid over
 * what the source gives.
 * An OWID chart is three files, read in turn: its config (a map stops
 * there), its data, its data's metadata.
 */
export async function fetchSpec(chart: ChartDefinition, get: ChartFetch, retrieved: string): Promise<ChartSpec> {
  let spec: ChartSpec;
  if ("owid" in chart.source) {
    const base = `https://ourworldindata.org/grapher/${chart.source.owid}`;
    const config = JSON.parse(await get(`${base}.config.json`)) as OwidConfig;
    const kind = owidKind(config);
    const csv = await get(dataUrl(chart));
    const metadata = JSON.parse(await get(`${base}.metadata.json?${OWID_QUERY}`)) as OwidMetadata;
    spec = owidToSpec(chart.source.owid, config, csv, metadata, retrieved, { kind, selection: chart.source.selection });
  } else {
    spec = csvToSpec(chart, await get(dataUrl(chart)), retrieved);
  }
  const { title, yScale, highlight } = chart.rows;
  if (title) spec.title = title;
  if (yScale && (yScale === "linear" || spec.kind !== "stacked-bar")) spec.y.scale = yScale;
  if (highlight && spec.kind === "scatter") {
    const names = new Set(spec.series.flatMap((s) => [s.name, ...s.points.flatMap((p) => p[2] ?? [])]));
    spec.highlight = highlight.filter((name) => names.has(name));
  }
  return spec;
}
