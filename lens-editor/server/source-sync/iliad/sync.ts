/**
 * One run of the Iliad course sync, and the loop that repeats it.
 *
 * A run does nothing when the course file already records the commit
 * iliad-intensive.org was built from: that check costs one request to the
 * site and one file read, so it can repeat every few minutes. Otherwise it
 * reads the whole source and the whole course, and writes what differs.
 *
 * A run that fails changes nothing it cannot finish later: the course file's
 * commit is written last (course-files.ts), so the next run starts over.
 */

import { repeatEvery, type SyncLog } from "../runner";
import { convertWorksheet } from "./convert";
import { applyFilePlan, planCourseFiles, type LensInput, type SyncInput } from "./course-files";
import { readCourseState, type CourseState } from "./course-state";
import { toHostableImage } from "./figures";
import { LAYOUT, type Layout } from "./layout";
import { field, splitFrontmatter } from "./module-file";
import { adoptPin, planCourse } from "./plan";
import { publishedCommit, readSnapshot } from "./snapshot";
import { summarizeLens, type AskModel } from "./summaries";
import type { Atom, CourseFiles, Pin, Snapshot, SyncReport, Worksheet } from "./types";

/**
 * Clusters of the schedule the course leaves out. Day 0 ("Prerequisites")
 * was not in the hand import of 8 Oct 2026; syncing it would add a
 * "Foundations" module to a course whose shape is being kept as imported.
 */
const SKIPPED_CLUSTERS = new Set(["0"]);

export interface SyncOptions {
  files: CourseFiles;
  layout?: Layout;
  /** The source; the live site unless a test or the preview script says otherwise. */
  source?: { commit(): Promise<string>; snapshot(): Promise<Snapshot> };
  /** Writes `tldr` and `summary_for_tutor` for a new or changed lens. Without it a lens keeps what it has. */
  ask?: AskModel;
  /** Work out and report the file changes without making them. Figures are still hosted. */
  dryRun?: boolean;
  /** Run although the course file already records the published commit. */
  force?: boolean;
  /**
   * The source commit a person approved retirements for: a large retirement
   * (course-files.ts), and losses in a deploy too fresh to apply alone.
   */
  approvedRetirement?: string;
  /** The clock (tests pass their own). */
  now?: () => Date;
}

/**
 * How long a deploy must have stood before a run applies a change that
 * retires a lens, moves a lens's start, or removes a reading or a card.
 * Iliad often fixes a bad deploy within the hour; applied at once, such a
 * deploy would cost lens ids for good, and learners' progress with them.
 */
const SETTLE_MS = 60 * 60_000;

const LIVE = { commit: () => publishedCommit(), snapshot: () => readSnapshot() };

