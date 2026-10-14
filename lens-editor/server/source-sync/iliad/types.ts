/**
 * Iliad Intensive course sync: keep the Iliad course in Lens Edu (its course
 * file, module files and lenses) a read-only copy of what
 * https://iliad-intensive.org publishes.
 *
 * One run:
 *   1. read a Snapshot of the source (snapshot.ts)
 *   2. turn each worksheet into Atoms of Lens markdown (convert.ts)
 *   3. group each worksheet's Atoms into lenses (plan.ts) -- boundaries that
 *      already exist are pinned, so lens ids (which learner progress is keyed
 *      on) survive every edit Iliad makes
 *   4. compose the lens, module and course files and write what changed
 *      (course-files.ts)
 *
 * This file is the contract between those steps. Each step is a pure
 * function of the values named here, apart from the two that touch the
 * network: the snapshot reader and CourseFiles.
 */

// ---------------------------------------------------------------- source

/** A lettered group of teaching days in Iliad's schedule.yaml ("B -- Learning"). */
export interface Cluster {
  id: string;
  label: string;
  /** First path segment of the cluster's pages: /learning/training-dynamics/. */
  urlSlug: string;
}

/** One published page of the course: a teaching day, or one of a day's parts. */
export interface Worksheet {
  /** Folder name under tex/ and last URL segment: "aixi". Iliad's stable name for the page. */
  slug: string;
  cluster: Cluster;
  /** The day in schedule.yaml: "D.3", "AIXI". */
  dayCode: string;
  dayTitle: string;
  /**
   * The code the site shows: the day code, plus ".n" when the day lists
   * several worksheets ("D.3.2"). A day with one worksheet is never numbered.
   */
  code: string;
  title: string;
  summary: string | null;
  contributors: string[];
  slides: string | null;
  /** https://iliad-intensive.org/agency/aixi/ */
  pageUrl: string;
  /** The built MDX with solutions, frontmatter removed. */
  mdx: string;
}

export interface Snapshot {
  /** The source commit the published site was built from. */
  commit: string;
  /** Every listed worksheet, in taught order. */
  worksheets: Worksheet[];
  /** Bytes of a published file, by site path ("/uploads/aixi/tikz-4dc0e19d14b9.svg"). */
  asset(sitePath: string): Promise<Uint8Array>;
  /** What the read could not check about the site's state, for the run's report. */
  warnings: string[];
  /**
   * When this state of the site was deployed (its pages' `Last-Modified`);
   * null when the site does not say. A run waits before it applies a change
   * that retires or removes something until the deploy has stood a while,
   * because a bad deploy is often fixed within the hour.
   */
  deployedAt: Date | null;
}

// ------------------------------------------------------------ conversion

/** One stretch of a lens: Lens markdown for a Text segment, or an embedded video. */
export type AtomPart =
  | { kind: "text"; markdown: string }
  | { kind: "video"; youtubeId: string; title: string | null };

/**
 * A stretch of a worksheet that a lens can start at: from one H2, H3 or H4
 * heading, or one exercise that has an id, to the next. A lens is one or
 * more consecutive Atoms of one worksheet. New lenses are cut at H2 and H3
 * only. H4 headings and exercises are places a lens of the hand import
 * starts at, and the last resort for a section too long to keep whole.
 */
export interface Atom {
  /**
   * The id the site gives the place the atom starts at: a heading's anchor
   * ("1-properties-of-the-bayesian-mixture") or an exercise's id
   * ("prob-posterior-update"); "" for text before the first heading. Unique
   * within a worksheet.
   */
  anchor: string;
  /** The heading's level; 5 for an exercise; 0 for text before the first heading. */
  level: 0 | 2 | 3 | 4 | 5;
  /** Heading text as plain text; "" when the atom starts at no heading. */
  title: string;
  /**
   * Reading size the planner fills lenses by: whitespace-separated tokens of
   * the source; 0 for an atom a learner sees none of (it is all hidden).
   */
  words: number;
  /** The content, heading included, in reading order. */
  parts: AtomPart[];
  /** External links in the atom, in order: what a reading is picked from. */
  links: { text: string; url: string }[];
}

export interface Converted {
  atoms: Atom[];
  /** Things in the source that could not be carried over faithfully. */
  warnings: string[];
}

/**
 * Turn a worksheet into Atoms. `hostImage` is given the site path of a
 * figure and resolves to the URL to embed.
 */
export type ConvertWorksheet = (
  worksheet: Worksheet,
  hostImage: (sitePath: string) => Promise<string>,
) => Promise<Converted>;

// -------------------------------------------------------------- planning

/** "<worksheet slug>#<anchor of the lens's first atom>": what a lens is pinned to. */
export type LensKey = string;

export function lensKey(slug: string, anchor: string): LensKey {
  return `${slug}#${anchor}`;
}

/** A lens that already exists, in the order the module files list it. */
export interface Pin {
  key: LensKey;
  /** The lens `id` in its frontmatter. Never regenerated. */
  id: string;
  /**
   * Text fingerprint of the lens as last written, for finding it again
   * after Iliad renames its first heading. Opaque outside plan.ts.
   */
  fingerprint: string;
}

/** One lens to exist after this run. */
export interface PlannedLens {
  key: LensKey;
  /** The Pin this lens continues, or null for a lens the run creates. */
  pinned: Pin | null;
  atoms: Atom[];
}

// ----------------------------------------------------------------- files

/**
 * The Lens Edu files the sync reads and writes. Paths are full Relay paths
 * ("Lens Edu/Lenses/Iliad/B.3 Singular Learning Theory/x.md"). In
 * production this is the relay's server API; in tests and the dry run, a
 * directory.
 */
export interface CourseFiles {
  /** Current content of a file, or null when it does not exist. */
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  /** Rename a file, keeping its history. The target must not exist. */
  move(from: string, to: string): Promise<void>;
  /** Move a file to the folder's trash. */
  trash(path: string): Promise<void>;
  /** Host image bytes in the folder; resolves to the URL to embed. */
  hostImage(bytes: Uint8Array, stem: string): Promise<string>;
}

/** What one run did, or would do in a dry run. */
export interface SyncReport {
  commit: string;
  /** True when the run wrote, moved or retired a file, or in a dry run would have. */
  changed: boolean;
  written: string[];
  moved: { from: string; to: string }[];
  retired: string[];
  warnings: string[];
  /**
   * Set when the run applied nothing because its changes retire or remove
   * something and the deploy is too fresh: when the next run may apply them.
   */
  waitingUntil?: Date;
}
