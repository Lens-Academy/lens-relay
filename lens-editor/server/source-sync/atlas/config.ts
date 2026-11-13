/**
 * ATLAS_SYNC_COURSES: the courses the Atlas sync keeps, a JSON list of
 * AtlasCourseConfig. The whole list is checked before anything runs, and one
 * bad entry leaves the Atlas sync off: two entries can write the same files,
 * so a course is not synced beside a list that is wrong.
 */

import { createHash } from "node:crypto";
import { googleDocEditUrl, parseGoogleDocUrl } from "../google-docs/url";
import { safeName } from "../iliad/layout";
import type { AtlasChapterConfig, AtlasCourseConfig } from "./types";

export const ATLAS_COURSES_ENV = "ATLAS_SYNC_COURSES";
/** Its value names the lenses a person approved retiring (plan.ts retirementApproval), as the log gives it. */
export const ATLAS_APPROVE_RETIREMENT_ENV = "ATLAS_SYNC_APPROVE_RETIREMENT";

/** Course-file fields the sync writes itself, so `courseFields` may not set them. */
const OWN_COURSE_FIELDS = ["id", "slug", "title", "synced_from", "upstream_revisions", "missing_since", "sync_rules", "sync_config"];

const STRINGS = ["course", "slug", "title", "folder", "filePrefix", "moduleSlugPrefix", "siteUrl"] as const;
const KEYS = new Set<string>([...STRINGS, "authors", "chapters", "appendicesOptional", "courseFields"]);
const CHAPTER_KEYS = ["doc", "authors", "acknowledgements"];
const CHAPTER_SHAPE = `{ "doc": "<Google Docs link with ?tab=>", "authors"?: [names], "acknowledgements"?: [names] }`;

const isNames = (value: unknown, mayBeEmpty: boolean): value is string[] =>
  Array.isArray(value) && (mayBeEmpty || value.length > 0) && value.every((name) => typeof name === "string" && name.trim());

/** A chapter link of a course, read. */
export interface ChapterRef {
  docId: string;
  tabId: string;
  /** The link as a person opens it to edit the chapter: what synced files carry in `synced_from.url`. */
  url: string;
}

/** A configured chapter link, which config parsing has checked names a Doc and a tab. */
export function chapterRef(link: string): ChapterRef {
  const ref = parseGoogleDocUrl(link);
  if (!ref?.tabId) throw new Error(`not a Google Docs link with ?tab=: ${link}`);
  return { docId: ref.documentId, tabId: ref.tabId, url: googleDocEditUrl(ref) };
}

/** Whether two links name the same Doc tab (a chapter): how a renamed chapter is still known. */
export function sameChapter(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = a ? parseGoogleDocUrl(a) : null;
  const y = b ? parseGoogleDocUrl(b) : null;
  return !!x && !!y && x.documentId === y.documentId && x.tabId === y.tabId;
}

/** Why a course entry cannot be used, one line each; empty when it can. */
function problemsOf(entry: unknown): string[] {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return ["must be an object"];
  const e = entry as Record<string, unknown>;
  const problems: string[] = [];
  const unknown = Object.keys(e).filter((key) => !KEYS.has(key));
  if (unknown.length) problems.push(`has unknown key(s) ${unknown.map((key) => `"${key}"`).join(", ")}; the keys are ${[...KEYS].join(", ")}`);
  for (const key of STRINGS) if (typeof e[key] !== "string" || !e[key].trim()) problems.push(`.${key} must be a non-empty string`);
  if (problems.length) return problems;

  const course = e.course as string;
  if (!course.includes("/courses/") || !course.endsWith(".md") || course.startsWith("/") || course.split("/").some((part) => !part.trim() || part === "." || part === "..")) {
    problems.push(`.course "${course}" must be the course file's full path, "<Folder>/courses/.../<file>.md"`);
  }
  // Both are written into paths as they are: a name the file layer would change cannot be found again.
  for (const key of ["folder", "filePrefix"] as const) {
    const name = e[key] as string;
    if (name !== safeName(name)) problems.push(`.${key} "${name}" must be a plain file name; "${safeName(name)}" would be one`);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(e.slug as string)) problems.push(`.slug "${e.slug}" must be lower-case words joined by "-"`);
  if (!/^[a-z0-9-]*$/.test(e.moduleSlugPrefix as string)) problems.push(`.moduleSlugPrefix "${e.moduleSlugPrefix}" may hold only lower-case letters, digits and "-"`);
  if (!/^https?:\/\/[^\s/]+(?:\/\S*)?$/.test(e.siteUrl as string)) problems.push(`.siteUrl "${e.siteUrl}" must be an http(s) link`);

  if (!isNames(e.authors, false)) problems.push(".authors must be a non-empty list of names (Lens articles require one); a chapter's own authors replace them");
  const chapters = e.chapters;
  if (!Array.isArray(chapters) || !chapters.length) problems.push(`.chapters must be a non-empty list of chapters in order, each ${CHAPTER_SHAPE}`);
  else {
    const docs = new Map<string, number>();
    chapters.forEach((chapter: unknown, i) => {
      const at = `.chapters[${i}]`;
      if (!chapter || typeof chapter !== "object" || Array.isArray(chapter)) return problems.push(`${at} must be ${CHAPTER_SHAPE}`);
      const c = chapter as Record<string, unknown>;
      const unknownKeys = Object.keys(c).filter((key) => !CHAPTER_KEYS.includes(key));
      if (unknownKeys.length) problems.push(`${at} has unknown key(s) ${unknownKeys.map((key) => `"${key}"`).join(", ")}; the keys are ${CHAPTER_KEYS.join(", ")}`);
      if (c.authors !== undefined && !isNames(c.authors, false)) problems.push(`${at}.authors must be a non-empty list of names, or left out for the course's authors`);
      if (c.acknowledgements !== undefined && !isNames(c.acknowledgements, true)) problems.push(`${at}.acknowledgements must be a list of names`);
      const ref = typeof c.doc === "string" ? parseGoogleDocUrl(c.doc) : null;
      if (!ref) return problems.push(`${at}.doc is not a Google Docs link: ${JSON.stringify(c.doc)}`);
      if (!ref.tabId) return problems.push(`${at}.doc must name its tab: add ?tab=<id> to the link (the Doc's tab ids are in its links)`);
      const twin = docs.get(ref.documentId);
      // The course file records each chapter's revision by Doc id.
      if (twin !== undefined) return problems.push(`${at} is in the same Doc as .chapters[${twin}]; each chapter must be a Doc of its own`);
      docs.set(ref.documentId, i);
    });
  }
  if (e.appendicesOptional !== undefined && typeof e.appendicesOptional !== "boolean") problems.push(".appendicesOptional must be true or false");
  const fields = e.courseFields;
  if (fields !== undefined) {
    if (!fields || typeof fields !== "object" || Array.isArray(fields) || !Object.values(fields).every((value) => typeof value === "string" && value.trim())) {
      problems.push(".courseFields must be an object of text fields, none empty");
    } else {
      const own = Object.keys(fields).filter((key) => OWN_COURSE_FIELDS.includes(key));
      if (own.length) problems.push(`.courseFields may not set ${own.join(", ")}: the sync writes ${own.length > 1 ? "them" : "it"} itself`);
      const bad = Object.keys(fields).filter((key) => !/^[A-Za-z][A-Za-z0-9_-]*$/.test(key));
      if (bad.length) problems.push(`.courseFields has field name(s) that are not plain words: ${bad.map((key) => JSON.stringify(key)).join(", ")}`);
    }
  }
  return problems;
}

