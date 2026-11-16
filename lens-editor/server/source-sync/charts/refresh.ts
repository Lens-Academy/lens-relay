/**
 * Keep a course's chart files: one per chart its figures draw, refreshed
 * from the source at most once a day, never replaced by worse data. This is
 * the one description of that policy; the sync's other files point here.
 *
 * When a chart is read. Now when its definition is new or changed, else
 * once CHECK_EVERY_MS has passed since it was last read, or GONE_RETRY_MS
 * when the source answered 404 or 403 (a chart OWID retired, or whose data
 * it does not let anyone download): that is reported when it starts, not
 * on every retry. A run reads the charts due for at most BUDGET_MS, so a
 * source that hangs holds up the course's articles no longer than that:
 * those with a file first, then new ones, then retries of those gone, the
 * stalest first in each; those not reached keep their files and come first
 * in the next run. The sync's memory holds when each chart was read and its
 * file as last read or written, so a run reads a chart's file from Relay
 * only when the chart is due, or after a restart, when every chart is due.
 *
 * When a file is replaced. New data replaces the file only when it
 * converted, is a valid chart within the limits, and has 2 points or more;
 * and, while the definition is the one the file was made from, has at
 * least half the file's points and the same kind. Anything else keeps the
 * file as it is and is reported (once a day, when the chart is read); with
 * no file, the figure stays a still image. The file is rewritten only when
 * the ChartSpec changes, so `retrieved` says when the data last changed; a
 * trend line whose end alone moved (OWID ends it on the day it is read) is
 * no change.
 *
 * Which files are the course's, and the definition each was made from: the
 * course file records them (`sync_charts`) at the end of a run that
 * finishes, and the memory knows them from when they were written, so a
 * run that is blocked loses neither. A file of the course's that no figure
 * draws any more is trashed, but only by a run that read every chapter: a
 * chapter that could not be read still has figures.
 */

import { createHash } from "node:crypto";
import type { CourseFiles } from "../iliad/types";
import { dataUrl, type ChartDefinition } from "./definition";
import { fetchSpec, Gone, type ChartFetch } from "./fetch";
import { chartFileText, parseChartFile } from "./file";
import { pointCount, specProblems, type ChartSpec } from "./spec";

export const CHECK_EVERY_MS = 24 * 60 * 60_000;
export const GONE_RETRY_MS = 7 * CHECK_EVERY_MS;
export const BUDGET_MS = 120_000;

/** Why a chart was not read: its run's time for charts ran out. */
class OutOfTime extends Error {}

/** What the sync knows of a chart between runs. */
export interface ChartMemo {
  /** When its data was last read, with which definition (hash), and whether the source answered it is gone (fetch.ts Gone); absent until it is read. */
  read?: { at: number; definition: string; gone?: true };
  /**
   * Its file as last read or written: a hash of its text (null: no file), its
   * spec (null: none, or `problem` says why it cannot be read), and the
   * definition (hash) that spec was made from, when known.
   */
  file?: { sha: string | null; spec: ChartSpec | null; problem?: string; definition?: string };
}

export type ChartDecision = { do: "write"; spec: ChartSpec } | { do: "keep" } | { do: "refuse"; reason: string };

/** What to do with freshly fetched data (or the error that stopped it) against the file's current spec. */
export function decide(current: ChartSpec | null, fetched: ChartSpec | Error, definitionChanged: boolean): ChartDecision {
  if (fetched instanceof Error) return { do: "refuse", reason: fetched.message };
  const problems = specProblems(fetched);
  if (problems.length) return { do: "refuse", reason: `the data does not make a valid chart: ${problems.join("; ")}` };
  const points = pointCount(fetched);
  if (points < 2) return { do: "refuse", reason: `the data has ${points} point(s); a chart needs 2` };
  if (current && !definitionChanged) {
    if (points < pointCount(current) / 2) return { do: "refuse", reason: `the data has ${points} points, under half the ${pointCount(current)} the chart has` };
    if (fetched.kind !== current.kind) return { do: "refuse", reason: `the source now draws it as ${fetched.kind}, not ${current.kind}` };
  }
  if (!current) return { do: "write", spec: fetched };
  // The fetched data as the file would hold it if nothing had changed but the date and the trend lines' ends.
  const series = fetched.series.map((s, i) => {
    const was = current.series[i];
    return s.line && was?.line && was.points.length === s.points.length ? { ...s, points: [...s.points.slice(0, -1), was.points[was.points.length - 1]] } : s;
  });
  const same = JSON.stringify(current) === JSON.stringify({ ...fetched, series, credit: { ...fetched.credit, retrieved: current.credit.retrieved } });
  return same ? { do: "keep" } : { do: "write", spec: fetched };
}

