/**
 * One run of the Atlas course sync, and the loop that repeats it.
 *
 * A run reads every chapter tab (8 Docs API requests) and the course file.
 * When the course file records the same chapter revisions, the same version
 * of the sync's rules (ATLAS_SYNC_RULES) and the same configuration
 * (`sync_config`, config.ts configHash), and no missing lens has waited its
 * hour, the run ends there: it writes nothing and hosts no image.
 * Otherwise it reads the course's files, plans, and writes what differs.
 * Only the chapters that changed are converted and have their images
 * hosted; another chapter's articles stay as they are.
 *
 * A chapter that cannot be read, whose TITLE does not read "Chapter <N> -
 * <Title>", or one of whose images failed to download for a passing reason,
 * is left out of the run: its files stay as they are, none of its lenses is
 * retired, and the course file keeps its last revision, so the next run
 * tries it again. A run that fails changes nothing it cannot finish later:
 * the course file is written last (files.ts).
 *
 * A run that is blocked (a chapter left out, or retirements that wait for a
 * person) is not done again in full while the Docs stay as they were, for
 * BLOCKED_RECHECK_MS: the next runs log one line instead of reading every
 * file of the course and repeating every warning.
 *
 * A course file that is missing while the course's modules or lenses are
 * there was moved or deleted: the run stops rather than start a second
 * course beside it.
 */

import { randomUUID } from "node:crypto";
import type { HostedImages } from "../google-docs/adapter";
import { applyFilePlan } from "../iliad/course-files";
import type { CourseFiles } from "../iliad/types";
import { repeatEvery, type SyncLog } from "../runner";
import { chapterRef, configHash } from "./config";
import { convertSection } from "./convert";
import { courseFile, coursePaths, planAtlasFiles, type CoursePaths } from "./files";
import type { ToWebp } from "./images";
import { planAtlas, RETIRE_AFTER_MS, type AtlasChapter, type AtlasPlan } from "./plan";
import { splitChapter } from "./sections";
import { combinedRevision, hostImages, readChapters, type AtlasDocs, type UnreadChapter } from "./snapshot";
import { courseHeader, parsed, readAtlasState, readUnlisted } from "./state";
import type { AtlasCourseConfig, AtlasCourseState } from "./types";

/**
 * The version of the rules by which the sync lays out and converts the
 * course, recorded in the course file (`sync_rules`). Increase it with a
 * change that must reach the course before the Docs next change: a run
 * whose rules differ from the course file's converts every chapter.
 */
export const ATLAS_SYNC_RULES = 1;
const BLOCKED_RECHECK_MS = 60 * 60_000;

/** What a course's runs keep between them. */
export interface AtlasMemory {
  /** Hosted image URLs. */
  images: HostedImages;
  /** The last run that was blocked: at which state of the Docs, why, and until when the next runs leave it be. */
  blocked?: { revision: string; reason: string; until: number };
}

export interface AtlasSyncDeps {
  files: CourseFiles;
  docs: AtlasDocs;
  memory?: AtlasMemory;
  /** What an image is made into before it is hosted (images.ts toWebp; tests pass their own). */
  toWebp?: ToWebp;
  now?: () => Date;
  newId?: () => string;
}

export interface AtlasRunOptions {
  /** Work out and report the file changes without making them. Images are still hosted. */
  dryRun?: boolean;
  /** Convert every chapter, although the course file records the revisions read. */
  force?: boolean;
  /** ATLAS_SYNC_APPROVE_RETIREMENT: names the lenses a person approved retiring (plan.ts retirementApproval). */
  approvedRetirement?: string;
}

/** What one run did, or would do in a dry run. */
export interface AtlasSyncReport {
  course: string;
  /** The combined revision of the chapters as read. */
  revision: string;
  /** True when the course file already recorded this state of the Docs, so the run did nothing more. */
  upToDate: boolean;
  /** Set when the run did nothing more because an earlier run at this state of the Docs was blocked: why. */
  stillBlocked?: string;
  /** True when the run wrote, moved or retired a file, or in a dry run would have. */
  changed: boolean;
  written: string[];
  moved: { from: string; to: string }[];
  retired: string[];
  /** Chapters left out of this run, each with why. */
  skipped: string[];
  warnings: string[];
}

