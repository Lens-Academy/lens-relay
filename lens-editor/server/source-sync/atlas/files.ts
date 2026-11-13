/**
 * Step 6 of the Atlas sync: compose the course, module, lens and article
 * files from the plan, and the steps that bring Lens Edu to them
 * (iliad/course-files.ts `applyFilePlan` carries them out).
 *
 * Each file is the sync's: its body is composed whole, and so is every
 * frontmatter field the sync writes. Other fields are kept where they stand
 * (setFrontmatter), and so are `id` and an article's `published` once set.
 * A file is written only when its text differs.
 *
 * The order: articles, lenses, modules, the trash, then the course file.
 * Articles come before the lenses that link to them, so that a run that
 * stops halfway leaves no lens linking to an article not there yet; a new
 * lens is part of the course only once its module lists it; a lens is
 * trashed once no module lists it, and before its article, which it links
 * to; the course file, with the revisions of this run, is last, so that a
 * run that stops early is done again by the next one.
 */

import { posix } from "node:path";
import { SYNC_TAG } from "../article";
import { escapeInline } from "../google-docs/to-markdown";
import type { FilePlan, Step } from "../iliad/course-files";
import { linkTo, plainTitle, safeName } from "../iliad/layout";
import { setFrontmatter, withoutSuggestions } from "../iliad/module-file";
import { yamlQuote } from "../../yaml";
import { chapterConfig, chapterRef, configHash, sameChapter } from "./config";
import { printToStore, type AtlasChapter, type AtlasPlan } from "./plan";
import { isAppendix } from "./sections";
import { atlasFolders, ATLAS_SOURCE, idOf, parsed } from "./state";
import type { AtlasCourseConfig, AtlasCourseState, AtlasLens, AtlasModule, Section } from "./types";

/** Where each section's lens and article, and each chapter's module, go. */
export interface CoursePaths {
  sections: Map<Section, { lens: string; article: string }>;
  modules: Map<AtlasChapter, string>;
}

/** The module of a chapter the course has: by its slug, or by its Doc when the chapter was renamed. */
const moduleOf = (state: Pick<AtlasCourseState, "modules">, chapter: AtlasChapter): AtlasModule | undefined =>
  state.modules.find((m) => m.chapterSlug === chapter.facts.slug) ?? state.modules.find((m) => sameChapter(m.url, chapter.source.url));

/**
 * The slug Lens gives a lens or an article from its file name, which must be
 * unique across Lens Edu (lens-platform content_processor/src/utils/slug.ts,
 * `fileNameToSlug`; its validator reports a duplicate as an error).
 */
const lensSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "untitled";

/**
 * The paths of a course's files: "<filePrefix> - <Chapter> - <Section>" in
 * the lens and article folders, "Chapter <N> - <Title>" in the module
 * folder. A section's name gets " <chapter>.<section>" (and then " 2", " 3")
 * when its Lens slug says nothing of the section (a title with no ASCII
 * letters), or when its path or slug is taken: by another file of the course
 * (a lens that waits to be retired, a section renamed to another's old
 * name) or by a file that is not the sync's. So no move lands on a file, no
 * two files share a slug, and no clash stops a run; a later run that plans
 * the course gives the plain name back once it is free.
 */
export function coursePaths(config: AtlasCourseConfig, chapters: { chapter: AtlasChapter; sections: { section: Section; pin: AtlasLens | null }[] }[], state: Pick<AtlasCourseState, "pins" | "modules" | "occupied">): CoursePaths {
  const folders = atlasFolders(config);
  const lower = (path: string) => path.toLowerCase();
  const assigned = new Set<string>();
  const slugs = new Set<string>();
  const nameOf = (path: string) => posix.basename(path, ".md");
  const pick = (names: Iterable<string>, paths: (name: string) => string[], held: string[], slugged: boolean): string[] => {
    const taken = new Set([...state.occupied, ...held].map(lower));
    const takenSlugs = new Set([...state.occupied, ...held].map((path) => lensSlug(nameOf(path))));
    for (const name of names) {
      const candidate = paths(name);
      if (candidate.some((path) => taken.has(lower(path)) || assigned.has(lower(path)))) continue;
      if (slugged && (takenSlugs.has(lensSlug(name)) || slugs.has(lensSlug(name)))) continue;
      for (const path of candidate) assigned.add(lower(path));
      if (slugged) slugs.add(lensSlug(name));
      return candidate;
    }
    throw new Error("unreachable: the names run on without end");
  };
  function* numbered(first: string[], base: string) {
    yield* first;
    for (let n = 2; ; n++) yield `${base} ${n}`;
  }
  const result: CoursePaths = { sections: new Map(), modules: new Map() };
  for (const { chapter, sections } of chapters) {
    const own = moduleOf(state, chapter);
    const moduleName = safeName(`Chapter ${chapter.facts.number} - ${chapter.facts.title}`);
    const [module] = pick(numbered([moduleName], moduleName), (name) => [`${folders.modules}/${name}.md`], state.modules.filter((m) => m !== own).map((m) => m.path), false);
    result.modules.set(chapter, module);
    for (const { section, pin } of sections) {
      const held = state.pins.filter((other) => other !== pin).flatMap((other) => [other.lensPath, other.articlePath]);
      const base = safeName(`${config.filePrefix} - ${chapter.facts.title} - ${section.title}`);
      const said = lensSlug(base) !== lensSlug(safeName(`${config.filePrefix} - ${chapter.facts.title}`));
      const located = safeName(`${base.slice(0, 108)} ${chapter.facts.number}.${section.number}`);
      const [lens, article] = pick(numbered(said ? [base, located] : [located], located), (name) => [`${folders.lenses}/${name}.md`, `${folders.articles}/${name}.md`], held, true);
      result.sections.set(section, { lens, article });
    }
  }
  return result;
}

