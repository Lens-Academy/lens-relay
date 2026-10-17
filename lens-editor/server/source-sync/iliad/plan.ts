/**
 * Group each worksheet's Atoms into lenses.
 *
 * Learner progress is keyed on a lens id. A lens that exists therefore keeps
 * its id and its start: it is pinned to "<slug>#<anchor of its first atom>",
 * and only what no pinned lens holds is grouped by size. A pin that is put on
 * the wrong atom gives a learner credit for content they did not read, so a
 * pin whose place is in doubt is retired.
 *
 * The rules, in the order the code applies them.
 *
 * Where a lens that exists goes (`planCourse`):
 *
 *   1. On its own anchor, with no look at the text, when the worksheet has
 *      one atom of that name and had one when the lens was written. The lens
 *      keeps its place under any edit to its text.
 *   2. Otherwise only by its text: at the atom from which the source is most
 *      like the lens's fingerprint, when it is like enough. This finds a lens
 *      whose heading was renamed, whose section moved to another worksheet,
 *      or whose worksheet was renamed. A heading that the worksheet has, or
 *      had, several times never decides alone: the site tells such headings
 *      apart by "-1", "-2", which count the namesakes above, so a namesake
 *      that is added, removed or renamed moves the anchors of the others onto
 *      other sections. When the text is in several places, the lens's own
 *      anchor is taken if its text is there too, or else the one place in
 *      its own worksheet between its neighbouring lenses; with none or
 *      several such, its place is in doubt.
 *   3. Otherwise, when its first atom is gone, at the first atom it held that
 *      is still in its worksheet, if the text there is text of the lens: its
 *      learners read what is left of it. Atoms right before that atom whose
 *      text is text of the lens are the start of the lens under a new name.
 *   4. Otherwise it is retired. So is a lens that would hold only atoms a
 *      learner sees none of (0 words).
 *
 * What each lens holds (`layOut`). An atom is new when no lens of its
 * worksheet held it when last written.
 *
 *   5. A lens is a run of consecutive atoms of one worksheet, and the lenses
 *      of a worksheet hold all its atoms in order. A pinned lens runs to the
 *      next pinned lens or the end of the worksheet. New atoms there join it,
 *      except a new section: a run of new atoms from an H2 or H3 heading on
 *      with MIN_WORDS or more is a lens of its own, or several (`pack`). New
 *      material without a heading of its own (an H4, an exercise, text) or
 *      shorter than that joins the lens before it.
 *   6. A pinned lens that would still pass MAX_WORDS has new lenses cut off
 *      it, and only at new atoms.
 *   7. The atoms before the first pinned lens are packed by size. Fewer than
 *      MIN_WORDS of them join the first pinned lens, which then starts
 *      earlier and is keyed on its new first atom.
 *
 * How atoms are packed by size (`pack`): see there.
 */

import { headingAnchor } from "./anchor";
import { lensKey, type Atom, type Pin, type PlannedLens } from "./types";

/** A section smaller than this never stands alone as a lens. */
const MIN_WORDS = 200;
/** A lens is cut inside an H2 section only when it would otherwise pass this. */
const MAX_WORDS = 3000;

/** One lens of the plan, with the fingerprint its file stores for the next run's Pin. */
export type PlannedLensWithPrint = PlannedLens & { fingerprint: string };

export interface CoursePlan {
  /**
   * Every worksheet given, in that order, with its lenses in reading order.
   * The lenses hold all its atoms; a worksheet a learner sees nothing of
   * (every atom has 0 words) has none. A lens that continues a pin at
   * another atom than the pin's has `pinned.key !== key`.
   */
  worksheets: { slug: string; lenses: PlannedLensWithPrint[] }[];
  /**
   * The pins that have no lens in the plan, each with the reason in plain
   * words for the run's log. They are not per worksheet: a pin can outlive
   * the worksheet it was in.
   */
  retired: { pin: Pin; reason: string }[];
}

/** A lens that exists before the first run, as its file describes it. */
export interface ExistingLens {
  /** The lens `id` in its frontmatter. */
  id: string;
  /** Anchors of the headings in the lens body, in order. */
  headingAnchors: string[];
  /** The lens body: its Text segments, in reading order. */
  text: string;
}