/** Whether the course file records this state of the Docs, the same rules and configuration, and no lens due to be retired. */
function upToDate(config: AtlasCourseConfig, course: string | null, revisions: Map<string, string>, now: Date): boolean {
  let header;
  try {
    header = course === null ? null : courseHeader(parsed(config.course, course).data);
  } catch {
    return false;
  }
  return (
    !!header &&
    header.syncRules === ATLAS_SYNC_RULES &&
    header.syncConfig === configHash(config) &&
    header.revisions.size === revisions.size &&
    [...revisions].every(([doc, revision]) => header.revisions.get(doc) === revision) &&
    [...header.missingSince.values()].every((since) => !(now.getTime() - Date.parse(since) >= RETIRE_AFTER_MS))
  );
}

export async function syncAtlasCourse(config: AtlasCourseConfig, deps: AtlasSyncDeps, options: AtlasRunOptions = {}): Promise<AtlasSyncReport> {
  const { files, memory } = deps;
  const now = deps.now?.() ?? new Date();
  const newId = deps.newId ?? randomUUID;
  const { chapters: read, unread } = await readChapters(config, deps.docs);
  const revisionOf = new Map(read.map((source) => [source.docId, source.revision]));
  const revision = combinedRevision(config.chapters.map(({ doc }) => revisionOf.get(chapterRef(doc).docId) ?? null));
  const report = (fields: Partial<AtlasSyncReport>): AtlasSyncReport => ({ course: config.course, revision, upToDate: false, changed: false, written: [], moved: [], retired: [], skipped: [], warnings: [], ...fields });

  const blocked = memory?.blocked;
  if (!options.force && blocked?.revision === revision && now.getTime() < blocked.until) return report({ stillBlocked: blocked.reason });
  if (!options.force && !unread.length && upToDate(config, await files.read(config.course), revisionOf, now)) {
    if (memory) memory.blocked = undefined;
    return report({ upToDate: true });
  }

  const warnings: string[] = [];
  const left: UnreadChapter[] = [...unread];
  let chapters: AtlasChapter[] = [];
  for (const source of read) {
    const split = splitChapter(source);
    warnings.push(...split.warnings.map((warning) => `Chapter ${split.facts.number || "?"} (${source.url}): ${warning}`));
    if (split.facts.number === 0) left.push({ docId: source.docId, url: source.url, reason: `its TITLE does not read "Chapter <N> - <Title>"` });
    else if (chapters.some((c) => c.facts.slug === split.facts.slug)) left.push({ docId: source.docId, url: source.url, reason: `another chapter has the same title, "${split.facts.title}"` });
    else chapters.push({ source, facts: split.facts, sections: split.sections });
  }

  const state = await readAtlasState(files, config);
  // The paths a first run would write: where a run that stopped early may have left lenses to take back.
  const fresh = coursePaths(config, chapters.map((chapter) => ({ chapter, sections: chapter.sections.map((section) => ({ section, pin: null })) })), { pins: [], modules: [], occupied: new Set() });
  await readUnlisted(
    files,
    state,
    chapters.flatMap((c) => c.sections.map((section) => ({ path: fresh.sections.get(section)!.lens, key: `${c.facts.slug}#${section.slug}`, heading: section.headingId }))),
    [...fresh.modules.values(), ...[...fresh.sections.values()].map((p) => p.article)],
  );
  warnings.unshift(...state.warnings);
  if (state.contents.get(config.course) === null) {
    // Modules or lenses of the course without its course file: it was moved or deleted. A new one would be a
    // second course, with new ids, beside the one that moved.
    const found = [...[...fresh.modules.values()].filter((path) => state.contents.get(path) && !state.occupied.has(path)), ...state.pins.map((pin) => pin.lensPath)];
    if (found.length) {
      throw new Error(
        `The course file "${config.course}" is missing or was moved, but the course's files are there ("${found[0]}"${found.length > 1 ? ` and ${found.length - 1} more` : ""}). The sync stopped and changed nothing. To do: restore the course file from the folder's trash (_trash/), or set ATLAS_SYNC_COURSES to its new path and restart the lens-editor container.`,
      );
    }
    // A first run writes the course file before anything else, so that a run that stops early leaves one to go on from.
    if (!options.dryRun) {
      const placeholder = courseFile(config, null, [], newId);
      await files.write(config.course, placeholder);
      state.contents.set(config.course, placeholder);
    }
  }

  // The chapters whose articles are written: those that changed, all of them when the rules or the configuration
  // did, and any with a section that has no article of the sync's yet.
  const allChanged = options.force || state.syncRules !== ATLAS_SYNC_RULES || state.syncConfig !== configHash(config);
  const planFor = (chapters: AtlasChapter[]) => planAtlas(chapters, state, { now, approvedRetirement: options.approvedRetirement, newId });
  let plan = planFor(chapters);
  const converting = plan.chapters
    .filter(({ chapter, sections }) => allChanged || state.revisions.get(chapter.source.docId) !== chapter.source.revision || sections.some(({ pin }) => !pin?.articlePath || !state.contents.get(pin.articlePath)))
    .map(({ chapter }) => chapter);
  const snapshot = await hostImages(converting.map((c) => ({ source: c.source, stem: `atlas-${c.facts.slug}` })), deps.docs, files, memory?.images ?? new Map(), deps.toWebp);
  warnings.push(...snapshot.warnings);
  if (snapshot.failed.length) {
    left.push(...snapshot.failed);
    chapters = chapters.filter((c) => !snapshot.failed.some((f) => f.docId === c.source.docId));
    plan = planFor(chapters);
  }
  const done = (fields: Partial<AtlasSyncReport>, held?: AtlasPlan): AtlasSyncReport => {
    const reasons = [left.length ? `${left.length} chapter(s) left out` : "", held?.held ? `${held.held} lens(es) wait for ATLAS_SYNC_APPROVE_RETIREMENT=${held.approval}` : ""].filter(Boolean);
    const until = now.getTime() + BLOCKED_RECHECK_MS;
    if (memory) memory.blocked = reasons.length ? { revision, reason: reasons.join("; "), until } : undefined;
    const retry = memory ? `The sync reads it again at its first run from ${new Date(until).toISOString().slice(11, 16)} UTC, or sooner if a Doc of the course changes.` : "The next run reads it again.";
    return report({ skipped: left.map((c) => `${c.url} was left out of this run, and its files kept as they are: ${c.reason}. ${retry}`), ...fields });
  };
  if (!chapters.length) return done({ warnings });

  const articles = new Map<string, string>();
  for (const { chapter, sections } of plan.chapters) {
    if (!converting.includes(chapter)) continue;
    const counters = new Map<string, number>();
    for (const { section, id } of sections) {
      const converted = convertSection(section, chapter.source, (image) => snapshot.imageUrl(chapter.source.docId, image), counters);
      warnings.push(...converted.warnings);
      articles.set(id, converted.markdown);
    }
  }

  // A chapter left out keeps the revision the course file has for it, so that the run that next reads it converts
  // it if it changed; and none when the rules or the configuration changed, so that it is converted by the new ones.
  const revisions = new Map<string, string>();
  for (const { doc } of config.chapters) {
    const { docId } = chapterRef(doc);
    const value = chapters.some((c) => c.source.docId === docId) ? revisionOf.get(docId) : allChanged ? undefined : state.revisions.get(docId);
    if (value) revisions.set(docId, value);
  }
  const paths = await settledPaths(files, config, plan, state);
  const filePlan = planAtlasFiles({ config, state, plan, paths, articles, revisions, revision, syncRules: ATLAS_SYNC_RULES, today: now.toISOString().slice(0, 10), newId });
  const { changed, written, moved, retired, warnings: applyWarnings } = await applyFilePlan(files, filePlan, { dryRun: options.dryRun });
  // What the run retired, each with its reason, first: it is what a person may need to act on.
  return done({ changed, written, moved, retired, warnings: [...filePlan.removes, ...applyWarnings, ...warnings] }, plan);
}