export interface ChartOutcome {
  id: string;
  path: string;
  /**
   * written: new or changed data; unchanged: read, and the same; not due: not read this run;
   * kept: a check failed and the file stays; absent: no file, so the figure is a still image;
   * deferred: due, but the run's time for charts ran out; deleted: no figure draws it any more.
   */
  action: "written" | "unchanged" | "not due" | "kept" | "absent" | "deferred" | "deleted";
  reason?: string;
  /** The file's size after the run. */
  bytes?: number;
}

export interface ChartRun {
  /** "Lens Edu/charts/<course folder>". */
  folder: string;
  courseTitle: string;
  /** The charts the course's figures draw, in order; several figures may draw one. */
  used: ChartDefinition[];
  /** The course file's `sync_charts`: the chart files of the course, each with the hash of the definition it was made from. */
  recorded: Map<string, string>;
  /** Whether files no figure draws may be trashed: every chapter was read. */
  mayDelete: boolean;
  files: CourseFiles;
  get: ChartFetch;
  memory?: Map<string, ChartMemo>;
  now: Date;
  dryRun?: boolean;
  /** The time the run may spend reading charts (BUDGET_MS). */
  budgetMs?: number;
}

export interface ChartsResult {
  outcomes: ChartOutcome[];
  /** The charts with a file after the run, each with the hash of the definition it was made from: `sync_charts` to record. */
  kept: Map<string, string>;
  warnings: string[];
}

export async function refreshCharts(run: ChartRun): Promise<ChartsResult> {
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(new OutOfTime("the run's time for charts ran out")), run.budgetMs ?? BUDGET_MS);
  try {
    return await refresh(run, budget.signal);
  } finally {
    clearTimeout(timer);
  }
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