export async function syncCourse({ files, layout = LAYOUT, source = LIVE, ask, dryRun = false, force = false, approvedRetirement, now = () => new Date() }: SyncOptions): Promise<SyncReport> {
  const commit = await source.commit();
  const course = await files.read(layout.course);
  if (course === null) {
    throw new Error(`the course file "${layout.course}" does not exist. If it was moved, set ILIAD_SYNC_COURSE to its new path and restart the lens-editor container`);
  }
  if (!force && field(splitFrontmatter(course).data, "upstream_commit") === commit) {
    return { commit, changed: false, written: [], moved: [], retired: [], warnings: [] };
  }

  const snapshot = await source.snapshot();
  const worksheets = snapshot.worksheets.filter((worksheet) => !SKIPPED_CLUSTERS.has(worksheet.cluster.id));
  const state = await readCourseState(files, layout);
  const warnings: string[] = [...snapshot.warnings];

  const hostImage = figureHost(snapshot, files, warnings);
  const sheets: { worksheet: Worksheet; slug: string; atoms: Atom[] }[] = [];
  for (const worksheet of worksheets) {
    const converted = await convertWorksheet(worksheet, hostImage);
    warnings.push(...converted.warnings);
    sheets.push({ worksheet, slug: worksheet.slug, atoms: converted.atoms });
  }

  const plan = planCourse(sheets, pinsOf(state, sheets, warnings));
  const titleOf = (id: string) => state.lenses.find((lens) => lens.id === id)?.title ?? id;
  const retireReasons = new Map(plan.retired.map(({ pin, reason }) => [pin.id, reason]));
  const hold = holdFor(snapshot, approvedRetirement, now());
  const planLosses = [
    ...plan.retired.map(({ pin, reason }) => `"${titleOf(pin.id)}" would be retired: ${reason}`),
    ...plan.worksheets.flatMap(({ lenses }) =>
      lenses.flatMap(({ key, pinned }) => (pinned && pinned.key !== key ? [`"${titleOf(pinned.id)}" would start at ${key} instead of ${pinned.key}`] : [])),
    ),
  ];
  if (hold && planLosses.length) return waiting(snapshot.commit, hold, planLosses, warnings);
  const summarize = ask ? summariesFor(state, ask, warnings) : null;
  const input: SyncInput = { commit: snapshot.commit, worksheets: [] };
  for (const [i, { lenses }] of plan.worksheets.entries()) {
    const { worksheet } = sheets[i];
    const inputs: LensInput[] = [];
    for (const planned of lenses) {
      // One question at a time: the model runs in the pool the article importer uses.
      inputs.push({ planned, fingerprint: planned.fingerprint, ...(await summarize?.(worksheet, planned.pinned, planned.fingerprint, planned.atoms)) });
    }
    input.worksheets.push({ worksheet, lenses: inputs });
  }

  const filePlan = planCourseFiles(state, input, { layout, approvedRetirement, retireReasons });
  if (hold && filePlan.removes.length) return waiting(snapshot.commit, hold, filePlan.removes, warnings);
  const report = await applyFilePlan(files, filePlan, { dryRun });
  // What the run retired or removed, each with its reason, first: it is what a person may need to act on.
  return { ...report, warnings: [...filePlan.removes, ...warnings, ...report.warnings] };
}

/**
 * When a change that loses something may be applied, or null when it may be
 * now: the deploy has stood SETTLE_MS, or a person approved this commit. A
 * site that does not say when it was deployed holds such changes until a
 * person approves the commit.
 */
function holdFor(snapshot: Snapshot, approved: string | undefined, now: Date): Date | "approval" | null {
  if (approved === snapshot.commit) return null;
  if (!snapshot.deployedAt) return "approval";
  const settled = new Date(snapshot.deployedAt.getTime() + SETTLE_MS);
  return settled > now ? settled : null;
}

/** The report of a run that applied nothing, so that a short-lived bad deploy costs nothing. */
function waiting(commit: string, hold: Date | "approval", losses: string[], warnings: string[]): SyncReport {
  const until =
    hold === "approval"
      ? `The site does not say when it was deployed, so they wait for a person: if they are right, set ILIAD_SYNC_APPROVE_RETIREMENT=${commit} and restart the lens-editor container.`
      : `They are applied from ${hold.toISOString().slice(0, 16).replace("T", " ")} UTC unless Iliad deploys again before then. Nothing to do.`;
  return {
    commit,
    changed: false,
    written: [],
    moved: [],
    retired: [],
    warnings: [`Source commit ${commit.slice(0, 7)} would lose what is listed below; nothing was changed yet. ${until}`, ...losses, ...warnings],
    waitingUntil: hold === "approval" ? undefined : hold,
  };
}

/**
 * Host a figure of the site once per run. figures.ts says which failures
 * are permanent (the converter then puts a link in the lens, and the run
 * warns); any other failure, a failed download among them, fails the run.
 */
function figureHost(snapshot: Snapshot, files: CourseFiles, warnings: string[]): (sitePath: string) => Promise<string> {
  const hosted = new Map<string, Promise<string>>();
  const host = async (sitePath: string): Promise<string> => {
    const image = await toHostableImage(await snapshot.asset(sitePath), sitePath);
    if (image.warning) warnings.push(image.warning);
    // "/uploads/aixi/tikz-4dc0e19d14b9.svg" -> "iliad-aixi-tikz-4dc0e19d14b9"
    const stem = `iliad-${sitePath.replace(/^\/?(?:uploads\/)?/, "").replace(/\.[^./]+$/, "").replace(/[^A-Za-z0-9]+/g, "-")}`;
    return files.hostImage(image.bytes, stem);
  };
  return (sitePath) => {
    let url = hosted.get(sitePath);
    if (!url) hosted.set(sitePath, (url = host(sitePath)));
    return url;
  };
}

