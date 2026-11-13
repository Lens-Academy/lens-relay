/**
 * The course as the Atlas sync last wrote it, read from the files: the
 * course file lists the modules, each module lists its lenses, each lens
 * links to its article. Only files that carry the sync's marker
 * (`synced_from.source: atlas`) are the sync's own; the sync never moves,
 * writes or trashes another file, and puts no new file at its path.
 *
 * A lens of the sync's own that cannot be read stops the run: going on
 * would give its section a new id, and learner progress is keyed on the id.
 * Files are read as Lens publishes them, pending suggestions rejected.
 */

import { readSyncMarker } from "../../../shared/source-sync";
import { linkTarget, sourceLink } from "../iliad/layout";
import { blockFile, field, parseBlocks, splitFrontmatter, withoutSuggestions, type MarkdownFile } from "../iliad/module-file";
import type { CourseFiles } from "../iliad/types";
import type { AtlasCourseConfig, AtlasCourseHeader, AtlasCourseState, AtlasLens, AtlasModule } from "./types";

/** The `synced_from.source` of every file the Atlas sync writes. */
export const ATLAS_SOURCE = "atlas";

/** The folders the sync writes a course's files in. */
export function atlasFolders(config: AtlasCourseConfig): { modules: string; lenses: string; articles: string } {
  const top = config.course.slice(0, config.course.indexOf("/"));
  return { modules: `${top}/modules/${config.folder}`, lenses: `${top}/Lenses/${config.folder}`, articles: `${top}/articles/${config.folder}` };
}

/** A file's frontmatter and body as Lens publishes it; throws a message a person can act on when the frontmatter is broken. */
export function parsed(path: string, content: string): MarkdownFile {
  try {
    return splitFrontmatter(withoutSuggestions(content));
  } catch (err) {
    throw new Error(
      `"${path}" has frontmatter that is not valid YAML (${(err as Error).message.split("\n")[0]}). The sync stopped and changed nothing. To do: open the file and correct the lines between the two ---.`,
    );
  }
}

const isOwn = (data: Record<string, unknown>): boolean => readSyncMarker(data)?.source === ATLAS_SOURCE;

/** A frontmatter mapping of text to text ("upstream_revisions", "missing_since"). */
function textMap(value: unknown): Map<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return new Map();
  return new Map(Object.entries(value).flatMap(([key, text]) => (typeof text === "string" ? [[key, text] as [string, string]] : [])));
}

/** What a course file's frontmatter records of the last run that finished. */
export function courseHeader(data: Record<string, unknown>): AtlasCourseHeader {
  const rules = Number(data.sync_rules);
  return {
    revisions: textMap(data.upstream_revisions),
    missingSince: textMap(data.missing_since),
    syncRules: data.sync_rules !== undefined && Number.isInteger(rules) ? rules : null,
    syncConfig: field(data, "sync_config"),
  };
}

const stopped = "The sync stopped and changed nothing";

/** The lens a file of the sync's own describes; null when it has no id. */
function lensOf(path: string, file: MarkdownFile, articlePath: string): AtlasLens | null {
  const id = field(file.data, "id");
  if (!id) return null;
  return {
    id,
    heading: field(file.data, "upstream_heading"),
    key: field(file.data, "upstream_key") ?? "",
    fingerprint: field(file.data, "upstream_fingerprint") ?? "",
    title: field(file.data, "title") ?? "",
    url: readSyncMarker(file.data)?.url ?? null,
    lensPath: path,
    articlePath,
  };
}

/** Reads each file once into `state.contents`, and records in `state.occupied` each that is not the sync's own. */
function reader(files: CourseFiles, state: AtlasCourseState) {
  return async (path: string): Promise<MarkdownFile | null> => {
    if (!state.contents.has(path)) state.contents.set(path, await files.read(path));
    const content = state.contents.get(path)!;
    if (content === null) return null;
    const file = parsed(path, content);
    if (!isOwn(file.data)) state.occupied.add(path);
    return file;
  };
}

/** The article a lens of the sync's own shows, when that article is the sync's own or not there; "" otherwise. */
async function articleOf(read: ReturnType<typeof reader>, state: AtlasCourseState, lensPath: string, file: MarkdownFile): Promise<string> {
  const link = sourceLink(file.body);
  const path = link ? linkTarget(lensPath, link) : "";
  const article = path ? await read(path) : null;
  if (!article || isOwn(article.data)) return path;
  state.warnings.push(`The lens "${lensPath}" shows "${path}", which the Atlas sync did not write; the sync leaves that file alone and gives the lens an article of its own.`);
  return "";
}