async function refresh(run: ChartRun, budget: AbortSignal): Promise<ChartsResult> {
  const result: ChartsResult = { outcomes: [], kept: new Map(), warnings: [] };
  // A dry run changes nothing, its memory included.
  const memory = run.dryRun || !run.memory ? new Map(run.memory) : run.memory;
  const today = run.now.toISOString().slice(0, 10);
  const used = new Map<string, ChartDefinition>();
  for (const chart of run.used) {
    const first = used.get(chart.id);
    if (!first) used.set(chart.id, chart);
    else if (first.hash !== chart.hash) result.warnings.push(`Two figures draw the chart "${chart.id}" with different definitions; both draw the first one's chart. To draw both, give a chart table an id row of its own.`);
  }
  const pathOf = (id: string) => `${run.folder}/${id}.md`;

  // Each chart's file, read from Relay when the chart is due or the file unknown.
  const charts: { chart: ChartDefinition; path: string; memo: ChartMemo; file: NonNullable<ChartMemo["file"]>; due: boolean }[] = [];
  for (const chart of used.values()) {
    const path = pathOf(chart.id);
    const memo = memory.get(chart.id) ?? {};
    const { read } = memo;
    const due = !(read?.definition === chart.hash && run.now.getTime() - read.at < (read.gone ? GONE_RETRY_MS : CHECK_EVERY_MS));
    let file = memo.file;
    if (due || !file) {
      const text = await run.files.read(path);
      const sha = text === null ? null : sha256(text);
      if (sha !== file?.sha) {
        try {
          file = { sha, spec: text === null ? null : parseChartFile(text, chart.id), definition: run.recorded.get(chart.id) };
        } catch (err) {
          file = { sha, spec: null, problem: (err as Error).message };
        }
      }
      if (file.problem) result.warnings.push(`"${path}" is not a chart file the sync can read (${file.problem}); it is replaced when the chart's data is next read, and its figure shows the still image until then.`);
    }
    charts.push({ chart, path, memo, file, due });
  }

  // Their data, for the time the run has: charts with a file first, then new ones, then those gone; the stalest first in each.
  const rank = ({ memo, file }: (typeof charts)[number]) => (memo.read?.gone ? 2 : file.spec ? 0 : 1);
  const readAt = ({ memo }: (typeof charts)[number]) => memo.read?.at ?? -Infinity;
  const outcomes = new Map<string, ChartOutcome>();
  const deferred: string[] = [];
  for (const { chart, path, memo, due, ...state } of [...charts].sort((a, b) => rank(a) - rank(b) || readAt(a) - readAt(b))) {
    let { file } = state;
    const current = file.spec;
    const bytes = (spec: ChartSpec | null) => (spec ? { bytes: Buffer.byteLength(chartFileText(chart, spec, run.courseTitle)) } : {});
    const outcome = (action: ChartOutcome["action"], reason?: string, spec = current) => outcomes.set(chart.id, { id: chart.id, path, action, ...(reason && { reason }), ...bytes(spec) });
    const remember = (change: ChartMemo) => memory.set(chart.id, { ...memo, file, ...change });
    if (current) result.kept.set(chart.id, file.definition ?? chart.hash);
    if (!due) {
      remember({});
      outcome(current ? "not due" : "absent", `read at ${new Date(memo.read!.at).toISOString().slice(0, 16).replace("T", " ")} UTC`);
      continue;
    }

    let fetched: ChartSpec | Error;
    try {
      budget.throwIfAborted();
      fetched = await fetchSpec(chart, (url) => run.get(url, budget), today);
    } catch (err) {
      fetched = err as Error;
    }
    if (fetched instanceof OutOfTime) {
      remember({});
      deferred.push(chart.id);
      outcome("deferred", "the run's time for charts ran out; the next run reads it first");
      continue;
    }
    const named = `The chart "${chart.id}" (${dataUrl(chart)})`;
    const gone = fetched instanceof Gone;
    // Reported once: when it starts, and once for each definition.
    const news = !(gone && memo.read?.gone);
    if (!(fetched instanceof Error) && chart.rows.highlight && memo.read?.definition !== chart.hash) {
      const shown = new Set(fetched.highlight ?? []);
      const missed = chart.rows.highlight.filter((name) => !shown.has(name)).map((name) => `"${name}"`);
      if (missed.length) {
        const why = fetched.kind === "scatter" ? "name no series or point label of its data" : `are not shown: highlight is for scatter charts, and this is a ${fetched.kind} chart`;
        result.warnings.push(`${named}: its highlight row's ${missed.join(", ")} ${why}.`);
      }
    }
    const decision = decide(current, fetched, file.definition !== chart.hash);
    if (decision.do === "write") {
      const content = chartFileText(chart, decision.spec, run.courseTitle);
      if (!run.dryRun) await run.files.write(path, content);
      file = { sha: sha256(content), spec: decision.spec, definition: chart.hash };
      result.kept.set(chart.id, chart.hash);
      outcome("written", current ? "the data changed" : "new", decision.spec);
    } else if (decision.do === "keep") {
      // The file is what this definition gives.
      file = { ...file, definition: chart.hash };
      result.kept.set(chart.id, chart.hash);
      outcome("unchanged");
    } else if (current) {
      if (news) result.warnings.push(`${named} keeps its data of ${current.credit.retrieved}: ${decision.reason}${gone ? "; it is tried again weekly" : ""}.`);
      outcome("kept", decision.reason);
    } else {
      if (news) result.warnings.push(`${named} has no data, so its figure stays a still image: ${decision.reason}${gone ? "; it is tried again weekly" : ""}.`);
      outcome("absent", decision.reason);
    }
    remember({ read: { at: run.now.getTime(), definition: chart.hash, ...(gone && { gone: true as const }) } });
  }
  result.outcomes.push(...charts.map(({ chart }) => outcomes.get(chart.id)!));
  if (deferred.length) {
    result.warnings.push(`${deferred.length} chart(s) were not read: a run spends at most ${(run.budgetMs ?? BUDGET_MS) / 1000} s on charts, and the next run reads them first. Their files stay as they are: ${deferred.join(", ")}.`);
  }

  // The course's files no figure draws: those the course file records, and those this process wrote or found.
  for (const id of new Set([...run.recorded.keys(), ...memory.keys()])) {
    if (used.has(id)) continue;
    const recorded = run.recorded.get(id) ?? memory.get(id)?.file?.definition;
    // A chapter this run could not read may still draw it: it stays recorded.
    if (!run.mayDelete) {
      if (recorded) result.kept.set(id, recorded);
      continue;
    }
    const path = pathOf(id);
    if ((await run.files.read(path)) === null) {
      memory.delete(id);
      continue;
    }
    try {
      if (!run.dryRun) await run.files.trash(path);
      memory.delete(id);
      result.outcomes.push({ id, path, action: "deleted", reason: "no figure of the course draws it" });
    } catch (err) {
      if (recorded) result.kept.set(id, recorded);
      result.warnings.push(`"${path}" is a chart no figure draws any more, and moving it to the trash failed (${(err as Error).message}); the next run tries again.`);
    }
  }
  return result;
}