// -------------------------------------------------------------- fingerprint
//
// A fingerprint is "<marks>/<words>/<namesakes>/<sketch>", in letters and
// digits.
//
// - marks: 3 characters per atom of the lens, in order: a hash of the atom's
//   name. They tell an atom that a lens held from one that is new, and which
//   atoms of a lens are left when its first is gone.
// - words: the size of the lens in `Atom.words`.
// - namesakes: how many atoms of the worksheet had the name of the lens's
//   first atom when the fingerprint was made. More or fewer of them later
//   means the anchor of the lens may have moved onto another section.
// - sketch: what the lens says. Its text, without maths and markup, is cut
//   into pairs of consecutive words; each pair is hashed; the sketch is the
//   SKETCH smallest hashes (a bottom-k MinHash). Two sketches give an
//   estimate of the Jaccard similarity of the two sets of word pairs, good
//   to about 0.09. An edit moves it by the share of pairs it touches, and
//   the sketch of several atoms is the smallest hashes of their sketches.
//
// A sketch cannot tell a lens from the same lens with a short section more
// or less. The sizes can: two texts are at most as alike as the smaller is
// to the larger. `similarity` is the lower of the two.

/** Hashes kept in a sketch: 128 characters. */
const SKETCH = 32;
const SKETCH_DIGITS = 4;
const MARK_DIGITS = 3;

/**
 * The similarity from which a place is taken to be the lens. 0.6 means about
 * three quarters of the word pairs are still there. Two different sections
 * of the course are below 0.15, with the exception named at CLEAR_BY.
 */
export const MATCH = 0.6;
/**
 * A second, separate place this close to the best one is as good a match.
 * The course has such a pair: A.2 and A.3 each have a section on AI control,
 * and the two are 0.91 alike.
 */
const CLEAR_BY = 0.1;
/** A lens with fewer word pairs than this says too little to be found by its text. */
const MIN_EVIDENCE = 8;

type Sketch = number[];

interface Print {
  marks: string[];
  words: number;
  namesakes: number;
  sketch: Sketch;
}

/**
 * The fingerprint of a lens made of `atoms`, which are atoms of `worksheet`.
 * `planCourse` gives each lens of its plan its fingerprint; this is for a
 * lens made another way.
 */
export function fingerprint(atoms: Atom[], worksheet: Atom[]): string {
  return encode({
    marks: atoms.map(markOf),
    words: wordsIn(atoms),
    namesakes: atoms.length ? namesakes(worksheet, nameOf(atoms[0])) : 0,
    sketch: sketchOf(textOf(atoms)),
  });
}

/** How alike two fingerprinted lenses are, 0 to 1: the estimated share of word pairs they have in common. */
export function fingerprintSimilarity(a: string, b: string): number {
  return similarity(decode(a), decode(b));
}

function similarity(a: Pick<Print, "sketch" | "words">, b: Pick<Print, "sketch" | "words">): number {
  return Math.min(resemblance(a.sketch, b.sketch), sizeRatio(a.words, b.words));
}

function sizeRatio(a: number, b: number): number {
  return Math.min(a, b) / Math.max(a, b, 1);
}

const wordsIn = (atoms: Atom[]) => atoms.reduce((sum, a) => sum + a.words, 0);

function textOf(atoms: Atom[]): string {
  return atoms.flatMap((a) => a.parts.map((p) => (p.kind === "text" ? p.markdown : (p.title ?? "")))).join("\n");
}

/**
 * The words of Lens markdown or MDX, in order: lower case, letters only.
 * Maths, tags, callout fences and link targets are left out, because the
 * same text carries them differently before and after conversion, and
 * numbers because Iliad's build renumbers exercises and sections.
 */
function tokens(markdown: string): string[] {
  return (
    markdown
      .replace(/\$\$[\s\S]*?\$\$/g, " ")
      .replace(/\$[^$\n]*\$/g, " ")
      .replace(/^:::.*$/gm, " ")
      .replace(/<[^>\n]*>/g, " ")
      .replace(/\]\([^)\s]*\)/g, "] ")
      .toLowerCase()
      .match(/\p{L}{2,}/gu) ?? []
  );
}