export interface FilesInput {
  config: AtlasCourseConfig;
  state: AtlasCourseState;
  plan: AtlasPlan;
  paths: CoursePaths;
  /** Article Markdown by lens id, for the chapters converted this run. A section without one keeps its article's text. */
  articles: Map<string, string>;
  /** The revision of every chapter, by Doc id, to record: this run's, or the last run's for a chapter it did not read. */
  revisions: Map<string, string>;
  /** The combined revision of the run (FilePlan.commit). */
  revision: string;
  syncRules: number;
  /** YYYY-MM-DD, for a new article's `published`. */
  today: string;
  newId: () => string;
}

const marker = (url: string): string => `synced_from:\n  source: ${ATLAS_SOURCE}\n  url: ${yamlQuote(url)}`;
const list = (key: string, items: string[]): string => [`${key}:`, ...items.map((item) => `  - ${yamlQuote(item)}`)].join("\n");
const mapping = (key: string, entries: Map<string, string>): string | null =>
  entries.size ? [`${key}:`, ...[...entries].map(([k, v]) => `  ${yamlQuote(k)}: ${yamlQuote(v)}`)].join("\n") : null;
const text = (key: string, value: string | null): string | null => (value === null ? null : `${key}: ${yamlQuote(value)}`);

/** The head of a file as it is, and its fields; an empty head for a new file. */
function headOf(path: string, content: string | null | undefined): { head: string; data: Record<string, unknown> } {
  return content ? parsed(path, content) : { head: "", data: {} };
}

const hasId = (data: Record<string, unknown>) => typeof data.id === "string" && !!data.id.trim();

/** 200 words a minute, as the Atlas's site counts; at least 1. */
const readingMinutes = (words: number): number => Math.max(1, Math.round(words / 200));

const moduleTitle = (facts: AtlasChapter["facts"]): string => plainTitle(`Chapter ${facts.number}: ${facts.title}`);