/**
 * The pin of every lens the course has, in course order. A lens the sync
 * wrote carries its pin. A lens of the hand import is placed by its headings
 * and text; one that starts in the middle of a section cannot be placed, so
 * it is retired and its text stays in the lens before it.
 */
function pinsOf(state: CourseState, sheets: { slug: string; atoms: Atom[] }[], warnings: string[]): Pin[] {
  const atoms = new Map(sheets.map((sheet) => [sheet.slug, sheet.atoms]));
  return state.lenses.flatMap((lens) => {
    if (lens.upstreamKey && lens.fingerprint) return [{ key: lens.upstreamKey, id: lens.id, fingerprint: lens.fingerprint }];
    const pin = adoptPin(lens.slug, atoms.get(lens.slug) ?? [], lens);
    if (!pin) warnings.push(`"${lens.title}" starts where no section of ${lens.slug} starts; it is retired`);
    return pin ? [pin] : [];
  });
}

/**
 * New summaries for a lens that is new, or whose fingerprint changed since
 * the sync last wrote it. A lens of the hand import keeps its summaries
 * until its content changes, and so does any lens the model fails on.
 */
function summariesFor(state: CourseState, ask: AskModel, warnings: string[]) {
  const titles = new Map(state.lenses.map((lens) => [lens.id, lens.title]));
  return async (worksheet: Worksheet, pinned: Pin | null, print: string, atoms: Atom[]) => {
    const previous = state.lenses.find((lens) => lens.id === pinned?.id);
    if (previous && (previous.fingerprint === null || previous.fingerprint === print)) return {};
    const markdown = atoms.flatMap((atom) => atom.parts.flatMap((part) => (part.kind === "text" ? [part.markdown] : []))).join("\n\n");
    const title = (pinned && titles.get(pinned.id)) ?? atoms.find((atom) => atom.title)?.title ?? worksheet.title;
    const summary = await summarizeLens({ title, worksheet, markdown }, ask, (warning) => warnings.push(warning));
    return summary ? { tldr: summary.tldr, summaryForTutor: summary.summaryForTutor } : {};
  };
}

// ------------------------------------------------------------------ loop

export function logReport(report: SyncReport, log: SyncLog): void {
  const did = report.changed ? `${report.written.length} written, ${report.moved.length} moved, ${report.retired.length} retired` : "unchanged";
  log.log(`[iliad-sync] ${report.commit.slice(0, 7)}: ${did}${report.warnings.length ? `, ${report.warnings.length} warning(s)` : ""}`);
  for (const warning of report.warnings) log.log(prefixed(warning, "[iliad-sync]   "));
}

/** Every line of a message with the prefix, so that a grep for it shows the whole message. */
const prefixed = (message: string, prefix: string): string =>
  message
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");

/**
 * Sync now, then again `intervalMs` after each run finishes. A failed run is
 * logged and the next one tries again; the course keeps the state it had.
 * Returns a stop function.
 */
export function startCourseSync(options: SyncOptions, intervalMs: number, log: SyncLog = console): () => void {
  log.log(`[iliad-sync] ${(options.layout ?? LAYOUT).course}, every ${Math.round(intervalMs / 60_000)} min`);
  // A run that fails after the model step is repeated every interval, and
  // would ask the same questions each time: keep the answers until a run finishes.
  const answers = new Map<string, Promise<string>>();
  const ask = options.ask;
  const remembered: SyncOptions = ask
    ? {
        ...options,
        ask: (prompt) => {
          let answer = answers.get(prompt);
          if (!answer) {
            answers.set(prompt, (answer = ask(prompt)));
            answer.catch(() => answers.delete(prompt));
          }
          return answer;
        },
      }
    : options;
  return repeatEvery(intervalMs, async () => {
    try {
      const report = await syncCourse(remembered);
      logReport(report, log);
      // A run that changed nothing (one that waits, among them) will ask the same questions again.
      if (report.changed) answers.clear();
    } catch (err) {
      log.error(prefixed(`failed: ${(err as Error).message}\nNothing was recorded as done; the next run, in ${Math.round(intervalMs / 60_000)} min, tries again.`, "[iliad-sync] "));
    }
  });
}
