/**
 * Where the Iliad course's files live, what they are called, and the
 * wikilinks between them. Change the folder layout here and nowhere else: a
 * run moves every file whose path the layout no longer gives, and rewrites
 * the links.
 */

import { posix } from "node:path";
import type { Worksheet } from "./types";

export interface Layout {
  /** The course file. The sync never moves it. */
  course: string;
  /** Directory of the Iliad module files. */
  moduleDir: string;
  /** Directory of the lenses of one teaching day. */
  lensDir(day: Pick<Worksheet, "dayCode" | "dayTitle">): string;
}

/**
 * The layout for a course file ("Lens Edu/courses/.../x.md"): the Iliad
 * modules and lenses get folders of their own in the course file's Relay
 * folder, which held 1,896 lenses in one folder and 295 modules in another
 * when this was written. Lens reads a file as a lens when its path contains
 * "/Lenses/" and as a module when it starts with "modules/", so both stay
 * under those.
 */
export function layoutFor(course: string): Layout {
  const folder = course.slice(0, course.indexOf("/"));
  return {
    course,
    moduleDir: `${folder}/modules/Iliad`,
    lensDir: (day) => `${folder}/Lenses/Iliad/${safeName(`${day.dayCode} ${day.dayTitle}`)}`,
  };
}

export const LAYOUT: Layout = layoutFor("Lens Edu/courses/in-development/iliad-intensive-demo.md");

// ------------------------------------------------------------------ names
//
// A heading, a day title, a contributor's name: all of it is text from a
// public site the sync does not control, and the sync writes it into files
// whose markup Lens gives meaning to. These three functions are the one
// place that decides what such text may contain. Each includes the one
// before it.

/**
 * Text that can stand anywhere on one line of a file without changing how
 * Lens reads the rest of the file. Lens removes two kinds of markup from a
 * whole file before it parses it, across lines: `%% comments %%`, and the
 * CriticMarkup of pending suggestions (`{++ ++}`, `{-- --}`, `{~~ ~> ~~}`,
 * `{== ==}`, `{>> <<}`). One half of such a pair in a title could swallow
 * everything up to the other half further down. (lens-platform,
 * content_processor/src/authoring-markup.ts and criticmarkup-forms.ts.)
 */
export function inert(text: string): string {
  return text
    .replace(/%{2,}/g, "%")
    .replace(/\{(?=>>|\+\+|--|~~|==)/g, "{ ")
    .replace(/(?<=<<|\+\+|--|~~|==)\}/g, " }")
    .replace(/[\s\p{Cc}]+/gu, " ")
    .trim();
}

/**
 * Text for a title: of a lens, a submodule or a module. A title stands
 * after `# Lens:` in a module file and as `[[file|title]]` in a course
 * file, so it has no wikilink brackets or `|`, no `::` (a field), and no
 * leading `#`. Lens rejects `_` in a title.
 */
export function plainTitle(text: string): string {
  return inert(text)
    .replace(/[[\]|_]/g, " ")
    .replace(/:{2,}/g, ":")
    .replace(/\s+/g, " ")
    .replace(/^[#\s]+/, "")
    .trim();
}

/**
 * A file or folder name: a title with ": " as " - " (the hand import's
 * rule) and without the characters a Relay path, a Windows checkout or a
 * wikilink target cannot hold. Never empty, hidden or "..".
 */
export function safeName(text: string): string {
  const name = plainTitle(text)
    .replace(/\s*:\s*/g, " - ")
    .replace(/["\\/#^<>?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/, "")
    .replace(/^[. ]+/, "");
  return name || "untitled";
}

/** The hand import's file name for a lens title: "B.3.5 A: b" is "Iliad B.3.5 - A - b". */
export function lensFileName(title: string): string {
  return `Iliad ${safeName(title).replace(/^(\S+) /, "$1 - ")}`;
}

// ------------------------------------------------------------------ links

/** Full path of the file a wikilink target written in `from` points to. */
export function linkTarget(from: string, target: string): string {
  const path = posix.normalize(posix.join(posix.dirname(from), target.trim()));
  return /\.(md|html)$/i.test(path) ? path : `${path}.md`;
}

/**
 * The wikilink target that reaches `to` from `from`: relative, without the
 * extension, and never a bare name (Lens reads a source:: link only as a
 * path), so a file in the same folder is "../Lenses/x" as in the hand import.
 */
export function linkTo(from: string, to: string): string {
  const dir = posix.dirname(from);
  const relative = posix.relative(dir, to.replace(/\.md$/i, ""));
  return relative.includes("/") ? relative : `../${posix.basename(dir)}/${relative}`;
}

const WIKILINK = /(!?\[\[)([^\]|]+)(\|[^\]]*)?\]\]/g;

/**
 * Every wikilink of `text` put through `respell`, which gets the full path
 * the link points to and gives its new spelling, or null to leave it. A
 * link is a path from the folder of the file it is in, also when it is a
 * bare name: that is how Lens reads it, and the relay writes a bare name for
 * a file in the same folder when it respells the links of a file it moves.
 */
function withLinks(text: string, from: string, respell: (path: string) => string | null): string {
  return text.replace(WIKILINK, (whole: string, open: string, target: string, display: string = "") => {
    const link = respell(linkTarget(from, target));
    return link === null ? whole : `${open}${link}${display}]]`;
  });
}

/** The full paths the wikilinks in `text` point to, in order. */
export function linkTargets(text: string, from: string): string[] {
  const paths: string[] = [];
  withLinks(text, from, (path) => (paths.push(path), null));
  return paths;
}

/** The wikilink target of the `source::` field in a block of a module or a segment of a lens, as written; null without one. */
export function sourceLink(text: string): string | null {
  return text.match(/^source::\s*!?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/m)?.[1].trim() ?? null;
}

/**
 * `text` as it must read once its file has gone from `from` to `to` and the
 * files in `moved` (old path to new path) have gone too. A link is rewritten
 * only when one of its two ends moved, so an untouched file stays byte for
 * byte the same.
 */
export function relink(text: string, from: string, to: string, moved: ReadonlyMap<string, string>): string {
  return withLinks(text, from, (path) => {
    const now = moved.get(path) ?? path;
    return from === to && now === path ? null : linkTo(to, now);
  });
}

/**
 * `text` with every link written as the full path its target has after
 * `moved`. Two versions of a file that differ only in how they spell a link
 * give the same result: the relay respells the links to a file when the file
 * moves, and that is not an edit.
 */
export function withFullLinks(text: string, from: string, moved: ReadonlyMap<string, string>): string {
  return withLinks(text, from, (path) => moved.get(path) ?? path);
}
