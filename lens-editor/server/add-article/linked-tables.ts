import { JSDOM } from "jsdom";
import { extractHtmlMeta, looksLikeBotWall } from "./fetch";

/**
 * Tables whose cells are not on the article's page. Springer Nature journals
 * show a caption and a "Full size table" link to a page of its own; sites
 * embedding Datawrapper show an iframe. Extraction sees neither, so the table
 * was lost and the text around it ("see Table 1") pointed at nothing.
 *
 * This runs on the fetched HTML, before extraction: each table is fetched and
 * put where the link or iframe was, so every candidate extraction and the
 * reviewer's source evidence hold the same table. A table that cannot be
 * fetched leaves the page as it was and is reported; it never fails an import.
 * A page with neither kind of table comes back untouched, byte for byte.
 */

export interface LinkedTableFetchers {
  /** The URL's text, fetched directly. */
  fetchDirect: (url: string, signal?: AbortSignal) => Promise<string>;
  /** The URL's rendered HTML, for sites that wall off direct fetches. */
  fetchRendered: (url: string, signal?: AbortSignal) => Promise<string>;
}

export interface InlinedTables {
  html: string;
  inlined: string[];
  failed: string[];
}

/** Fetched tables by URL, shared by the fetches of one article so that the
 *  raw and the rendered page do not fetch each table twice. Holds the table's
 *  HTML, or "" for an embed that is not a table. */
export type LinkedTableCache = Map<string, Promise<string>>;

const HINT_RE = /data-test=["']table-link["']|datawrapper\.dwcdn\.net/i;
const DATAWRAPPER_HOST = "datawrapper.dwcdn.net";
const MAX_TABLES = 40;
/** Time limit for one page's tables; what is unfinished then stays as it was. */
const TIME_LIMIT_MS = 120_000;

interface TableSlot {
  url: string;
  /** The element the table replaces. */
  holder: Element;
  load: (signal: AbortSignal) => Promise<string>;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** The delimiter of a CSV's header line, ignoring quoted cells. A tab is never
 *  part of a value, so one settles it. */
function csvDelimiter(text: string): string {
  const header = text.split("\n", 1)[0].replace(/"[^"]*"/g, "");
  if (header.includes("\t")) return "\t";
  return header.split(";").length > header.split(",").length ? ";" : ",";
}

/** RFC 4180 rows: quoted cells may hold delimiters, newlines and doubled quotes. */
export function parseCsv(csv: string): string[][] {
  const text = csv.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const delimiter = csvDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else quoted = false;
    } else if (c === '"' && !cell) quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      rows.push([...row, cell]);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows.filter((r) => r.some((value) => value.trim()));
}

const TAG_RE = /<(\/?)([a-z][a-z0-9]*)(?:\s[^<>]*)?\/?>/gi;
/** The tags worth keeping in a cell, without their attributes. The rest would
 *  fail the Lens validator as stray HTML, so their text stays and they go. */
const CELL_TAGS = new Set(["b", "strong", "i", "em", "u", "sup", "sub", "p", "div", "span"]);

function cellTag(tag: string, closing: string, name: string): string {
  const lower = name.toLowerCase();
  if (lower === "br") return "<br>";
  if (lower === "a") {
    if (closing) return "</a>";
    const href = tag.match(/\shref="(https?:[^"<>]*)"/i)?.[1];
    return href ? `<a href="${href.replace(/\|/g, "%7C")}">` : "";
  }
  return CELL_TAGS.has(lower) ? `<${closing}${lower}>` : "";
}

/** Literal text of a cell. `[a][b]` reads as an undefined Markdown reference to
 *  the Lens validator, escaped or not, so the brackets get a space between them. */
function cellText(text: string): string {
  return escapeHtml(text.replace(/\]\[/g, "] ["));
}

/** A cell's text as HTML: its own markup, cleaned, and everything else as typed. */
function cellContent(text: string): string {
  let html = "";
  let last = 0;
  for (const match of text.matchAll(TAG_RE)) {
    html += cellText(text.slice(last, match.index)) + cellTag(match[0], match[1], match[2]);
    last = match.index + match[0].length;
  }
  return html + cellText(text.slice(last));
}

function cellHtml(tag: "th" | "td", text: string): string {
  return `<${tag}>${text.trim().split("\n").map(cellContent).join("<br>")}</${tag}>`;
}

function csvTableHtml(rows: string[][], caption: string): string {
  const width = Math.max(...rows.map((row) => row.length));
  const cells = (row: string[], tag: "th" | "td") =>
    Array.from({ length: width }, (_, i) => cellHtml(tag, row[i] ?? "")).join("");
  const body = rows.slice(1).map((row) => `<tr>${cells(row, "td")}</tr>`).join("");
  const heading = caption ? `<p><strong>${escapeHtml(caption)}</strong></p>` : "";
  return `${heading}<table><thead><tr>${cells(rows[0], "th")}</tr></thead><tbody>${body}</tbody></table>`;
}

const MEDIA = "img, picture, svg, video, audio, canvas, table, iframe, object, embed";

/** Whether `wrapper` holds `child` and nothing else a reader would miss. Only
 *  then may the wrapper go with it; otherwise only `child` is replaced. */
function holdsOnly(wrapper: Element, child: Element): boolean {
  const media = (el: Element) => el.querySelectorAll(MEDIA).length + (el.matches(MEDIA) ? 1 : 0);
  return (wrapper.textContent || "").trim() === (child.textContent || "").trim() && media(wrapper) === media(child);
}