/** The distinct hashes of the pairs of consecutive words, smallest first. */
function pairs(words: string[]): number[] {
  const hashes = new Set<number>();
  for (let i = 0; i + 1 < words.length; i++) hashes.add(hash(`${words[i]} ${words[i + 1]}`) % 62 ** SKETCH_DIGITS);
  return [...hashes].sort((a, b) => a - b);
}

function sketchOf(text: string): Sketch {
  return pairs(tokens(text)).slice(0, SKETCH);
}

/** The sketch of two texts together. Both are sorted, and so is the result. */
function merge(a: Sketch, b: Sketch): Sketch {
  const out: Sketch = [];
  for (let i = 0, j = 0; out.length < SKETCH && (i < a.length || j < b.length); ) {
    const x = a[i] ?? Infinity;
    const y = b[j] ?? Infinity;
    out.push(Math.min(x, y));
    if (x <= y) i++;
    if (y <= x) j++;
  }
  return out;
}

/** Jaccard estimate: of the SKETCH smallest hashes of both sets together, the share that is in both. */
function resemblance(a: Sketch, b: Sketch): number {
  let seen = 0;
  let both = 0;
  for (let i = 0, j = 0; seen < SKETCH && (i < a.length || j < b.length); seen++) {
    const x = a[i] ?? Infinity;
    const y = b[j] ?? Infinity;
    if (x === y) both++;
    if (x <= y) i++;
    if (y <= x) j++;
  }
  return seen ? both / seen : 0;
}

/** FNV-1a, finished with murmur3's mixer so that short strings spread over all 32 bits. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function digits(value: number, width: number): string {
  let out = "";
  for (let i = 0; i < width; i++, value = Math.floor(value / 62)) out = DIGITS[value % 62] + out;
  return out;
}

/**
 * An atom's name: its anchor without the "-1", "-2" that the site adds to a
 * heading text that repeats. Atoms of one name are namesakes. The heading's
 * own text tells that suffix from a number the heading ends in ("Session 6").
 * An exercise's id is its name: the site never numbers it.
 */
function nameOf(atom: Atom): string {
  if (atom.level < 2 || atom.level > 4) return atom.anchor;
  const base = headingAnchor(atom.title);
  if (atom.anchor === base || (atom.anchor.startsWith(base) && /^-\d+$/.test(atom.anchor.slice(base.length)))) return base;
  // An anchor not made from the title: taking any final number for a suffix only makes rule 2 read the text more often.
  return atom.anchor.replace(/-\d+$/, "");
}

/** How many atoms of a worksheet have this name. */
function namesakes(worksheet: Atom[], name: string): number {
  return worksheet.filter((a) => nameOf(a) === name).length;
}

/** An atom's mark: a hash of its name, which stays when the site renumbers its anchor. */
function markOf(atom: Atom): string {
  return digits(hash(nameOf(atom)) % 62 ** MARK_DIGITS, MARK_DIGITS);
}

function encode(print: Print): string {
  return [print.marks.join(""), print.words, print.namesakes, print.sketch.map((h) => digits(h, SKETCH_DIGITS)).join("")].join("/");
}

/** The parts of a fingerprint. One that is empty or not ours has no marks, and nothing is known of its lens. */
function decode(print: string): Print {
  const [marks = "", words = "", count = "", sketch = ""] = /^[0-9A-Za-z]*\/\d+\/\d+\/[0-9A-Za-z]*$/.test(print) ? print.split("/") : [];
  const value = (text: string) => [...text].reduce((n, c) => n * 62 + DIGITS.indexOf(c), 0);
  return {
    marks: marks.match(new RegExp(`.{${MARK_DIGITS}}`, "g")) ?? [],
    words: Number(words),
    namesakes: Number(count),
    sketch: (sketch.match(new RegExp(`.{${SKETCH_DIGITS}}`, "g")) ?? []).map(value),
  };
}

// ----------------------------------------------------------------- adoption

