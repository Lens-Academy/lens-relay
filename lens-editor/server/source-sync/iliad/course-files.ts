/**
 * Step 4 of the Iliad sync: from the course as it is (course-state.ts) and
 * the lenses planned for it, work out what to move, write and trash, and do
 * it in an order that never leaves the course broken.
 *
 * The order, and why:
 *   1. Lenses. A file whose folder changed is moved (never written a second
 *      time: two files with one id drop content), then written if its text
 *      changed. A new lens is written; until a module lists it, it is not
 *      part of the course.
 *   2. Modules: moved, then written with the new lenses in, the retired
 *      ones out, and the readings the source offers as a choice in choice
 *      groups.
 *   3. Retired lenses go to the trash, now that no module lists them.
 *   4. The course file, with the source commit of this run. It is last, so
 *      a run that stops early leaves the old commit, and the next run does
 *      everything again. Each step leaves the same result when repeated.
 *
 * Between a move and the write of the file that links to it, the link
 * points at the old path. In production the relay closes that gap: its move
 * rewrites the links of the moved file and of every file linking to it.
 *
 * A run that changes nothing writes nothing. A lens keeps the commit of the
 * run that last changed it, so a source commit that touches one worksheet
 * rewrites that worksheet's lenses and the course file's commit, not 200
 * files.
 *
 * Two things stop a run before it changes a file. A source that lost more
 * than a few lenses is more likely broken for one deploy than edited, and a
 * retired lens does not come back with its id: such a run needs a person's
 * approval. And a file that a person saved after the run read it is not
 * overwritten: the next run plans again from what the person saved.
 */

import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { arxivAbsUrl } from "../../add-article/adapters/arxiv";
import { dedupUrlVariants } from "../../add-article/url-normalize";
import { extractVideoInput } from "../../add-video/video-url";
import { yamlQuote } from "../../yaml";
import { choicesIn, countOf } from "./choices";
import type { CourseState, LensState, ModuleBlock, ModuleState, Reading } from "./course-state";
import { LAYOUT, lensFileName, linkTargets, linkTo, plainTitle, relink, safeName, withFullLinks, type Layout } from "./layout";
import { cardChoice, cardNames, composeLens, type Card } from "./lens-file";
import { atLevel, headingLevel, lensEntry, moduleLine, setFrontmatter, spaced, submoduleHeading } from "./module-file";
import { lensKey, type CourseFiles, type PlannedLens, type SyncReport, type Worksheet } from "./types";

export interface LensInput {
  planned: PlannedLens;
  /** The planner's fingerprint of the lens as planned now. The file stores it for the next run's Pin. */
  fingerprint: string;
  /** New summaries. Without them a lens keeps the ones it has. */
  tldr?: string | null;
  summaryForTutor?: string | null;
}

export interface SyncInput {
  /** The source commit this run brings the course to. */
  commit: string;
  /** Every listed worksheet in taught order, each with its lenses in reading order. */
  worksheets: { worksheet: Worksheet; lenses: LensInput[] }[];
}

/**
 * How many things one run removes without a person's approval: retired
 * lenses, reading entries taken out of modules and cards dropped, together.
 * The first run on the hand import retires one lens.
 */
export const MAX_RETIRED = 3;
/** The setting that approves a larger removal: its value is the source commit the approval is for. */
export const APPROVE_RETIREMENT_ENV = "ILIAD_SYNC_APPROVE_RETIREMENT";

/**
 * The version of the rules by which the sync lays out the course, recorded
 * in the course file (`sync_rules`) beside the source commit. Increase it
 * with a change that must reach the course before Iliad next publishes: a
 * run plans again when either differs.
 */
export const SYNC_RULES = "2";

export interface PlanOptions {
  layout?: Layout;
  /** Ids for new lenses and modules (tests pass a counter). */
  newId?: () => string;
  /** The source commit for which a person approved a removal the sync would not make alone. It approves that commit and no other. */
  approvedRetirement?: string;
  /** Why the planner retires a lens, by the lens's id ("its section is gone from the worksheet"). */
  retireReasons?: ReadonlyMap<string, string>;
}

/**
 * One thing to do to one file. `expects` is on the first step that touches
 * a file that was there when the course was read: the content the plan was
 * made from, which the file must still have.
 */
export type Step = ({ do: "move"; from: string; to: string } | { do: "write"; path: string; content: string } | { do: "trash"; path: string }) & {
  expects?: string;
};

export interface FilePlan {
  commit: string;
  /** True when there is something to do. */
  changed: boolean;
  /** What to do, in the order to do it. */
  steps: Step[];
  /**
   * Everything the plan takes away, a line each for a log ("Lens retired:
   * ...", "Reading taken out of the module ...", "Card dropped: ..."), with
   * why. None of these comes back by itself. Empty when it removes nothing.
   */
  removes: string[];
  warnings: string[];
}

/** A lens as it is after the run. */
interface LensAfter {
  worksheet: Worksheet;
  input: LensInput;
  /** The file it continues; undefined for a new lens. */
  old?: LensState;
  id: string;
  title: string;
  path: string;
  cards: Card[];
}

/** One block of a module or course file being edited. */
interface Entry {
  kind: "lens" | "submodule" | "module" | "other";
  /** Its text once the file is at `path`. */
  text(path: string): string;
  /** The block of the module file it was read from; undefined for an entry this run adds. */
  block?: ModuleBlock;
  /** The lens a module's `# Lens:` entry lists, when the sync owns it. */
  lens?: LensAfter;
  /** The module a course's `# Module:` entry lists. */
  module?: Draft;
  /** What a new entry after this one needs before it: a line break, or an empty line. */
  gap?: "line" | "blank";
  /** A submodule heading that lost an entry in this run: dropped if it ends up empty. */
  lostEntry?: boolean;
}

