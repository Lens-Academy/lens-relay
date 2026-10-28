/**
 * The Iliad course as Lens Edu holds it now, read from the files themselves:
 * the course file lists the modules, each module lists its lenses. Nothing
 * else records which lenses exist, so a lens no module lists is not part of
 * the course.
 *
 * A module lists two kinds of lens. An Iliad lens is the sync's own: when
 * one is missing or cannot be read the run stops, because carrying on would
 * give its section a new id, and learner progress is keyed on the id. A
 * reading is someone else's file, of which the sync needs only the address
 * of the article it shows: when one cannot be read the run carries on with
 * the address unknown, and says so.
 *
 * Every file is read as Lens publishes it, with each pending suggestion
 * rejected: that is what learners see, and a suggestion may be half of an
 * edit (a heading changed, its block not yet).
 */

import { extractVideoInput } from "../../add-video/video-url";
import { uniqueAnchors } from "./anchor";
import { readSyncMarker, SYNC_MARKER_KEY } from "../../../shared/source-sync";
import { LAYOUT, linkTarget, sourceLink, type Layout } from "./layout";
import { ILIAD_SOURCE, readLensBody, type Card } from "./lens-file";
import { blockFile, field, parseBlocks, splitFrontmatter, withoutSuggestions, type Block, type MarkdownFile } from "./module-file";
import type { CourseFiles } from "./types";

/** A lens the sync owns: its page on iliad-intensive.org is where its text comes from. */
export interface LensState {
  path: string;
  /** The file as it is now. */
  content: string;
  /** The file as Lens publishes it, pending suggestions rejected: what everything below is read from. */
  published: string;
  id: string;
  title: string;
  tldr: string | null;
  summaryForTutor: string | null;
  /** The worksheet it belongs to. */
  slug: string;
  /** `upstream_key`; null in a file of the hand import, which was never pinned. */
  upstreamKey: string | null;
  /** `upstream_fingerprint`; null in a file of the hand import. */
  fingerprint: string | null;
  upstreamCommit: string | null;
  /** Its Text segments' markdown without the cards: what the planner fingerprints. */
  text: string;
  /**
   * Anchors of its headings, in order, as the site numbers them: a heading
   * text that repeats in the worksheet gets "-1", "-2". With `id` and `text`
   * this is what plan.ts adopts a file of the hand import by (its
   * `ExistingLens`).
   */
  headingAnchors: string[];
  cards: Card[];
  /** YouTube ids of its Video segments. */
  videos: string[];
  /** Segment types in it that the sync does not write. A rewrite drops them. */
  others: string[];
}

/** A lens in an Iliad module that the sync does not own: a reading. Never moved or rewritten. */
export interface Reading {
  path: string;
  /** Where the article or video it shows was published; null when that cannot be read. A reading with no known address is never removed. */
  url: string | null;
  /**
   * The module lists a file that does not exist. Without the file nothing
   * says whose it was; course-files.ts takes it for one of the sync's own
   * when it is in a folder where the sync keeps a day's lenses.
   */
  missing?: true;
}

/** A block of a module file. A `# Lens:` block brings in a lens of the sync's own, or a reading. */
export interface ModuleBlock extends Block {
  lens?: LensState;
  reading?: Reading;
}

export interface ModuleState {
  path: string;
  content: string;
  /** As Lens publishes it, pending suggestions rejected: what `blocks` are read from. */
  published: string;
  head: string;
  title: string;
  blocks: ModuleBlock[];
}

export interface CourseBlock extends Block {
  /** The module a `# Module:` block brings in. */
  module?: ModuleState;
}

export interface CourseState {
  path: string;
  content: string;
  /** As Lens publishes it, pending suggestions rejected: what `blocks` are read from. */
  published: string;
  head: string;
  blocks: CourseBlock[];
  /** `upstream_commit` of the course file: the source commit of the last run that finished. */
  commit: string | null;
  /** `sync_rules` of the course file: the version of the sync's rules that run had (course-files.ts SYNC_RULES). */
  rules: string | null;
  /** In course order. */
  modules: ModuleState[];
  /** Every Iliad lens the modules list, in course order. */
  lenses: LensState[];
  /** YouTube id to the transcript the course already uses for it. */
  transcripts: Map<string, string>;
  /** What a person should know about the files as they were read. */
  warnings: string[];
}