export function planAtlasFiles(input: FilesInput): FilePlan {
  const { config, state, plan, paths } = input;
  const steps: Step[] = [];
  const removes: string[] = [];
  const warnings: string[] = [];
  const contents = state.contents;

  /** Bring the file now at `from` (or at `path`) to `path` and to `content`; null content keeps its text. */
  const place = (path: string, from: string | null, content: string | null): void => {
    const origin = from && contents.get(from) != null ? from : path;
    const current = contents.get(origin) ?? null;
    let expects = current ?? undefined;
    if (current !== null && origin !== path) {
      steps.push({ do: "move", from: origin, to: path, expects });
      expects = undefined;
    }
    if (content === null || content === current) return;
    steps.push({ do: "write", path, content, ...(expects !== undefined ? { expects } : {}) });
    if (current !== null && current !== withoutSuggestions(current)) warnings.push(`"${path}" had pending suggestions; the sync rewrote it, so they are gone. To change it, edit the Doc.`);
  };

  const sections = plan.chapters.flatMap(({ chapter, sections }) => sections.map((planned) => ({ chapter, planned, at: paths.sections.get(planned.section)! })));

  // 1. Articles.
  for (const { chapter, planned, at } of sections) {
    const markdown = input.articles.get(planned.id);
    const from = planned.pin?.articlePath || null;
    if (markdown === undefined) {
      place(at.article, from, null);
      continue;
    }
    const { head, data } = headOf(at.article, contents.get(from ?? at.article) ?? contents.get(at.article));
    const own = chapterConfig(config, chapter.source.url);
    const fields = {
      title: text("title", plainTitle(planned.section.title)),
      author: list("author", own?.authors ?? config.authors),
      source_url: text("source_url", `${config.siteUrl}/${[chapter.facts.slug, planned.section.slug].filter(Boolean).join("/")}/`),
      ...(data.published !== undefined && data.published !== null ? {} : { published: `published: ${input.today}` }),
      tags: list("tags", [SYNC_TAG]),
      synced_from: marker(chapter.source.url),
    };
    const thanked = planned.section.number === 1 ? (own?.acknowledgements ?? []) : [];
    place(at.article, from, `${setFrontmatter(head, fields)}\n${withAcknowledgements(markdown.trim(), thanked)}\n`);
  }

  // 2. Lenses.
  for (const { chapter, planned, at } of sections) {
    const from = planned.pin?.lensPath ?? null;
    const current = contents.get(from ?? at.lens) ?? contents.get(at.lens);
    const { head, data } = headOf(at.lens, current);
    const title = plainTitle(planned.section.title);
    const compose = (print: string) => {
      const fields = {
        ...(hasId(data) ? {} : { id: `id: ${planned.id}` }),
        title: text("title", title),
        tldr: text("tldr", planned.section.description),
        summary_for_tutor: text("summary_for_tutor", planned.section.description),
        reading_minutes: `reading_minutes: ${readingMinutes(planned.section.words)}`,
        synced_from: marker(chapter.source.url),
        upstream_key: text("upstream_key", planned.key),
        upstream_heading: text("upstream_heading", planned.section.headingId),
        upstream_fingerprint: text("upstream_fingerprint", print),
      };
      return `${setFrontmatter(head, fields)}\n#### Article\nrender-as-non-article-text:: true\nsource:: [[${linkTo(at.lens, at.article)}|${title}]]\n`;
    };
    // The stored fingerprint stays through small edits; a lens rewritten anyway gets the fresh one.
    const kept = compose(planned.pin ? printToStore(planned.pin.fingerprint, planned.fingerprint) : planned.fingerprint);
    place(at.lens, from, kept === current ? kept : compose(planned.fingerprint));
  }

  // 3. Modules.
  const written = new Map<AtlasChapter, string>();
  const done = new Set<AtlasModule>();
  for (const { chapter, sections: planned, waiting } of plan.chapters) {
    const existing = moduleOf(state, chapter);
    if (existing) done.add(existing);
    const path = paths.modules.get(chapter)!;
    const entries = moduleEntries(planned.map((p) => ({ pin: p.pin, title: plainTitle(p.section.title), lensPath: paths.sections.get(p.section)!.lens, appendix: p.section.appendix })), waiting, existing);
    if (!entries.length && !existing && contents.get(path) == null) {
      warnings.push(`Chapter ${chapter.facts.number} (${chapter.facts.title}) has no sections, so the course has no module for it yet.`);
      continue;
    }
    const { head, data } = headOf(path, contents.get(existing?.path ?? path) ?? contents.get(path));
    const fields = {
      ...(hasId(data) ? {} : { id: `id: ${existing?.id ?? idOf(state, path) ?? input.newId()}` }),
      slug: `slug: ${config.moduleSlugPrefix}${chapter.facts.slug}`,
      title: text("title", moduleTitle(chapter.facts)),
      synced_from: marker(chapter.source.url),
    };
    const optional = config.appendicesOptional ?? true;
    const body = entries.map((e) => `# Lens: ${e.title}\n${optional && e.appendix ? "optional:: true\n" : ""}source:: [[${linkTo(path, e.lensPath)}]]\n`).join("\n");
    place(path, existing?.path ?? null, `${setFrontmatter(head, fields)}\n${body}`);
    written.set(chapter, `# Module: [[${linkTo(config.course, path)}|${moduleTitle(chapter.facts)}]]`);
  }
  // The course lists the chapters in the configured order. A chapter this run did not read keeps its line where it
  // is; a module of no configured chapter keeps its line at the end, because the sync never removes a chapter.
  const courseLines: string[] = [];
  for (const { doc } of config.chapters) {
    const planned = plan.chapters.find((c) => sameChapter(c.chapter.source.url, doc));
    const kept = planned ? undefined : state.modules.find((m) => !done.has(m) && sameChapter(m.url, doc));
    if (kept) done.add(kept);
    const line = planned ? written.get(planned.chapter) : kept?.line;
    if (line) courseLines.push(line);
  }
  for (const module of state.modules) {
    if (done.has(module)) continue;
    courseLines.push(module.line);
    warnings.push(`The course lists the module "${module.path}", which is of no chapter in ATLAS_SYNC_COURSES; it is left as it is. The sync never removes a chapter by itself: to remove it, delete its "# Module:" line from the course file, then its files.`);
  }

  // 4. The trash.
  for (const { pin, reason } of plan.retired) {
    for (const path of [pin.lensPath, pin.articlePath]) {
      const current = contents.get(path);
      if (path && current != null) steps.push({ do: "trash", path, expects: current });
    }
    removes.push(`Lens retired: "${pin.title}" (${pin.lensPath}), with its article: ${reason}.`);
  }

  // 5. The course file.
  const record = { revisions: input.revisions, missingSince: plan.missingSince, syncRules: input.syncRules };
  place(config.course, null, courseFile(config, contents.get(config.course) ?? null, courseLines, input.newId, record));

  return { commit: input.revision, changed: steps.length > 0, steps, removes, warnings: [...plan.warnings, ...warnings] };
}