/**
 * Parse ATLAS_SYNC_COURSES: [] when it is unset or empty. Throws one error
 * that lists every problem of every entry.
 */
export function parseAtlasCourses(raw = process.env[ATLAS_COURSES_ENV]): AtlasCourseConfig[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${ATLAS_COURSES_ENV} is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${ATLAS_COURSES_ENV} must be a JSON list of courses`);

  const problems = parsed.flatMap((entry, i) => problemsOf(entry).map((problem) => `${ATLAS_COURSES_ENV}[${i}]${problem.startsWith(".") ? "" : " "}${problem}`));
  const configs = problems.length ? [] : (parsed as AtlasCourseConfig[]).map(normalized);
  for (const [i, config] of configs.entries()) {
    const twin = configs.findIndex((other) => other.course === config.course || other.folder === config.folder);
    if (twin < i) problems.push(`${ATLAS_COURSES_ENV}[${i}] has the same course file or folder as [${twin}]; they would write the same files`);
  }
  if (problems.length) throw new Error(problems.join("\n"));
  return configs;
}

function normalized(config: AtlasCourseConfig): AtlasCourseConfig {
  return {
    ...config,
    course: config.course.trim(),
    slug: config.slug.trim(),
    title: config.title.trim(),
    filePrefix: config.filePrefix.trim(),
    siteUrl: config.siteUrl.trim().replace(/\/+$/, ""),
    authors: config.authors.map((name) => name.trim()),
    chapters: config.chapters.map((chapter) => ({
      doc: chapter.doc.trim(),
      ...(chapter.authors ? { authors: chapter.authors.map((name) => name.trim()) } : {}),
      ...(chapter.acknowledgements ? { acknowledgements: chapter.acknowledgements.map((name) => name.trim()) } : {}),
    })),
  };
}

/** The configuration of the chapter a Doc link names. */
export const chapterConfig = (config: AtlasCourseConfig, url: string): AtlasChapterConfig | undefined => config.chapters.find((c) => sameChapter(c.doc, url));

/**
 * A hash of everything in a course's configuration that shapes its files,
 * recorded in the course file (`sync_config`): a run whose configuration
 * differs converts every chapter, so a change of credits, folder or prefix
 * reaches the files at the next run.
 */
export function configHash(config: AtlasCourseConfig): string {
  const { course, slug, title, folder, filePrefix, moduleSlugPrefix, siteUrl, authors, chapters, appendicesOptional = true, courseFields = {} } = config;
  const shaping = [course, slug, title, folder, filePrefix, moduleSlugPrefix, siteUrl, authors, appendicesOptional, Object.entries(courseFields).sort()];
  const credits = chapters.map((c) => [chapterRef(c.doc).url, c.authors ?? null, c.acknowledgements ?? []]);
  return createHash("sha256").update(JSON.stringify([...shaping, credits])).digest("hex").slice(0, 12);
}
