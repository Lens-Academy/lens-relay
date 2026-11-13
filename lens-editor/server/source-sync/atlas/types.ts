/**
 * AI Safety Atlas course sync: keep a Lens course (course file, one module per
 * chapter, one lens and one article per section, figure images) a read-only
 * copy of the Atlas's Google Docs, one Doc tab per chapter.
 *
 * It sits beside the Iliad course sync (../iliad/) and shares its file layer
 * (CourseFiles, applyFilePlan) without changing it. A course is configured in
 * ATLAS_SYNC_COURSES; several can be (an edition or a language each).
 *
 * One run, per course (sync.ts):
 *   1. read each chapter tab through the Docs API (snapshot.ts)
 *   2. split each tab into its chapter facts and sections (sections.ts), by
 *      the rules of the Atlas's own site: a section starts at each non-empty
 *      Heading 1
 *   3. read the course as the sync last wrote it (state.ts)
 *   4. plan: existing lenses keep their `id` (learner progress is keyed on
 *      it) by the section's heading, its address, or its text (plan.ts)
 *   5. host the images of the chapters that changed, made WebP first
 *      (images.ts), and convert their sections to article Markdown
 *      (convert.ts, over ../google-docs/to-markdown.ts); figure, video,
 *      definition and interactive-figure numbers run per chapter
 *   6. compose and write what changed (files.ts, then applyFilePlan)
 *
 * This file is the contract between those steps.
 */

import type { DocumentTab, StructuralElement } from "../google-docs/docs-types";

// ------------------------------------------------------------ configuration

/** One course to keep in sync: an entry of ATLAS_SYNC_COURSES (JSON list). */
export interface AtlasCourseConfig {
  /** Full Relay path of the course file: "Lens Edu/courses/in-development/AI Safety Atlas (Google Docs).md". */
  course: string;
  /** Course slug: "ai-safety-atlas-v1". */
  slug: string;
  /** Course title: "AI Safety Atlas". */
  title: string;
  /** Subfolder under modules/, Lenses/ and articles/: "AI Safety Atlas (Google Docs)". */
  folder: string;
  /** Start of every lens and article file name, which Lens makes the lens slug from: "Atlas". */
  filePrefix: string;
  /** Start of every module slug: "atlas-" gives "atlas-capabilities". */
  moduleSlugPrefix: string;
  /** Where the Atlas's own site shows this edition: "https://ai-safety-atlas.com/chapters/v1". */
  siteUrl: string;
  /** Written into each article's `author`, in order, for a chapter that names no authors of its own. */
  authors: string[];
  /** The chapters, in chapter order. */
  chapters: AtlasChapterConfig[];
  /** Mark "Appendix: …" sections optional in their module (default true). */
  appendicesOptional?: boolean;
  /** Extra course-file frontmatter written on every run (partner-name, partner-logo, …). */
  courseFields?: Record<string, string>;
}

/** One chapter of a course, with its credits as the Atlas's site gives them (src/textbook-loader/data.ts there). */
export interface AtlasChapterConfig {
  /** The chapter's Google Docs link, with `?tab=<id>`. */
  doc: string;
  /** The chapter's authors, in the site's order: each article's `author`. The course's `authors` when absent. */
  authors?: string[];
  /** The people the site thanks at the end of the chapter's first section ("We thank A, B and C for ..."). */
  acknowledgements?: string[];
}

// ------------------------------------------------------------------ source

/** One chapter as read: the selected tab of its Doc. */
export interface ChapterSource {
  docId: string;
  /** The chapter's Doc link, as a person opens it to edit (`synced_from.url`). */
  url: string;
  tab: DocumentTab;
  /**
   * Hash of the tab's content with the image download links taken out
   * (they change on every read): what tells a changed chapter from an
   * unchanged one. The Docs API gives `revisionId` only to editors.
   */
  revision: string;
}