/** How many of a lens's first words are compared with an atom's first words. */
const OPENING = 40;
/** The share of them that must be there for the lens to begin at that atom. */
const OPENING_MATCH = 0.5;
/** The share of a text's word pairs that must be found in another text for it to be part of that text. */
const CONTAINED = 0.8;

/**
 * The Pin for a lens that was made by hand, or null when the lens does not
 * begin where an atom begins. The lens begins at an atom when its first
 * words are that atom's first words. Of the atoms where it does, one that
 * the lens's first heading names is taken; otherwise the lens's text must be
 * found from the atom on. The whole text only ranks the candidates, because
 * the hand import sometimes kept part of an atom or moved text in from
 * elsewhere.
 */
export function adoptPin(slug: string, atoms: Atom[], lens: ExistingLens): Pin | null {
  const words = tokens(lens.text);
  const opening = new Set(words.slice(0, OPENING));
  const whole = pairs(words);
  const inLens = new Set(whole);
  const atomWords = atoms.map((a) => tokens(textOf([a])));
  const atomPairs = atomWords.map(pairs);
  const named = lens.headingAnchors[0];

  let best: { index: number; end: number; named: boolean; similarity: number } | null = null;
  for (let index = 0; index < atoms.length; index++) {
    const start = new Set<string>();
    for (let i = index, taken = 0; i < atoms.length && taken < OPENING; taken += atomWords[i++].length) {
      for (const word of atomWords[i].slice(0, OPENING - taken)) start.add(word);
    }
    if ([...opening].filter((w) => start.has(w)).length < OPENING_MATCH * opening.size) continue;

    // The stretch from this atom on that is most like the lens, and how much of the lens is found from here on.
    const seen = new Set<number>();
    let shared = 0;
    let candidate = { index, end: index, named: named !== undefined && atoms.some((a) => a.anchor === named && nameOf(a) === nameOf(atoms[index])), similarity: 0 };
    for (let end = index; end < atoms.length; end++) {
      for (const pair of atomPairs[end]) {
        if (seen.has(pair)) continue;
        seen.add(pair);
        if (inLens.has(pair)) shared++;
      }
      const alike = shared / (seen.size + inLens.size - shared || 1);
      if (alike > candidate.similarity) candidate = { ...candidate, end, similarity: alike };
    }
    if (!candidate.named && (inLens.size === 0 || shared < CONTAINED * inLens.size)) continue;
    if (!best || (candidate.named && !best.named) || (candidate.named === best.named && candidate.similarity > best.similarity)) best = candidate;
  }
  if (!best) return null;

  // The atoms it held: the stretch most like it, and any other its headings name, so that none counts as new.
  const held = atoms.slice(best.index, best.end + 1).map(markOf);
  const others = atoms.filter((a) => lens.headingAnchors.includes(a.anchor)).map(markOf).filter((m) => !held.includes(m));
  return {
    key: lensKey(slug, atoms[best.index].anchor),
    id: lens.id,
    fingerprint: encode({
      marks: [...held, ...others],
      words: wordsIn(atoms.slice(best.index, best.end + 1)),
      namesakes: namesakes(atoms, nameOf(atoms[best.index])),
      sketch: whole.slice(0, SKETCH),
    }),
  };
}

// ----------------------------------------------------------------- planning

interface Sheet {
  slug: string;
  atoms: Atom[];
}

/** An atom a lens can start at: `sheets[sheet].atoms[index]`. */
interface Spot {
  sheet: number;
  index: number;
}

/** The reason a lens is retired whose atoms are all hidden from learners. */
const HIDDEN = "all that is left of it in the source is hidden from learners";

/** In a stretch that should be text of a lens, this many of its word pairs must be ones the lens's sketch can speak for. */
const MIN_SAMPLE = 4;

/**
 * Plan every worksheet. `pins` are the lenses that exist, in the order the
 * module files list them. The rules are at the top of this file.
 */