/**
 * The course file: its own fields, its module lines, and the record of the
 * run that finished. Without a record it is the placeholder a first run
 * writes before any other file, so that a run that stops early leaves a
 * course file to start from again.
 */
export function courseFile(
  config: AtlasCourseConfig,
  current: string | null,
  lines: string[],
  newId: () => string,
  record?: { revisions: Map<string, string>; missingSince: Map<string, string>; syncRules: number },
): string {
  const { head, data } = headOf(config.course, current);
  const fields: Record<string, string | null> = {
    ...(hasId(data) ? {} : { id: `id: ${newId()}` }),
    slug: `slug: ${config.slug}`,
    title: text("title", config.title),
    ...Object.fromEntries(Object.entries(config.courseFields ?? {}).map(([key, value]) => [key, `${key}: ${yamlQuote(value)}`])),
    synced_from: marker(chapterRef(config.chapters[0].doc).url),
    ...(record && {
      upstream_revisions: mapping("upstream_revisions", record.revisions),
      missing_since: mapping("missing_since", record.missingSince),
      sync_rules: `sync_rules: ${record.syncRules}`,
      sync_config: `sync_config: ${yamlQuote(configHash(config))}`,
    }),
  };
  return `${setFrontmatter(head, fields)}${lines.map((line) => `${line}\n`).join("")}`;
}

const thanksFor = (names: string[]): string => `We thank ${escapeInline(names.join(", ").replace(/, ([^,]*)$/, " and $1"))} for their valuable feedback and contributions.`;

/** The footnote definitions convertSection writes last, one a line. */
const FOOTNOTES = /\n\n((?:\[\^note-[^\]\n]+\]: .*(?:\n|$))+)$/;

/**
 * A chapter's first article ends as the section does on the Atlas's site
 * (src/pages/chapters/[version]/[chapter]/[section].astro there): with its
 * thanks, worded as the site words them, before the footnotes.
 */
export function withAcknowledgements(markdown: string, names: string[]): string {
  if (!names.length) return markdown;
  if (!markdown) return thanksFor(names);
  const notes = FOOTNOTES.exec(markdown);
  return notes ? `${markdown.slice(0, notes.index)}\n\n${thanksFor(names)}\n\n${notes[1].trimEnd()}` : `${markdown}\n\n${thanksFor(names)}`;
}

interface Entry {
  title: string;
  lensPath: string;
  appendix: boolean;
}

/**
 * A module's lens entries: its sections in order, and each lens that is
 * missing but not yet retired after the entry that came before it in the
 * module as it was.
 */
function moduleEntries(sections: (Entry & { pin: AtlasLens | null })[], waiting: AtlasLens[], existing: AtlasModule | undefined): Entry[] {
  const entries: (Entry & { pin: AtlasLens | null })[] = [...sections];
  const old = existing?.lenses ?? [];
  for (const pin of waiting) {
    const before = old.slice(0, Math.max(0, old.indexOf(pin))).reverse();
    const after = before.map((b) => entries.findIndex((e) => e.pin === b)).find((i) => i >= 0);
    entries.splice(after === undefined ? 0 : after + 1, 0, { pin, title: plainTitle(pin.title) || posix.basename(pin.lensPath, ".md"), lensPath: pin.lensPath, appendix: isAppendix(pin.title) });
  }
  return entries;
}