/** Where each image of the chapters a run converts is hosted. */
export interface AtlasSnapshot {
  /** Hosted image URL of an inline object of a chapter tab, or null when it could not be hosted. */
  imageUrl(docId: string, inlineObjectId: string): string | null;
  warnings: string[];
}

// ---------------------------------------------------------------- sections

/** What a chapter tab says about the chapter itself (its TITLE paragraph). */
export interface ChapterFacts {
  /** From the TITLE "Chapter <number> - <title>"; 0 when the TITLE does not read so (the run leaves the chapter out). */
  number: number;
  title: string;
  /** The Atlas's slug of `title` (atlasSlug), or "chapter-<number>" when that is empty: "capabilities". */
  slug: string;
}

/** One section: a non-empty Heading 1 and what follows it up to the next. */
export interface Section {
  chapter: ChapterFacts;
  /** 1-based, in document order, per chapter. */
  number: number;
  /** The heading's plain text, trimmed. */
  title: string;
  /** atlasSlug(title): the section's address on the Atlas's site. Empty for a title without ASCII letters. */
  slug: string;
  /** The heading paragraph's `headingId` in the Doc: kept through renames and moves, so what a lens is pinned to. */
  headingId: string | null;
  /** "Appendix: …" titles. */
  appendix: boolean;
  /** Text of the section's `section-description` table, if it has one. */
  description: string | null;
  /** Top-level `body.content` elements after the heading, empty paragraphs included. */
  content: StructuralElement[];
  /** Whitespace-separated words a reader reads, for `reading_minutes` (200 words a minute). */
  words: number;
}

// -------------------------------------------------------------- conversion

/** Numbers already used in this chapter, per component type; convertSection advances them. */
export type ChapterCounters = Map<string, number>;

/** One section's article body: the description, `---`, the converted content, then its footnotes. */
export interface ConvertedSection {
  markdown: string;
  warnings: string[];
}

// ---------------------------------------------------------------- the course

/** A lens the sync wrote before, as read back. */
export interface AtlasLens {
  /** The lens `id`, which learner progress is keyed on. Never regenerated. */
  id: string;
  /** `upstream_heading`: the Doc heading it was written from (Section.headingId); null when unknown. */
  heading: string | null;
  /** `upstream_key`, "<chapter slug>#<section slug>": the section's address when it was written. */
  key: string;
  /** `upstream_fingerprint`: the section's text as last written, to find it again after a rename. */
  fingerprint: string;
  title: string;
  /** `synced_from.url`: its chapter's Doc link, by which a renamed chapter is still found. */
  url: string | null;
  lensPath: string;
  /** Its article, when that is the sync's own; "" otherwise. */
  articlePath: string;
}

export interface AtlasModule {
  path: string;
  /** Its `# Module:` line in the course file. */
  line: string;
  id: string | null;
  /** The chapter slug its `slug` gives (after the course's moduleSlugPrefix), or null. */
  chapterSlug: string | null;
  url: string | null;
  lenses: AtlasLens[];
}

/** What the course file records about the last run that finished. */
export interface AtlasCourseHeader {
  /** Chapter revisions, by Doc id. */
  revisions: Map<string, string>;
  /** Lenses first seen missing, by lens id, with when: retired once a run an hour later still misses them. */
  missingSince: Map<string, string>;
  syncRules: number | null;
  /** The configuration hash (config.ts configHash). */
  syncConfig: string | null;
}

/** The course as the sync last wrote it. */
export interface AtlasCourseState extends AtlasCourseHeader {
  /** The sync's modules the course file lists, in course order. */
  modules: AtlasModule[];
  /** Every lens of the sync's own the modules list, or that an unfinished run left unlisted. */
  pins: AtlasLens[];
  /** Every file read, as it is now (null: it does not exist). The plan's `expects` and kept fields come from here. */
  contents: Map<string, string | null>;
  /** Paths holding a file the sync must not write over: one not its own, or a lens of another section. */
  occupied: Set<string>;
  warnings: string[];
}