export function planCourse(sheets: Sheet[], pins: Pin[]): CoursePlan {
  /** starts[sheet][index]: the pin whose lens starts at that atom. */
  const starts: (Pin | undefined)[][] = sheets.map((s) => new Array<Pin | undefined>(s.atoms.length).fill(undefined));
  const free = (spot: Spot) => starts[spot.sheet][spot.index] === undefined;
  const placed = new Set<Pin>();
  const place = (pin: Pin, spot: Spot) => {
    starts[spot.sheet][spot.index] = pin;
    placed.add(pin);
  };
  /** What its text says of a pin that found no place, for the pins that end without one. */
  const why = new Map<Pin, string>();

  const known = pins.map((pin) => {
    const cut = pin.key.indexOf("#");
    const slug = pin.key.slice(0, cut);
    const anchor = pin.key.slice(cut + 1);
    const sheet = sheets.findIndex((s) => s.slug === slug);
    const atoms = sheets[sheet]?.atoms ?? [];
    const index = atoms.findIndex((a) => a.anchor === anchor);
    const print = decode(pin.fingerprint);
    // The pin's name is the mark of its lens's first atom. With no fingerprint, it is taken to be its anchor without a final number.
    const named = (a: Atom) => (print.marks.length ? markOf(a) === print.marks[0] : a.anchor.replace(/-\d+$/, "") === anchor.replace(/-\d+$/, ""));
    return {
      pin,
      slug,
      anchor,
      sheet,
      /** The atom the pin's key names, when the worksheet has it. */
      home: index < 0 ? null : { sheet, index },
      /** How many atoms of the worksheet have the pin's name now. */
      now: atoms.filter(named).length,
      print,
    };
  });
  type Known = (typeof known)[number];
  const unplaced = () => known.filter((k) => !placed.has(k.pin));

  // The text of each worksheet is read only when a pin must be found by it.
  const pairsBySheet = new Map<number, number[][]>();
  const pairsOf = (sheet: number) => {
    if (!pairsBySheet.has(sheet)) pairsBySheet.set(sheet, sheets[sheet].atoms.map((a) => pairs(tokens(textOf([a])))));
    return pairsBySheet.get(sheet)!;
  };
  /** How like a lens the atoms from a spot on are, at their best length. A lens ends before the next pinned one. */
  const likeness = (lens: Print, spot: Spot): { similarity: number; end: number } => {
    const { atoms } = sheets[spot.sheet];
    let best = { similarity: 0, end: spot.index };
    const stretch = { sketch: [] as Sketch, words: 0 };
    for (let end = spot.index; end < atoms.length; end++) {
      if (end > spot.index && starts[spot.sheet][end]) break;
      stretch.sketch = merge(stretch.sketch, pairsOf(spot.sheet)[end].slice(0, SKETCH));
      stretch.words += atoms[end].words;
      const alike = similarity(lens, stretch);
      if (alike > best.similarity) best = { similarity: alike, end };
      // Longer than the lens, a stretch only gets less like it.
      if (stretch.words > lens.words && sizeRatio(lens.words, stretch.words) <= best.similarity) break;
    }
    return best;
  };
  /**
   * Whether atoms[from..to) of a worksheet are text of a lens. The lens's
   * sketch holds its smallest pair hashes, so every pair of the stretch that
   * is no larger than the sketch's largest must be in the sketch.
   */
  const isTextOf = (lens: Print, sheet: number, from: number, to: number): boolean => {
    const bound = lens.sketch.length === SKETCH ? lens.sketch[SKETCH - 1] : Infinity;
    const sample = new Set(pairsOf(sheet).slice(from, to).flat().filter((pair) => pair <= bound));
    const inLens = [...sample].filter((pair) => lens.sketch.includes(pair)).length;
    return sample.size >= MIN_SAMPLE && inLens >= CONTAINED * sample.size;
  };

  // Rule 1: its own anchor, when the name is and was the only one of its kind.
  // A pin with no fingerprint of ours has nothing else to be placed by, so a
  // name the worksheet has once is enough for it.
  for (const k of known) {
    const single = k.now === 1 && (k.print.namesakes === 1 || k.print.marks.length === 0);
    if (k.home && free(k.home) && single) place(k.pin, k.home);
  }

  /** Whether a spot is in the pin's own worksheet, after the lens before it and before the lens after it (in the pins' order) where these start now. */
  const between = (k: Known) => {
    const own = starts[k.sheet] ?? [];
    const at = known.indexOf(k);
    const nearest = (list: Known[]) => list.map((other) => (other.slug === k.slug ? own.indexOf(other.pin) : -1)).find((index) => index >= 0);
    const before = nearest(known.slice(0, at).reverse()) ?? -1;
    const after = nearest(known.slice(at + 1)) ?? Infinity;
    return (spot: Spot) => spot.sheet === k.sheet && spot.index > before && spot.index < after;
  };

  // Rule 2: by text, among all atoms that start no lens yet. The surest match takes its place first.
  const found: { pin: Pin; spot: Spot; similarity: number }[] = [];
  for (const k of unplaced()) {
    if (k.print.sketch.length < MIN_EVIDENCE) continue;
    const places: { spot: Spot; similarity: number; end: number }[] = [];
    for (let sheet = 0; sheet < sheets.length; sheet++) {
      for (let index = 0; index < sheets[sheet].atoms.length; index++) {
        const spot = { sheet, index };
        const like = free(spot) ? likeness(k.print, spot) : null;
        if (like && like.similarity >= MATCH - CLEAR_BY) places.push({ spot, ...like });
      }
    }
    const best = places.reduce<(typeof places)[number] | null>((a, b) => (a && a.similarity >= b.similarity ? a : b), null);
    if (!best || best.similarity < MATCH) continue;
    // Every separate place nearly as like as the best is as good a match.
    const separate = (a: (typeof places)[number], b: (typeof places)[number]) => a.spot.sheet !== b.spot.sheet || a.spot.index > b.end || a.end < b.spot.index;
    const matches = [best];
    for (const other of places) {
      if (other.similarity > best.similarity - CLEAR_BY && matches.every((m) => separate(m, other))) matches.push(other);
    }
    // Of several, the pin's own anchor when its text is there too (namesakes with the same text), or else
    // the one place in its own worksheet between its neighbouring lenses.
    const near = between(k);
    const sure = matches.filter((m) => m.similarity >= MATCH);
    const own = sure.find((m) => k.home && m.spot.sheet === k.home.sheet && m.spot.index === k.home.index);
    const local = sure.filter((m) => near(m.spot));
    const choice = matches.length === 1 ? best : (own ?? (local.length === 1 ? local[0] : null));
    if (choice) found.push({ pin: k.pin, spot: choice.spot, similarity: choice.similarity });
    else why.set(k.pin, `its text is in ${matches.length} places of the source, and nothing says which of them is the lens`);
  }
  for (const { pin, spot } of found.sort((a, b) => b.similarity - a.similarity)) {
    if (free(spot)) place(pin, spot);
    else why.set(pin, "its text is where another lens already starts");
  }

  // Rule 3: its first atom is gone, or its anchor cannot say which section it
  // is. The lens goes on at the first atom it held that is left, if the atoms
  // it held from there on are text of it. Two such places leave it in doubt.
  for (const k of unplaced()) {
    const trusted = k.home && k.now === 1 && k.print.namesakes === 1;
    if (k.sheet < 0 || trusted) continue;
    const { atoms } = sheets[k.sheet];
    const leftAt = (wanted: string) =>
      atoms.flatMap((atom, index) => {
        if (markOf(atom) !== wanted || !free({ sheet: k.sheet, index })) return [];
        let end = index + 1;
        while (end < atoms.length && free({ sheet: k.sheet, index: end }) && k.print.marks.includes(markOf(atoms[end]))) end++;
        return isTextOf(k.print, k.sheet, index, end) ? [index] : [];
      });
    const left = k.print.marks.slice(1).map(leftAt).find((indexes) => indexes.length > 0) ?? [];
    if (left.length > 1) why.set(k.pin, `what is left of its text is in ${left.length} places of its worksheet, and nothing says which of them is the lens`);
    if (left.length !== 1) continue;
    // The atoms right before it that are text of the lens are its first atoms under another name.
    // An atom the lens before it held stays with that lens.
    let index = left[0];
    const before = starts[k.sheet].slice(0, index).findLast((pin) => pin !== undefined);
    const heldBefore = before ? decode(before.fingerprint).marks : [];
    while (index > 0 && free({ sheet: k.sheet, index: index - 1 }) && !heldBefore.includes(markOf(atoms[index - 1])) && isTextOf(k.print, k.sheet, index - 1, index)) index--;
    place(k.pin, { sheet: k.sheet, index });
  }

  // Rule 4: a lens a learner would see nothing of is no lens. Its atoms go where atoms with no pin go.
  sheets.forEach(({ atoms }, n) => {
    const pinned = starts[n].flatMap((pin, index) => (pin ? [index] : []));
    pinned.forEach((at, i) => {
      if (wordsIn(atoms.slice(at, pinned[i + 1] ?? atoms.length)) > 0) return;
      const pin = starts[n][at]!;
      why.set(pin, HIDDEN);
      placed.delete(pin);
      starts[n][at] = undefined;
    });
  });

  /**
   * In plain words, why a pin has no lens. It says first what became of the
   * lens's text (gone, in several places, hidden only), then of its anchor.
   */
  const reason = (k: Known): string => {
    const text = why.get(k.pin);
    if (text === HIDDEN) return text;
    if (k.home && !free(k.home) && k.now === 1 && k.print.namesakes === 1) return `another lens already starts at its section "${k.anchor}"`;
    const anchor =
      k.sheet < 0
        ? `its worksheet "${k.slug}" is gone from the source`
        : !k.home
          ? `its section "${k.anchor}" is gone from "${k.slug}"`
          : `"${k.slug}" has ${k.now} section(s) named like "${k.anchor}" and had ${k.print.namesakes}, so the anchor alone cannot say which is the lens`;
    const found =
      text ??
      (k.print.marks.length === 0
        ? "it has no fingerprint to be found by"
        : k.print.sketch.length < MIN_EVIDENCE
          ? "it has too little text to be found by"
          : "its text is not in the source any more");
    return `${found} (${anchor})`;
  };

  // An atom is new to a worksheet when no lens of it held the atom: no pin of the worksheet, placed or not, has its mark.
  const heldIn = sheets.map((sheet, n) => new Set(known.filter((k) => k.slug === sheet.slug || starts[n].includes(k.pin)).flatMap((k) => k.print.marks)));

  return {
    worksheets: sheets.map((sheet, n) => ({ slug: sheet.slug, lenses: layOut(sheet, starts[n], heldIn[n]) })),
    retired: unplaced().map((k) => ({ pin: k.pin, reason: reason(k) })),
  };
}