/** The course's paths, once every path they name has been read, so that none lands on a file that is not free. */
async function settledPaths(files: CourseFiles, config: AtlasCourseConfig, plan: AtlasPlan, state: AtlasCourseState): Promise<CoursePaths> {
  for (;;) {
    const paths = coursePaths(config, plan.chapters, state);
    const unread = [...paths.modules.values(), ...[...paths.sections.values()].flatMap((p) => [p.lens, p.article])].filter((path) => !state.contents.has(path));
    if (!unread.length) return paths;
    await readUnlisted(files, state, [], unread);
  }
}

// ------------------------------------------------------------------ loop

/** Every line of a message with the prefix, so that a grep for it shows the whole message. */
export const prefixed = (message: string, prefix: string): string =>
  message
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");

export function logAtlasReport(report: AtlasSyncReport, log: SyncLog): void {
  const head = `[atlas-sync] ${report.course} at ${report.revision}: `;
  if (report.stillBlocked) return log.log(`${head}still blocked (${report.stillBlocked}); the Docs are as they were, so the run looks again in full within the hour`);
  const did = report.upToDate ? "up to date" : report.changed ? `${report.written.length} written, ${report.moved.length} moved, ${report.retired.length} retired` : "unchanged";
  const notes = [report.skipped.length ? `${report.skipped.length} chapter(s) left out` : "", report.warnings.length ? `${report.warnings.length} warning(s)` : ""].filter(Boolean);
  log.log(`${head}${did}${notes.length ? `, ${notes.join(", ")}` : ""}`);
  for (const line of report.skipped) log.error(prefixed(line, "[atlas-sync]   "));
  for (const warning of report.warnings) log.log(prefixed(warning, "[atlas-sync]   "));
}