/** A module file being edited, or made. */
interface Draft {
  from?: ModuleState;
  path: string;
  title: string;
  /** Everything before the first heading. */
  head: string;
  entries: Entry[];
}

const kebab = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * A LessWrong or Alignment Forum post or wiki page by its id or slug,
 * whichever of the two sites (or their GreaterWrong mirror) is linked: the
 * two are one forum with one database, and a post has one id on both. The
 * paths are the ones the article importer reads (forumGraphqlUrl).
 */
function forumPage(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)(lesswrong\.com|alignmentforum\.org|greaterwrong\.com)$/.test(u.hostname.toLowerCase())) return null;
    const post = u.pathname.match(/^\/(?:posts|s\/[\w-]+\/p)\/([A-Za-z0-9]{8,32})(?:\/[\w-]*)?\/?$/)?.[1];
    const wiki = u.pathname.match(/^\/(?:w|tag)\/([\w-]+)\/?$/)?.[1];
    return post ? `lesswrong-post:${post}` : wiki ? `lesswrong-wiki:${wiki.toLowerCase()}` : null;
  } catch {
    return null;
  }
}

/**
 * Every spelling under which the sync knows the article or video at `url`:
 * the address itself, the article importer's key for it (no tracking
 * parameters, fragment, "www." or mirror host), an arXiv paper's abstract
 * page whichever of its pages is linked, a LessWrong or Alignment Forum
 * post by its id on either site, a YouTube video by its id. Two addresses
 * that share a spelling are the same work.
 */