/**
 * The lenses of one worksheet (rules 5 to 7), given the pin that starts at
 * each atom and the marks of the atoms its lenses held.
 */
function layOut(sheet: Sheet, pinAt: (Pin | undefined)[], held: Set<string>): PlannedLensWithPrint[] {
  const { atoms } = sheet;
  // A worksheet that is all hidden has no lens. Any other atom of no words joins a lens that has some.
  if (wordsIn(atoms) === 0) return [];
  const pinned = pinAt.flatMap((pin, index) => (pin ? [index] : []));
  /** With no marks to go by (no fingerprint of ours), nothing is taken for new. */
  const isNew = (atom: Atom) => held.size > 0 && !held.has(markOf(atom));
  const lenses: PlannedLensWithPrint[] = [];
  const add = (from: number, cuts: number[], length: number, pin: Pin | null) =>
    cuts.forEach((cut, n) => {
      const part = atoms.slice(from + cut, from + (cuts[n + 1] ?? length));
      lenses.push({ key: lensKey(sheet.slug, part[0].anchor), pinned: n === 0 ? pin : null, atoms: part, fingerprint: fingerprint(part, atoms) });
    });

  // Rule 7. Fewer than MIN_WORDS before the first pin have no lens to join
  // but the first pinned one: a section that small never stands alone.
  let first = pinned[0] ?? atoms.length;
  if (pinned.length && wordsIn(atoms.slice(0, first)) < MIN_WORDS) first = 0;
  else if (first > 0) add(0, pack(atoms.slice(0, first)), first, null);

  pinned.forEach((at, n) => {
    const from = n === 0 ? first : at;
    const run = atoms.slice(from, pinned[n + 1] ?? atoms.length);
    // Rule 5: a new section after the pin's own atom is a lens of its own.
    const cuts = [0];
    for (let i = at - from + 1; i < run.length; i++) {
      if (!isNew(run[i])) continue;
      let end = i;
      while (end < run.length && isNew(run[end])) end++;
      const heading = run.slice(i, end).findIndex((atom) => atom.level === 2 || atom.level === 3);
      const section = heading < 0 ? [] : run.slice(i + heading, end);
      if (wordsIn(section) >= MIN_WORDS) cuts.push(...pack(section).map((cut) => i + heading + cut));
      i = end - 1;
    }
    // Rule 6: a lens still past MAX_WORDS is cut at new atoms only.
    const all = cuts.flatMap((cut, k) => {
      const part = run.slice(cut, cuts[k + 1] ?? run.length);
      return wordsIn(part) > MAX_WORDS ? pack(part, (index) => isNew(part[index])).map((inner) => cut + inner) : [cut];
    });
    add(from, all, run.length, pinAt[at]!);
  });
  return lenses;
}