export interface AtlasStartDeps {
  /** Where a course's files are (the relay in production). */
  files: (config: AtlasCourseConfig) => CourseFiles;
  /** Made on first use, so a server without Google credentials starts, and each run reports what is missing. */
  docs: () => AtlasDocs;
  approvedRetirement?: string;
}

/**
 * Sync every course now, then again `intervalMs` after each round finishes.
 * A failed run is logged and the next one tries again; the course keeps the
 * state it had. Returns a stop function.
 */
export function startAtlasSync(configs: AtlasCourseConfig[], intervalMs: number, deps: AtlasStartDeps, log: SyncLog = console): () => void {
  const minutes = Math.round(intervalMs / 60_000);
  log.log(`[atlas-sync] ${configs.map((config) => config.course).join(", ")}, every ${minutes} min${deps.approvedRetirement ? `, retirement approved for ${deps.approvedRetirement}` : ""}`);
  const courses = configs.map((config) => ({ config, files: deps.files(config), memory: { images: new Map() } as AtlasMemory }));
  let docs: AtlasDocs | null = null;
  return repeatEvery(intervalMs, async (stopped) => {
    for (const { config, files, memory } of courses) {
      if (stopped()) return;
      try {
        docs ??= deps.docs();
        logAtlasReport(await syncAtlasCourse(config, { files, docs, memory }, { approvedRetirement: deps.approvedRetirement }), log);
      } catch (err) {
        log.error(prefixed(`${config.course}: failed: ${(err as Error).message}\nNothing was recorded as done; the next run, in ${minutes} min, tries again.`, "[atlas-sync] "));
      }
    }
  });
}