export function sameWork(url: string): string[] {
  return [...dedupUrlVariants(url, arxivAbsUrl(url), extractVideoInput(url)?.url), forumPage(url) ?? ""].filter(Boolean);
}
const urlsIn = (markdown: string): string[] => (markdown.match(/https?:\/\/[^\s<>"'`\])]+/g) ?? []).map((url) => url.replace(/[.,;:!?]+$/, ""));
const youtubeUrl = (id: string): string => `https://www.youtube.com/watch?v=${id}`;

/** The n of a lens title "<code>.<n> ..."; 0 for a title of another form. */
function numberOf(title: string, code: string): number {
  return title.startsWith(`${code}.`) ? Number(title.slice(code.length + 1).match(/^(\d+)(?=\s|$)/)?.[1] ?? 0) : 0;
}

/** A section number a heading opens with: "2.", "2.1", "A.", "IV.", "(b)". */
const SECTION_NUMBER = /^(?:\d+(?:\.\d+)+\.?|\d+\.|[A-Za-z]\.|[IVX]+\.|\(\s*[A-Za-z0-9]{1,4}\s*\))\s+(?=\S)/;

/**
 * "<code>.<n> <first heading>", as plain words (layout.ts): the heading is
 * the source site's text, without a section number of its own ("B.7.2
 * Chinchilla", not "B.7.2 2. Chinchilla"). A lens cut at an exercise starts
 * under no heading of its own, so it is named after the exercise ("From
 * Exercise 3.3"): a heading further down would name only what the lens
 * ends with.
 */
function newTitle(code: string, n: number, lens: PlannedLens): string {
  const first = lens.atoms[0];
  const heading = plainTitle(first?.title ?? "").replace(SECTION_NUMBER, "");
  if (heading || first?.level !== 5) return plainTitle(`${code}.${n} ${heading || "Overview"}`);
  const opening = first.parts.find((part) => part.kind === "text");
  const exercise = opening?.kind === "text" ? opening.markdown.match(/\*\*(Exercise [\d.]*\d)/)?.[1] : undefined;
  return plainTitle(`${code}.${n} ${exercise ? `From ${exercise}` : "Exercises"}`);
}

/** The day each reading of a module belongs to: that of the Iliad lens before it in its submodule, else of the one after it. */
function readingDays(module: ModuleState, day: (lens: LensState) => string): Map<ModuleBlock, string> {
  const days = new Map<ModuleBlock, string>();
  const fill = (blocks: ModuleBlock[]) => {
    let current: string | undefined;
    for (const block of blocks) {
      if (block.type === "submodule") current = undefined;
      else if (block.lens) current = day(block.lens);
      else if (block.reading && current && !days.has(block)) days.set(block, current);
    }
  };
  fill(module.blocks);
  fill([...module.blocks].reverse());
  return days;
}

/** A file's text from its entries, each closed as the entry after it needs. */
function render(head: string, entries: Entry[], path: string): string {
  const closed = (entry: Entry, text: string) => (entry.gap === "blank" ? spaced(text) : entry.gap === "line" && !text.endsWith("\n") ? `${text}\n` : text);
  return head + entries.map((entry) => closed(entry, entry.text(path))).join("");
}

function insert(entries: Entry[], at: number, gap: "line" | "blank", ...added: Entry[]): void {
  if (at > 0) entries[at - 1].gap = gap;
  entries.splice(at, 0, ...added);
}

/**
 * The lenses to exist after the run, in taught order. One that a plan
 * continues keeps its id, title and file name. A new one gets an id, and the
 * number one past the highest its worksheet has used: the number is a label,
 * the module file holds the order.
 */
function lensesAfter(state: CourseState, input: SyncInput, layout: Layout, newId: () => string): LensAfter[] {
  const byId = new Map(state.lenses.map((old) => [old.id, old]));
  const continued = new Set<LensState>();
  const after: LensAfter[] = [];
  for (const { worksheet, lenses } of input.worksheets) {
    for (const lens of lenses) {
      const pin = lens.planned.pinned;
      const old = pin ? byId.get(pin.id) : undefined;
      if (pin && !old) throw new Error(`The plan continues the lens ${pin.id} (${pin.key}), which no module of the course lists. This is a fault in the sync, not in the content.`);
      if (old && continued.has(old)) throw new Error(`The plan continues the lens "${old.title}" (${old.id}) twice. This is a fault in the sync, not in the content.`);
      if (old) continued.add(old);
      after.push({ worksheet, input: lens, old, id: old?.id ?? "", title: old?.title ?? "", path: old ? `${layout.lensDir(worksheet)}/${posix.basename(old.path)}` : "", cards: [] });
    }
  }
  // A new lens never takes the path of a file that is there, also not of one this run retires.
  const taken = new Set([...state.lenses.map((old) => old.path), ...after.map((lens) => lens.path)]);
  for (const { worksheet } of input.worksheets) {
    let highest = Math.max(0, ...state.lenses.filter((old) => old.slug === worksheet.slug).map((old) => numberOf(old.title, worksheet.code)));
    for (const lens of after) {
      if (lens.worksheet !== worksheet || lens.old) continue;
      do {
        lens.title = newTitle(worksheet.code, ++highest, lens.input.planned);
        lens.path = `${layout.lensDir(worksheet)}/${lensFileName(lens.title)}.md`;
      } while (taken.has(lens.path));
      taken.add(lens.path);
      lens.id = newId();
    }
  }
  return after;
}

/**
 * Stop when a module lists a lens file that does not exist in a folder where
 * the sync keeps a day's lenses. Nothing else says whose a missing file was,
 * and readings are never kept there. Carrying on would give the section a
 * new lens and a new id, and learners would lose their progress on it.
 */
function checkMissingLenses(state: CourseState, input: SyncInput, layout: Layout): void {
  const ownFolders = new Set(input.worksheets.map(({ worksheet }) => layout.lensDir(worksheet)));
  for (const module of state.modules) {
    for (const block of module.blocks) {
      if (!block.reading?.missing || !ownFolders.has(posix.dirname(block.reading.path))) continue;
      throw new Error(
        `The lens file "${block.reading.path}" does not exist, and it stands in a folder where the sync keeps its lenses. The module "${module.path}" lists it as "${block.title}". ` +
          `The sync stopped and changed nothing: without this file it would make a new lens for the section, with a new id, and learners would lose their progress on it. ` +
          `To do: restore the file from the folder's trash (_trash/), where a deleted file goes; if it was moved or renamed, correct the link in the module to where it is now. Deleting the entry from the module does not help: the next run would make a new lens for the section.`,
      );
    }
  }
}

/**
 * Stop a run that would remove more than a few things, or every lens of a
 * worksheet the schedule still lists, unless a person approved it for this
 * source commit. A deploy that loses text for an hour would otherwise cost
 * lens ids, readings and cards for good: when the text comes back, the
 * lenses come back as new ones (learners' progress is on the old ids), and
 * readings and cards do not come back at all. A page that goes empty is far
 * more often broken than edited, so that needs approval at any size.
 */
function checkRemovals(removes: string[], emptied: Worksheet[], commit: string, approved: string | undefined): void {
  if ((removes.length <= MAX_RETIRED && emptied.length === 0) || approved === commit) return;
  // Each line stands alone: the log puts a prefix on every line, and a reader may see one line only.
  const run = `The run for source commit ${commit}`;
  throw new Error(
    [
      `${run} stopped and changed nothing: it needs a person's approval.`,
      ...(removes.length > MAX_RETIRED ? [`${run} would remove ${removes.length} things; a run removes at most ${MAX_RETIRED} without approval.`] : []),
      ...emptied.map(
        (worksheet) =>
          `${run} would retire every lens of the worksheet ${worksheet.code} ${worksheet.title} (${worksheet.pageUrl}), which the schedule still lists; a page that goes empty is far more often broken than edited.`,
      ),
      ...removes.map((line) => `At source commit ${commit}: ${line}`),
      `If source commit ${commit} lost this text by mistake, do nothing: when a later commit has the text again, the sync carries on by itself and nothing is lost.`,
      `If Iliad removed this text for good, approve source commit ${commit}: set ${APPROVE_RETIREMENT_ENV}=${commit} and restart the lens-editor container. Learners lose their progress on the lenses it retires.`,
    ].join("\n"),
  );
}

/** A card list of the hand import (`:::require_x_optional_lenses{x=k}`): k of its readings. */
interface ListChoice {
  pick: number;
  /** The files of its cards, full paths. */
  readings: string[];
  /** The lens it was in. */
  lens: LensState;
  block: string;
  /** The lens that holds it after the run, and the card there; none when its lens is retired with its heading. */
  holder?: { lens: LensAfter; card: Card };
}

/**
 * Give each card of the course to the lens that holds it after the run: the
 * one with the card's heading, else the one that continues the lens the card
 * was in. Returns the readings that a card points to, and the card lists of
 * the hand import, which arrangeChoices may turn into choice groups
 * (settleLists then takes them out of their lenses).
 */
function placeCards(state: CourseState, after: LensAfter[], moved: ReadonlyMap<string, string>, removes: string[]): { carded: Set<string>; lists: ListChoice[] } {
  const holder = new Map<string, LensAfter>();
  for (const lens of after) for (const atom of lens.input.planned.atoms) holder.set(lensKey(lens.worksheet.slug, atom.anchor), lens);
  const continues = new Map(after.flatMap((lens) => (lens.old ? [[lens.old, lens] as const] : [])));
  const carded = new Set<string>();
  const lists: ListChoice[] = [];
  for (const old of state.lenses) {
    for (const card of old.cards) {
      const lens = holder.get(lensKey(old.slug, card.anchor)) ?? continues.get(old);
      const list = cardChoice(card.block, old.path);
      if (!lens && !list) {
        removes.push(...cardsDropped(card.block, old));
        continue;
      }
      for (const reading of linkTargets(card.block, old.path)) carded.add(reading);
      if (!lens) {
        lists.push({ ...list!, lens: old, block: card.block });
        continue;
      }
      const placed = { ...card, block: relink(card.block, old.path, lens.path, moved) };
      lens.cards.push(placed);
      if (list) lists.push({ ...list, lens: old, block: card.block, holder: { lens, card: placed } });
    }
  }
  return { carded, lists };
}

const cardsDropped = (block: string, lens: LensState): string[] =>
  block
    .split("\n")
    .filter((line) => line.startsWith("::card"))
    .map((line) => `Card dropped: ${cardNames(line)} in the lens "${lens.title}" (${lens.path}). Why: the lens is retired, and the heading the card stood under is gone from the source.`);

/**
 * A card list leaves its lens when a choice group in a module holds every
 * reading it names: the group asks what the list asked. Any other list stays
 * where placeCards put it, or, when its lens is retired, is dropped like any
 * card.
 */
function settleLists(lists: ListChoice[], grouped: ReadonlySet<string>, removes: string[]): void {
  for (const list of lists) {
    if (list.readings.every((path) => grouped.has(path))) {
      if (list.holder) list.holder.lens.cards.splice(list.holder.lens.cards.indexOf(list.holder.card), 1);
    } else if (!list.holder) removes.push(...cardsDropped(list.block, list.lens));
  }
}

/**
 * Take a reading out of its module when its day's source stops linking to
 * it. "Stops" needs proof that it did before: an address of the work was in
 * the day's lenses as last written, and none is in the day's new text. So a
 * reading the source never linked (a paper cited by its arXiv number, a
 * reading a person added) is never removed, and neither is one whose address
 * is unknown or one that a card still points to. Addresses are compared as
 * the importers compare them (`sameWork`), so a link that changes its form
 * and not its target removes nothing.
 */
function removeUnlinkedReadings(drafts: Draft[], state: CourseState, after: LensAfter[], dayOf: ReadonlyMap<string, string>, carded: ReadonlySet<string>, removes: string[]): void {
  // The day of a lens is that of the worksheet it continues in (a worksheet may get a new name), else of the one it was in.
  const continuedIn = new Map(after.flatMap((lens) => (lens.old ? [[lens.old, lens.worksheet.dayCode] as const] : [])));
  const day = (old: LensState): string => continuedIn.get(old) ?? dayOf.get(old.slug) ?? `(${old.slug})`;
  const linkedBefore = new Map<string, Set<string>>();
  const linkedNow = new Map<string, Set<string>>();
  const note = (links: Map<string, Set<string>>, dayCode: string, urls: string[]) => {
    const known = links.get(dayCode) ?? links.set(dayCode, new Set()).get(dayCode)!;
    for (const url of urls) for (const spelling of sameWork(url)) known.add(spelling);
  };
  for (const old of state.lenses) note(linkedBefore, day(old), [...urlsIn(old.text), ...old.videos.map(youtubeUrl)]);
  for (const lens of after) {
    for (const atom of lens.input.planned.atoms) {
      const inParts = atom.parts.flatMap((part) => (part.kind === "text" ? urlsIn(part.markdown) : [youtubeUrl(part.youtubeId)]));
      note(linkedNow, lens.worksheet.dayCode, [...atom.links.map((link) => link.url), ...inParts]);
    }
  }
  for (const draft of drafts) {
    const days = readingDays(draft.from!, day);
    draft.entries = draft.entries.filter(({ block }) => {
      const dayCode = block && days.get(block);
      const reading = block?.reading;
      if (!dayCode || !reading?.url || carded.has(reading.path)) return true;
      const spellings = sameWork(reading.url);
      if (!spellings.some((s) => linkedBefore.get(dayCode)?.has(s)) || spellings.some((s) => linkedNow.get(dayCode)?.has(s))) return true;
      removes.push(`Reading taken out of the module "${draft.title}": "${block.title}" (${reading.url}). Why: the source of ${dayCode} no longer links to it. The reading's own files stay.`);
      return false;
    });
  }
}

/**
 * Put an entry into a module for every lens that has none: a new lens, and
 * one whose section went to another day. Each goes beside the nearest lens,
 * in taught order, that has a place: one of its worksheet, else one of its
 * day. With neither, its day is new to the course and gets a submodule
 * heading or a module of its own, placed by the nearest lens of its cluster.
 */
function placeNewEntries(after: LensAfter[], drafts: Draft[], courseEntries: Entry[], coursePath: string, layout: Layout, newId: () => string, warnings: string[]): void {
  const place = new Map<LensAfter, Draft>();
  for (const draft of drafts) for (const entry of draft.entries) if (entry.lens) place.set(entry.lens, draft);

  const entryOf = (lens: LensAfter): Entry => ({ kind: "lens", lens, text: (to) => lensEntry(lens.title, linkTo(to, lens.path)) });
  const dayTitle = (worksheet: Worksheet) => plainTitle(`${worksheet.dayCode} ${worksheet.dayTitle}`);
  const dayHeading = (worksheet: Worksheet): Entry => ({ kind: "submodule", text: () => submoduleHeading(dayTitle(worksheet)) });
  /** The nearest lens with a place whose worksheet is `alike`, and the side of it the new entry goes. */
  const nearest = (i: number, alike: (other: Worksheet) => boolean): { lens: LensAfter; side: "after" | "before" } | null => {
    for (let j = i - 1; j >= 0; j--) if (place.has(after[j]) && alike(after[j].worksheet)) return { lens: after[j], side: "after" };
    for (let j = i + 1; j < after.length; j++) if (place.has(after[j]) && alike(after[j].worksheet)) return { lens: after[j], side: "before" };
    return null;
  };
  /** The index after `from` where the next thing starts: the next lens the sync owns, or with `submodule` the next heading. */
  const endOf = (entries: Entry[], from: number, submodule: boolean): number => {
    let at = from + 1;
    while (at < entries.length && entries[at].kind !== "submodule" && (submodule || !entries[at].lens)) at++;
    return at;
  };
  /**
   * Does this cluster have a module per day (the hand import's cluster A),
   * and not one module with a submodule per day (its B to E)? Read off the
   * modules: each holds one day. A cluster of one module with one day could
   * be either, and there the module's title decides: a day module is named
   * for its day ("A.2 Alignment in Practice").
   */
  const hasDayModules = (clusterId: string): boolean => {
    const daysIn = (draft: Draft) => new Set(draft.entries.flatMap((entry) => (entry.lens?.worksheet.cluster.id === clusterId ? entry.lens.worksheet.dayCode : [])));
    const holding = drafts.map(daysIn).map((days, i) => ({ days, title: drafts[i].title })).filter(({ days }) => days.size > 0);
    if (holding.some(({ days }) => days.size > 1)) return false;
    return holding.length > 1 || holding[0].title.startsWith(`${[...holding[0].days][0]} `);
  };

  after.forEach((lens, i) => {
    if (place.has(lens)) return;
    const { worksheet } = lens;
    const beside = nearest(i, (other) => other.slug === worksheet.slug) ?? nearest(i, (other) => other.dayCode === worksheet.dayCode);
    const inCluster = beside ?? nearest(i, (other) => other.cluster.id === worksheet.cluster.id);
    let draft = inCluster ? place.get(inCluster.lens)! : undefined;
    const at = draft ? draft.entries.findIndex((entry) => entry.lens === inCluster!.lens) : -1;

    if (draft && beside) {
      // After the lens and the readings that follow it, or before it.
      insert(draft.entries, beside.side === "after" ? endOf(draft.entries, at, false) : at, "blank", entryOf(lens));
    } else if (draft && !hasDayModules(worksheet.cluster.id)) {
      // A submodule after the one of the day before it, or before the one of the day after it.
      let start = at;
      while (start > 0 && draft.entries[start].kind !== "submodule") start--;
      insert(draft.entries, inCluster!.side === "after" ? endOf(draft.entries, at, true) : start, "blank", dayHeading(worksheet), entryOf(lens));
    } else {
      // A module of its own: for the day, or for a cluster new to the course.
      const forDay = draft !== undefined;
      const title = forDay ? dayTitle(worksheet) : plainTitle(worksheet.cluster.label);
      const name = forDay ? `${worksheet.dayCode} - ${worksheet.dayTitle}` : `${worksheet.cluster.id} - ${worksheet.cluster.label.replace(/^\S+\s+\W+\s*/, "")}`;
      const created: Draft = {
        path: `${layout.moduleDir}/${safeName(`Iliad ${name}`)}.md`,
        title,
        head: `---\nid: '${newId()}'\nslug: ${kebab(`iliad ${forDay ? title : worksheet.cluster.urlSlug}`)}\ntitle: ${yamlQuote(title)}\n---\n\n`,
        entries: [...(forDay ? [] : [dayHeading(worksheet)]), entryOf(lens)],
      };
      drafts.push(created);
      // In the course file a day's module follows its neighbour's line; a cluster's follows the neighbour's meeting too.
      const neighbour = inCluster ?? nearest(i, () => true);
      let position = neighbour ? courseEntries.findIndex((entry) => entry.module === place.get(neighbour.lens)) : -1;
      if (position === -1) position = courseEntries.length;
      else if (neighbour!.side === "after") {
        position++;
        while (!forDay && position < courseEntries.length && courseEntries[position].kind !== "module") position++;
      }
      const line = (to: string) => moduleLine(title, linkTo(to, created.path)) + (forDay ? "" : "\n");
      insert(courseEntries, position, forDay ? "line" : "blank", { kind: "module", module: created, text: line });
      warnings.push(
        `The source has a new ${forDay ? "day" : "cluster"}, "${title}". The sync made the module "${created.path}" for it and added its "# Module:" line to the course file "${coursePath}". ` +
          `To do: open the course file, move that line if it stands in the wrong place, and add a "# Meeting:" line after it if the module needs a meeting of its own.`,
      );
      draft = created;
    }
    place.set(lens, draft);
  });
}

/** The warning for a module or course file that the run rewrote over pending suggestions. */
const suggestionsGone = (file: string): string =>
  `Pending suggestions in ${file} are gone. The sync changed the file, and a write replaces all of it: it wrote the file as Lens showed it, with the sync's changes. ` +
  `To do: if a suggestion is still wanted, make it again; the file's history in the Lens Editor has it.`;

/** A choice group of a module: its `Choose:` heading (none for a group this run makes) and its lens entries. */
interface Group {
  kind: "group";
  header?: Entry;
  pick: number;
  members: Entry[];
}

/** A group offers a choice when it has two readings or more, and more than it asks for. */
const isChoice = (group: Group): boolean => group.members.length >= 2 && group.members.length > group.pick;

/** The fields a lens in a group may not have: the group says how many of its lenses the learner completes. */
const REFUSED_IN_GROUP = /^(?:optional|hide)::.*(?:\n|$)/gm;

/**
 * Choice groups in an Iliad module (choices.ts says what they are).
 *
 * Which readings: those after an Iliad lens go into a group when the hand
 * import's card list in that lens asked for k of them, or when the lens's
 * text offers them as a choice. The text is read for this only when it is
 * new or changed, or when the sync's rules are (`reread`): a person who
 * takes readings out of a group keeps them out until Iliad changes that
 * text. A group the module has, a person's or an earlier run's, stays, less
 * the readings the run took out; a group with no choice left (isChoice)
 * goes, and its readings stay as plain entries.
 *
 * At which level: the platform reads an entry one level below the lens
 * entries as part of the entry above it, and does not show it. So the
 * readings after an Iliad lens are written at that lens's level, and so is
 * a group's `Choose:` heading, with the group's readings one level down.
 *
 * The readings in a group at the end go into `grouped`.
 */
function arrangeChoices(draft: Draft, lists: ListChoice[], reread: boolean, grouped: Set<string>, warnings: string[]): void {
  const level = (entry: Entry): number => (entry.block ? headingLevel(entry.block.raw) : 1);
  const items: (Entry | Group)[] = [];
  for (let i = 0; i < draft.entries.length; i++) {
    const header = draft.entries[i];
    if (header.block?.type !== "choose") {
      items.push(header);
      continue;
    }
    const members: Entry[] = [];
    while (draft.entries[i + 1]?.kind === "lens" && level(draft.entries[i + 1]) > level(header)) members.push(draft.entries[++i]);
    const pick = countOf(header.block.title.split(/\s/)[0]);
    items.push({ kind: "group", header, pick: Number.isInteger(pick) && pick > 0 ? pick : 1, members });
  }

  // New groups, from the readings in no group after each Iliad lens.
  for (let i = 0; i < items.length; i++) {
    const owner = items[i];
    if (owner.kind !== "lens" || !owner.lens) continue;
    const lens = owner.lens;
    const free: Entry[] = [];
    for (const item of items.slice(i + 1)) {
      if (item.kind === "group") continue;
      if (item.kind !== "lens" || item.lens) break;
      if (item.block?.reading) free.push(item);
    }
    const changed = reread || !lens.old || lens.old.fingerprint !== lens.input.fingerprint;
    const markdown = lens.input.planned.atoms.flatMap((atom) => atom.parts.flatMap((part) => (part.kind === "text" ? [part.markdown] : []))).join("\n\n");
    // A card list becomes a group only whole: else it stays in the lens, and asks there what it asked.
    const proposals = [
      ...lists.filter((list) => list.holder?.lens === lens).map(({ pick, readings }) => ({ pick, takes: (reading: Reading) => readings.includes(reading.path), all: new Set(readings).size })),
      ...(changed ? choicesIn(markdown) : []).map(({ pick, options }) => {
        const spellings = new Set(options.flatMap(sameWork));
        return { pick, takes: (reading: Reading) => reading.url !== null && sameWork(reading.url).some((spelling) => spellings.has(spelling)), all: 0 };
      }),
    ];
    for (const { pick, takes, all } of proposals) {
      const group: Group = { kind: "group", pick, members: free.filter((entry) => takes(entry.block!.reading!)) };
      if (!isChoice(group) || (all && group.members.length !== all)) continue;
      items.splice(items.indexOf(group.members[0]), 1, group);
      for (const member of group.members.slice(1)) items.splice(items.indexOf(member), 1);
      for (const member of group.members) free.splice(free.indexOf(member), 1);
    }
  }

  const entries: Entry[] = [];
  /** Entries this pass rewrote: each but the file's last ends with an empty line, as a reading that moved may have ended the file. */
  const respaced = new Set<Entry>();
  const rewritten = (entry: Entry, to: number, fix = (text: string) => text): Entry => {
    const out: Entry = { ...entry, text: (path) => fix(atLevel(entry.text(path), to)) };
    respaced.add(out);
    return out;
  };
  /** The level of the Iliad lens the entries now follow; undefined before one, and after a submodule heading or another block. */
  let lensLevel: number | undefined;
  for (const item of items) {
    if (item.kind !== "group") {
      if (item.kind === "lens" && item.lens) lensLevel = level(item);
      else if (item.kind !== "lens") lensLevel = undefined;
      entries.push(lensLevel !== undefined && !item.lens && level(item) > lensLevel ? rewritten(item, lensLevel) : item);
      continue;
    }
    const at = lensLevel ?? (item.header ? level(item.header) : 1);
    if (!isChoice(item)) {
      const heading = item.header!.block!.raw.split("\n")[0];
      warnings.push(
        `The choice group "${heading}" in the module "${draft.title}" (${draft.path}) has ${item.members.length} reading(s) and asks for ${item.pick}, so it offers no choice. The sync took the heading out${item.header!.block!.raw.split("\n").slice(1).join("").trim() ? ", with the text under it," : ""} and kept its readings as plain entries.`,
      );
      entries.push(...item.members.map((member) => (level(member) === at ? member : rewritten(member, at))));
      continue;
    }
    const heading = `${"#".repeat(at)} Choose: ${item.pick}${/\bof\s+\d+\s*$/i.test(item.header?.block!.title ?? "") ? ` of ${item.members.length}` : ""}`;
    const header: Entry = item.header ? { ...item.header, text: (path) => item.header!.text(path).replace(/^.*/, heading) } : { kind: "other", text: () => `${heading}\n\n` };
    respaced.add(header);
    entries.push(header, ...item.members.map((member) => rewritten(member, at + 1, (text) => text.replace(REFUSED_IN_GROUP, ""))));
    for (const member of item.members) if (member.block?.reading) grouped.add(member.block.reading.path);
  }
  entries.forEach((entry, i) => {
    if (i + 1 < entries.length && (respaced.has(entry) || respaced.has(entries[i + 1]))) entry.gap = "blank";
  });
  draft.entries = entries;
}

/**
 * What a run must do to the files. Pure: nothing is read or written here.
 * `state` is the course as `readCourseState` found it with the same layout.
 */
export function planCourseFiles(state: CourseState, input: SyncInput, options: PlanOptions = {}): FilePlan {
  const layout = options.layout ?? LAYOUT;
  const newId = options.newId ?? randomUUID;
  const warnings = [...state.warnings];
  const steps: Step[] = [];

  checkMissingLenses(state, input, layout);
  const after = lensesAfter(state, input, layout, newId);
  const continued = new Map(after.flatMap((lens) => (lens.old ? [[lens.old, lens] as const] : [])));
  const retired = state.lenses.filter((old) => !continued.has(old));
  const removes = retired.map((old) => `Lens retired: "${old.title}" (${old.path}). Why: ${options.retireReasons?.get(old.id) ?? "its text is not in the source any more"}.`);

  // ---- Where every file goes. `moved` is complete before any text is rendered.
  const moved = new Map<string, string>();
  for (const lens of after) if (lens.old && lens.old.path !== lens.path) moved.set(lens.old.path, lens.path);
  const drafts = state.modules.map((module): Draft => {
    // A module without a lens of the sync's is someone else's (a shared introduction, say): it stays where it is.
    const own = module.blocks.some((block) => block.lens);
    const path = own ? `${layout.moduleDir}/${posix.basename(module.path)}` : module.path;
    if (path !== module.path) moved.set(module.path, path);
    // What stands before the first heading is not an entry: nothing goes above it.
    const preamble = module.blocks[0]?.type === "" ? module.blocks[0].raw : "";
    const entries = module.blocks.slice(preamble ? 1 : 0).map((block): Entry => ({
      kind: block.type === "submodule" ? "submodule" : block.type === "lens" ? "lens" : "other",
      text: (to) => relink(block.raw, module.path, to, moved),
      block,
      lens: block.lens && continued.get(block.lens),
    }));
    return { from: module, path, title: module.title, head: module.head + preamble, entries };
  });
  const { carded, lists } = placeCards(state, after, moved, removes);

  // ---- Modules: retired lenses out. So is a lens whose section went to a
  // worksheet of another day: it is placed again below, with the new lenses.
  /** Worksheet slug to the code of its day, for every worksheet the source lists. */
  const dayOf = new Map(input.worksheets.map(({ worksheet }) => [worksheet.slug, worksheet.dayCode]));
  for (const draft of drafts) {
    let submodule: Entry | undefined;
    draft.entries = draft.entries.filter((entry) => {
      if (entry.kind === "submodule") submodule = entry;
      const old = entry.block?.lens;
      if (!old) return true;
      const wasIn = dayOf.get(old.slug);
      if (entry.lens && (wasIn === undefined || wasIn === entry.lens.worksheet.dayCode)) return true;
      if (submodule) submodule.lostEntry = true;
      return false;
    });
  }
  removeUnlinkedReadings(drafts, state, after, dayOf, carded, removes);

  // ---- Modules: new lenses in, then choice groups.
  const courseEntries = state.blocks.map((block): Entry => ({
    kind: block.module ? "module" : "other",
    text: (to) => relink(block.raw, state.path, to, moved),
    module: drafts.find((draft) => draft.from === block.module),
  }));
  placeNewEntries(after, drafts, courseEntries, state.path, layout, newId, warnings);

  for (const { worksheet } of input.worksheets) {
    const listed = drafts.flatMap((draft) => draft.entries.flatMap((entry) => (entry.lens?.worksheet === worksheet ? entry.lens : [])));
    const planned = after.filter((lens) => lens.worksheet === worksheet);
    if (listed.length === planned.length && listed.some((lens, i) => lens !== planned[i])) {
      warnings.push(
        `${worksheet.code} ${worksheet.title}: the source now has these sections in another order than the module lists their lenses. The sync kept the module's order. To do: reorder the "# Lens:" entries in the module by hand if the course should follow the source.`,
      );
    }
  }
  /** Every reading in a choice group after the run. */
  const grouped = new Set<string>();
  for (const draft of drafts) {
    draft.entries = draft.entries.filter((entry, i, all) => !(entry.lostEntry && (i + 1 === all.length || all[i + 1].kind === "submodule")));
    if (draft.entries.some((entry) => entry.lens)) arrangeChoices(draft, lists, state.rules !== SYNC_RULES, grouped, warnings);
  }
  settleLists(lists, grouped, removes);

  // A worksheet the schedule still lists, of which no lens is left: its page is empty, or all of it is hidden.
  const emptied = input.worksheets.flatMap(({ worksheet }) => {
    const olds = state.lenses.filter((old) => old.slug === worksheet.slug);
    return olds.length && olds.every((old) => !continued.has(old)) ? [worksheet] : [];
  });
  checkRemovals(removes, emptied, input.commit, options.approvedRetirement);

  /**
   * Move the file read as `was` to `path`, and write `content` there unless
   * Lens shows that already. A write is checked against the file as read,
   * pending suggestions and all, and warns with `gone` when it loses some.
   */
  const put = (path: string, content: string, was: { path: string; content: string; published: string } | undefined, gone: string): boolean => {
    if (was && was.path !== path) steps.push({ do: "move", from: was.path, to: path, expects: was.content });
    if (content === was?.published) return false;
    steps.push({ do: "write", path, content, ...(was?.path === path ? { expects: was.content } : {}) });
    if (was && was.published !== was.content) warnings.push(gone);
    return true;
  };

  // ---- Lens files, then module files, then the trash, then the course file.
  for (const lens of after) {
    const { worksheet, input: planned, old } = lens;
    const compose = (commit: string) =>
      composeLens({
        path: lens.path,
        was: old?.published ?? null,
        id: lens.id,
        title: lens.title,
        tldr: planned.tldr ?? old?.tldr ?? null,
        summaryForTutor: planned.summaryForTutor ?? old?.summaryForTutor ?? null,
        authors: worksheet.contributors,
        sourceUrl: worksheet.pageUrl,
        key: planned.planned.key,
        fingerprint: planned.fingerprint,
        commit,
        atoms: planned.planned.atoms,
        cards: lens.cards,
        transcripts: state.transcripts,
      });
    // Under the commit it has, is the file what it would be? Then it has not changed.
    const asBefore = old?.upstreamCommit ? compose(old.upstreamCommit) : undefined;
    const file = old && asBefore?.content === old.published ? asBefore : compose(input.commit);
    const gone = `The lens "${lens.title}" (${lens.path}) had pending suggestions. They are gone: the sync rewrote the lens from the source, because the lens is a copy of Iliad's page. Nothing to do; the file's history in the Lens Editor has them.`;
    if (!put(lens.path, file.content, old, gone)) continue;
    warnings.push(...file.warnings);
    if (old?.others.length) {
      warnings.push(`The lens "${old.title}" (${lens.path}) had a segment the source does not have (${old.others.join(", ")}). The sync rewrote the lens without it: the lens is a copy of the source. Nothing to do; the file's history in the Lens Editor still has the segment.`);
    }
  }

  for (const draft of drafts) {
    if (draft.from && draft.from.blocks.some((block) => block.lens) && !draft.entries.some((entry) => entry.lens)) {
      warnings.push(
        `Every lens of the module "${draft.title}" (${draft.path}) is gone from the source. The course still lists the module, so learners see a module without Iliad's material. ` +
          `To do: delete the module's "# Module:" line from the course file "${state.path}", then delete the module file. The sync does neither by itself.`,
      );
    }
    put(draft.path, render(draft.head, draft.entries, draft.path), draft.from, suggestionsGone(`the module "${draft.title}" (${draft.path})`));
  }

  for (const old of retired) steps.push({ do: "trash", path: old.path, expects: old.content });

  const head = setFrontmatter(state.head, { upstream_commit: `upstream_commit: '${input.commit}'`, sync_rules: `sync_rules: '${SYNC_RULES}'` });
  put(state.path, render(head, courseEntries, state.path), state, suggestionsGone(`the course file (${state.path})`));

  return { commit: input.commit, changed: steps.length > 0, steps, removes, warnings };
}

/**
 * Carry out a plan, or with `dryRun` only report it.
 *
 * Before the first step on a file that was there when the course was read,
 * the file is read again (one read for each such file, about 4 ms on a
 * relay on the same machine): if a person or another tool saved it in the
 * meantime, the run stops before touching it. A failed move or write stops
 * the run too. In both cases the course file keeps the old commit, so the
 * next run plans again from the files as they then are.
 *
 * A lens that cannot be trashed (the relay refuses while another file links
 * to it) stays where it is and is reported: the course no longer lists it,
 * so nothing is broken.
 */
export async function applyFilePlan(files: CourseFiles, plan: FilePlan, { dryRun = false } = {}): Promise<SyncReport> {
  const report: SyncReport = { commit: plan.commit, changed: plan.changed, written: [], moved: [], retired: [], warnings: [...plan.warnings] };
  // The relay respells the links to a file it moves, in every file that has one. That is not a person's edit.
  const moves = new Map(plan.steps.flatMap((step) => (step.do === "move" ? [[step.from, step.to] as const] : [])));
  for (const [i, step] of plan.steps.entries()) {
    if (step.do === "move") report.moved.push({ from: step.from, to: step.to });
    else if (step.do === "write") report.written.push(step.path);
    else report.retired.push(step.path);
    if (dryRun) continue;

    const path = step.do === "move" ? step.from : step.path;
    const stopped = `The sync stopped at step ${i + 1} of ${plan.steps.length}`;
    const next = `Nothing to do: the course file keeps the old source commit, so the next run starts again from the files as they are then.`;
    if (step.expects !== undefined) {
      const now = await files.read(path);
      if (now === null || withFullLinks(now, path, moves) !== withFullLinks(step.expects, path, moves)) {
        throw new Error(`"${path}" was ${now === null ? "moved or deleted" : "changed"} while this run was under way, by a person or another tool. ${stopped}, before touching the file, so that the change is kept. ${next}`);
      }
    }
    try {
      if (step.do === "move") await files.move(step.from, step.to);
      else if (step.do === "write") await files.write(step.path, step.content);
      else await files.trash(step.path);
    } catch (err) {
      const reason = (err as Error).message;
      if (step.do !== "trash") {
        const doing = step.do === "move" ? `moving "${step.from}" to "${step.to}"` : `writing "${step.path}"`;
        throw new Error(`${stopped}, ${doing}: ${reason}. ${next} If the same step fails on every run, the reason above is what to look into.`);
      }
      report.warnings.push(
        `The lens "${step.path}" is gone from the source, and no module of the course lists it any more, so learners do not see it. Moving it to the trash failed (${reason}). ` +
          `To do: delete the file in the Lens Editor; if another file still links to it, correct that link first. Until then the file does no harm, but it stays in search.`,
      );
    }
  }
  return report;
}