/** An exercise: the level of an atom that starts at one. */
const EXERCISE = 5;
/** Deeper than any atom a lens can be cut at. It stands for text before the first heading, and for "none". */
const NO_CUT = 6;

/**
 * Pack a run of atoms into lenses by size and return where each lens starts
 * (the first is 0). `mayCut` limits the atoms a lens may start at.
 *
 * - At an H2: when the lens so far has MIN_WORDS, and the H2 section (the H2
 *   with every atom up to the next H2) has MIN_WORDS or would push the lens
 *   past MAX_WORDS. A small section so joins the lens before it.
 * - At an H3: only when staying in the lens would pass MAX_WORDS, and the
 *   part of the H2 section on each side of the cut keeps MIN_WORDS.
 * - At an H4: the same, and only inside a section that alone exceeds
 *   MAX_WORDS.
 * - At an exercise: the same again, and only in a stretch with no heading
 *   left to cut at. An exercise is not a heading: it never ends a section.
 * - A last lens under MIN_WORDS joins the lens before it.
 */
function pack(atoms: Atom[], mayCut: (index: number) => boolean = () => true): number[] {
  const upTo = [0];
  for (const atom of atoms) upTo.push(upTo[upTo.length - 1] + atom.words);
  const words = (from: number, to: number) => upTo[to] - upTo[from];
  const starts = [0];
  const lensStart = () => starts[starts.length - 1];

  /**
   * Cut atoms[from..to) where its shallowest atoms start, and what is between
   * them at the next level down. `section` is where the section these atoms
   * are in begins: its heading, or the start of the run.
   */
  const cut = (from: number, to: number, section: number) => {
    const level = Math.min(NO_CUT, ...atoms.slice(from, to).map((a) => a.level || NO_CUT));
    const tried =
      level === 2 ||
      (level === 3 && words(lensStart(), to) > MAX_WORDS) ||
      ((level === 4 || level === EXERCISE) && words(section, to) > MAX_WORDS);
    if (!tried) return;

    const heads = atoms.flatMap((a, i) => (i >= from && i < to && a.level === level ? [i] : []));
    cut(from, heads[0], section);
    heads.forEach((head, n) => {
      const end = heads[n + 1] ?? to;
      const passes = words(lensStart(), end) > MAX_WORDS;
      const here =
        level === 2
          ? words(lensStart(), head) >= MIN_WORDS && (words(head, end) >= MIN_WORDS || passes)
          : passes && words(Math.max(lensStart(), section), head) >= MIN_WORDS && words(head, to) >= MIN_WORDS;
      if (here && head > lensStart() && mayCut(head)) starts.push(head);
      cut(head + 1, end, head);
    });
  };

  cut(0, atoms.length, 0);
  if (starts.length > 1 && words(lensStart(), atoms.length) < MIN_WORDS) starts.pop();
  return starts;
}