/** The page of a chart's newest version: an older version's page only redirects. */
async function currentChart(url: string, fetchDirect: LinkedTableFetchers["fetchDirect"], signal: AbortSignal) {
  const page = await fetchDirect(url, signal);
  const moved = page.match(/http-equiv=["']?refresh["']?[^>]*url=(https:\/\/datawrapper\.dwcdn\.net\/[A-Za-z0-9]+\/\d+\/)/i)?.[1];
  return moved ? { url: moved, page: await fetchDirect(moved, signal) } : { url, page };
}

function datawrapperSlots(doc: Document, pageUrl: string, fetchers: LinkedTableFetchers): TableSlot[] {
  const slots: TableSlot[] = [];
  for (const iframe of doc.querySelectorAll("iframe")) {
    if (iframe.closest("noscript")) continue; // extraction drops it
    let chart: URL;
    try {
      chart = new URL(iframe.getAttribute("src") || iframe.getAttribute("data-src") || "", pageUrl);
    } catch {
      continue;
    }
    if (chart.hostname !== DATAWRAPPER_HOST || !/^\/[A-Za-z0-9]+\/\d+\/?$/.test(chart.pathname)) continue;
    const url = `https://${DATAWRAPPER_HOST}${chart.pathname.replace(/\/?$/, "/")}`;
    const figure = iframe.closest("figure");
    slots.push({
      url,
      holder: figure && holdsOnly(figure, iframe) ? figure : iframe,
      load: async (signal) => {
        const chart = await currentChart(url, fetchers.fetchDirect, signal);
        const page = chart.page;
        // A chart is a picture of its data, not a table: it stays as it was.
        if (!/\bvis-tables\b/.test(page)) return "";
        const rows = parseCsv(await fetchers.fetchDirect(`${chart.url}dataset.csv`, signal));
        if (rows.length < 2) throw new Error("no rows");
        return csvTableHtml(rows, extractHtmlMeta(page).title);
      },
    });
  }
  return slots;
}

/** The table in a Springer Nature table page ("" if it has none). */
function tableInPage(html: string): string {
  const doc = new JSDOM(html).window.document;
  return (doc.querySelector(".c-article-table-container table") ?? doc.querySelector("table"))?.outerHTML ?? "";
}

function springerSlots(doc: Document, pageUrl: string, fetchers: LinkedTableFetchers): TableSlot[] {
  const slots: TableSlot[] = [];
  for (const link of doc.querySelectorAll('a[data-test="table-link"][href]')) {
    if (link.closest("noscript")) continue;
    let target: URL;
    try {
      target = new URL(link.getAttribute("href")!, pageUrl);
    } catch {
      continue;
    }
    if (target.hostname !== new URL(pageUrl).hostname || !/\/tables\/\d+\/?$/.test(target.pathname)) continue;
    target.hash = "";
    const url = target.href;
    const wrapper = link.closest("div");
    slots.push({
      url,
      holder: wrapper && holdsOnly(wrapper, link) ? wrapper : link,
      load: async (signal) => {
        const direct = await fetchers.fetchDirect(url, signal).catch(() => "");
        const table = direct && !looksLikeBotWall(direct) ? tableInPage(direct) : "";
        if (table) return table;
        const rendered = tableInPage(await fetchers.fetchRendered(url, signal));
        if (!rendered) throw new Error("no table on the page");
        return rendered;
      },
    });
  }
  return slots;
}

/** Fill `html`'s linked tables in. `signal` is the job's: only its abort throws. */
export async function inlineLinkedTables(
  html: string,
  pageUrl: string,
  fetchers: LinkedTableFetchers,
  opts: { signal?: AbortSignal; cache?: LinkedTableCache } = {},
): Promise<InlinedTables> {
  if (!HINT_RE.test(html)) return { html, inlined: [], failed: [] };
  const dom = new JSDOM(html, { url: pageUrl });
  const doc = dom.window.document;
  const slots = [
    ...springerSlots(doc, pageUrl, fetchers),
    ...datawrapperSlots(doc, pageUrl, fetchers),
  ].slice(0, MAX_TABLES);
  if (slots.length === 0) return { html, inlined: [], failed: [] };

  const cache: LinkedTableCache = opts.cache ?? new Map();
  const inlined: string[] = [];
  const failed: string[] = [];
  // An owned timer, for the reason pipeline.ts gives at its image time limit.
  const limit = new AbortController();
  const timer = setTimeout(() => limit.abort(new Error("linked table time limit reached")), TIME_LIMIT_MS);
  const forwardAbort = () => limit.abort(opts.signal?.reason);
  if (opts.signal?.aborted) forwardAbort();
  else opts.signal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    for (const slot of slots) {
      if (limit.signal.aborted) {
        failed.push(slot.url);
        continue;
      }
      let table = cache.get(slot.url);
      if (!table) {
        table = slot.load(limit.signal);
        cache.set(slot.url, table);
      }
      try {
        const replacement = await table;
        // A holder inside one replaced earlier went with it.
        if (!replacement || !slot.holder.isConnected) continue;
        slot.holder.outerHTML = replacement;
        inlined.push(slot.url);
      } catch (error) {
        opts.signal?.throwIfAborted();
        cache.delete(slot.url); // the other copy of the page may have better luck
        console.warn(`[add-article] could not fetch linked table ${slot.url}: ${error}`);
        failed.push(slot.url);
      }
    }
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", forwardAbort);
  }
  return { html: inlined.length > 0 ? dom.serialize() : html, inlined, failed };
}