const ILIAD_PAGE = /^https?:\/\/(?:www\.)?iliad-intensive\.org\/(?:[^/?#]+\/)*([^/?#]+)\/?(?:[?#].*)?$/;

/**
 * Whether a lens is the sync's own, by what its frontmatter says and never
 * by its name ("Iliad reading - ..." is a reading): it has the sync's
 * marker, or its source is a page of iliad-intensive.org (the hand import).
 */
function isOwn(data: Record<string, unknown>): boolean {
  return readSyncMarker(data)?.source === ILIAD_SOURCE || ILIAD_PAGE.test(field(data, "source_url") ?? "");
}

/** The same for frontmatter that cannot be parsed: the lines the sync and the hand import write. */
function looksOwn(content: string): boolean {
  return new RegExp(`^${SYNC_MARKER_KEY}\\s*:\\s*\\n\\s+source\\s*:\\s*["']?${ILIAD_SOURCE}["']?\\s*$|^source_url\\s*:\\s*["']?https?:\\/\\/(?:www\\.)?iliad-intensive\\.org\\/`, "m").test(content);
}

/** The worksheet a lens of the sync's own is a copy of: its pin says, else its page. */
function worksheetSlug(data: Record<string, unknown>): string | null {
  const key = field(data, "upstream_key");
  if (key?.includes("#")) return key.slice(0, key.indexOf("#"));
  return field(data, "source_url")?.match(ILIAD_PAGE)?.[1] ?? null;
}

/** `fn` over `items`, a few at a time: production's relay is a small machine. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function readCourseState(files: CourseFiles, layout: Layout = LAYOUT): Promise<CourseState> {
  const reads = new Map<string, Promise<string | null>>();
  const read = (path: string) => reads.get(path) ?? reads.set(path, files.read(path)).get(path)!;
  const warnings: string[] = [];
  /** A frontmatter field of the file a lens shows; null when the file or the field is missing. */
  const shown = async (lensPath: string, link: string | null, key: string): Promise<string | null> => {
    const content = link ? await read(linkTarget(lensPath, link)) : null;
    try {
      return content === null ? null : field(splitFrontmatter(withoutSuggestions(content)).data, key);
    } catch {
      return null;
    }
  };

  const bodies = new Map<LensState, ReturnType<typeof readLensBody>>();
  const transcripts = new Map<string, string>();
  const lensFiles = new Map<string, Promise<{ lens?: LensState; reading?: Reading }>>();

  const readLens = async (path: string, module: string, title: string): Promise<{ lens?: LensState; reading?: Reading }> => {
    const listed = `The module "${module}" lists it as "${title}".`;
    /** Stop: this is a lens of the sync's own, and without it the run cannot keep the lens's id. */
    const stop = (problem: string, toDo: string) =>
      new Error(
        `The lens file "${path}" ${problem}. ${listed} The sync stopped and changed nothing: without this file it would make a new lens for the section, with a new id, and learners would lose their progress on it. To do: ${toDo}`,
      );
    /** Carry on: this is someone else's lens, and the sync only does not know which article it shows. */
    const unknown = (problem: string, toDo: string): { reading: Reading } => {
      warnings.push(`The reading "${path}" ${problem}. ${listed} The sync left its entry as it is and will not remove it. ${toDo}`);
      return { reading: { path, url: null } };
    };

    const content = await read(path);
    if (content === null) return { reading: { ...unknown("does not exist", "To do: correct the link in the module, or delete the entry.").reading, missing: true } };
    const published = withoutSuggestions(content);
    let file: MarkdownFile;
    try {
      file = splitFrontmatter(published);
    } catch (err) {
      const problem = `has frontmatter that is not valid YAML (${(err as Error).message.split("\n")[0]})`;
      if (!looksOwn(content)) return unknown(problem, "Nothing to do for the sync; correct the lines between the two --- if Lens shows the file wrongly.");
      throw stop(problem, "open the file and correct the lines between the two ---.");
    }
    const slug = isOwn(file.data) ? worksheetSlug(file.data) : null;
    if (isOwn(file.data) && !slug) throw stop("has no upstream_key and no source_url on iliad-intensive.org", "put the lens's frontmatter back (the file's history in the Lens Editor has it).");
    if (!slug) {
      const source = sourceLink(file.body);
      return { reading: { path, url: (await shown(path, source, "source_url")) ?? (await shown(path, source, "url")) } };
    }
    const id = field(file.data, "id");
    if (!id) throw stop("has no id in its frontmatter", "put the lens's id back (the file's history in the Lens Editor has it).");
    const body = readLensBody(file.body);
    const videos: string[] = [];
    for (const part of body.parts) {
      if (!("video" in part)) continue;
      const video = extractVideoInput((await shown(path, part.video, "url")) ?? "")?.video_id;
      if (!video) continue;
      videos.push(video);
      transcripts.set(video, linkTarget(path, part.video));
    }
    const lens: LensState = {
      path,
      content,
      published,
      id,
      title: field(file.data, "title") ?? "",
      tldr: field(file.data, "tldr"),
      summaryForTutor: field(file.data, "summary_for_tutor"),
      slug,
      upstreamKey: field(file.data, "upstream_key"),
      fingerprint: field(file.data, "upstream_fingerprint"),
      upstreamCommit: field(file.data, "upstream_commit"),
      text: body.parts.flatMap((part) => ("text" in part ? part.text : [])).join("\n\n"),
      headingAnchors: [],
      cards: [],
      videos,
      others: body.others,
    };
    bodies.set(lens, body);
    return { lens };
  };

  /** A course or module file: the sync cannot work without it. */
  const readOwn = async (path: string, problemIfMissing: string): Promise<{ content: string; published: string; file: MarkdownFile }> => {
    const content = await read(path);
    if (content === null) throw new Error(`${problemIfMissing} The sync stopped and changed nothing.`);
    const published = withoutSuggestions(content);
    try {
      return { content, published, file: splitFrontmatter(published) };
    } catch (err) {
      throw new Error(`"${path}" has frontmatter that is not valid YAML (${(err as Error).message.split("\n")[0]}). The sync stopped and changed nothing. To do: open the file and correct the lines between the two ---.`);
    }
  };

  const readModule = async (path: string): Promise<ModuleState> => {
    const { content, published, file } = await readOwn(path, `The course file "${layout.course}" lists the module "${path}", which does not exist. To do: correct the "# Module:" link in the course file, or restore the module from the folder's trash (_trash/).`);
    const blocks = await mapLimit(parseBlocks(file.body), 6, async (block): Promise<ModuleBlock> => {
      const file = blockFile(block, path);
      if (!file) return block;
      if (!lensFiles.has(file)) lensFiles.set(file, readLens(file, path, block.title));
      return { ...block, ...(await lensFiles.get(file)!) };
    });
    return { path, content, published, head: file.head, title: field(file.data, "title") ?? "", blocks };
  };

  const { content, published, file: course } = await readOwn(layout.course, `The course file "${layout.course}" does not exist. To do: check the path the sync was started with.`);
  const blocks: CourseBlock[] = parseBlocks(course.body);
  const modulePaths = [...new Set(blocks.flatMap((block) => blockFile(block, layout.course) ?? []))];
  const modules: ModuleState[] = [];
  for (const path of modulePaths) modules.push(await readModule(path));
  for (const block of blocks) block.module = modules[modulePaths.indexOf(blockFile(block, layout.course) ?? "")];

  const lenses = [...new Set(modules.flatMap((module) => module.blocks.flatMap((block) => block.lens ?? [])))];
  const ids = new Map<string, LensState>();
  for (const lens of lenses) {
    const twin = ids.get(lens.id);
    if (twin) {
      throw new Error(
        `"${twin.path}" and "${lens.path}" have the same id ${lens.id}. The sync stopped and changed nothing: Lens shows only one of two lenses with one id. To do: if one is a copy made by hand, give it a new id (any new UUID) or delete it and its entry in the module.`,
      );
    }
    ids.set(lens.id, lens);
  }

  // Anchors run through a whole worksheet: a lens that starts in the middle
  // of a section is still under the last heading of the lens before it.
  for (const slug of new Set(lenses.map((lens) => lens.slug))) {
    const ofWorksheet = lenses.filter((lens) => lens.slug === slug);
    const anchors = uniqueAnchors(ofWorksheet.flatMap((lens) => bodies.get(lens)!.headings));
    let under = "";
    for (const lens of ofWorksheet) {
      const body = bodies.get(lens)!;
      lens.headingAnchors = anchors.splice(0, body.headings.length);
      lens.cards = body.cards.map(({ heading, ...card }) => ({ ...card, anchor: heading < 0 ? under : lens.headingAnchors[heading] }));
      under = lens.headingAnchors[lens.headingAnchors.length - 1] ?? under;
    }
  }

  return { path: layout.course, content, published, head: course.head, blocks, commit: field(course.data, "upstream_commit"), rules: field(course.data, "sync_rules"), modules, lenses, transcripts, warnings };
}