export async function readAtlasState(files: CourseFiles, config: AtlasCourseConfig): Promise<AtlasCourseState> {
  const state: AtlasCourseState = { revisions: new Map(), missingSince: new Map(), syncRules: null, syncConfig: null, modules: [], pins: [], contents: new Map(), occupied: new Set(), warnings: [] };
  const read = reader(files, state);
  const folders = atlasFolders(config);
  const inside = (path: string, dir: string) => path.startsWith(`${dir}/`);

  const course = await read(config.course);
  if (!course) return state;
  if (!isOwn(course.data)) {
    throw new Error(
      `The course file "${config.course}" exists and was not written by the Atlas sync (it has no "synced_from" with "source: atlas"). ${stopped}, so as not to overwrite it. To do: give the course in ATLAS_SYNC_COURSES a path of its own.`,
    );
  }
  Object.assign(state, courseHeader(course.data));

  const readLens = async (path: string, module: string): Promise<AtlasLens | null> => {
    const stop = (problem: string, toDo: string) =>
      new Error(`The lens "${path}", which the module "${module}" lists, ${problem}. ${stopped}: it would give the section a new lens with a new id, and learners would lose their progress on it. To do: ${toDo}`);
    const file = await read(path);
    if (!file && inside(path, folders.lenses)) throw stop("does not exist", `restore it from the folder's trash (_trash/), or delete its entry in the module to let the sync make the section a new lens.`);
    if (!file || !isOwn(file.data)) {
      state.warnings.push(`The module "${module}" lists "${path}", which the Atlas sync did not write. The module is the sync's, so the entry goes when the sync next writes the module.`);
      return null;
    }
    const lens = lensOf(path, file, await articleOf(read, state, path, file));
    if (!lens) throw stop("has no id in its frontmatter", "put the lens's frontmatter back (the file's history in the Lens Editor has it).");
    return lens;
  };

  for (const block of parseBlocks(course.body)) {
    const path = blockFile(block, config.course);
    if (!path || state.modules.some((module) => module.path === path)) continue;
    const file = await read(path);
    if (!file) {
      if (!inside(path, folders.modules)) continue;
      throw new Error(`The course file lists the module "${path}", which does not exist. ${stopped}: its lenses would get new ids. To do: restore the module from the folder's trash (_trash/), or delete its "# Module:" line from the course file.`);
    }
    if (!isOwn(file.data)) {
      state.warnings.push(`The course file lists the module "${path}", which the Atlas sync did not write. The course file is the sync's, so the line goes when the sync next writes it.`);
      continue;
    }
    const slug = field(file.data, "slug");
    const module: AtlasModule = {
      path,
      line: block.raw.split("\n")[0],
      id: field(file.data, "id"),
      chapterSlug: slug?.startsWith(config.moduleSlugPrefix) ? slug.slice(config.moduleSlugPrefix.length) : null,
      url: readSyncMarker(file.data)?.url ?? null,
      lenses: [],
    };
    for (const lensBlock of parseBlocks(file.body)) {
      const lensPath = lensBlock.type === "lens" ? blockFile(lensBlock, path) : null;
      if (!lensPath || state.pins.some((pin) => pin.lensPath === lensPath)) continue;
      const lens = await readLens(lensPath, path);
      if (!lens) continue;
      module.lenses.push(lens);
      state.pins.push(lens);
    }
    state.modules.push(module);
  }
  for (const [i, pin] of state.pins.entries()) {
    const twin = state.pins.slice(0, i).find((other) => other.id === pin.id);
    if (twin) {
      throw new Error(
        `"${twin.lensPath}" and "${pin.lensPath}" have the same id ${pin.id}. ${stopped}: Lens shows only one of two lenses with one id, and the sync cannot tell which one learners have read. To do: if one is a copy made by hand, delete it and its entry in the module.`,
      );
    }
  }
  return state;
}

/**
 * Read the files a run would create where the course lists none. A lens of
 * the sync's own for the same section (left by a run that stopped before it
 * wrote its module) is taken back with its id. Any other file there is
 * `occupied`, and the run puts its own file elsewhere.
 */
export async function readUnlisted(files: CourseFiles, state: AtlasCourseState, lenses: { path: string; key: string; heading: string | null }[], others: string[]): Promise<void> {
  const read = reader(files, state);
  for (const { path, key, heading } of lenses) {
    if (state.contents.has(path)) continue;
    const file = await read(path);
    if (!file || state.occupied.has(path)) continue;
    const lens = lensOf(path, file, await articleOf(read, state, path, file));
    const same = lens && (heading && lens.heading ? lens.heading === heading : lens.key === key);
    if (!lens || !same || state.pins.some((pin) => pin.id === lens.id)) {
      state.occupied.add(path);
      continue;
    }
    state.pins.push(lens);
    state.warnings.push(`The lens "${path}" was not listed by its module; the sync took it back with its id.`);
  }
  for (const path of others) await read(path);
}

/** The id in a file's frontmatter, or null when the file does not exist or has none. */
export function idOf(state: AtlasCourseState, path: string): string | null {
  const content = state.contents.get(path);
  return content ? field(parsed(path, content).data, "id") : null;
}
