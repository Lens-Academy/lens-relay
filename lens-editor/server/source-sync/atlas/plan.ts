/**
 * Step 4 of the Atlas sync: which lens each section is, and which lenses go.
 *
 * Learner progress is keyed on a lens id, so a section keeps the id of the
 * lens it had, found among the lenses of its chapter (same chapter slug, or
 * same Doc tab, so a renamed chapter keeps them too):
 *   1. by its Heading 1's `headingId`, which the Doc keeps through renames
 *      and moves; not when several sections of the run have it, as a
 *      pasted copy of a section has its heading's id;
 *   2. else by its address, "<chapter slug>#<section slug>", when one
 *      section and one lens have it: a heading typed again keeps its lens;
 *   3. else by text: the lens whose fingerprint is most like the section's,
 *      when at least MATCH alike;
 *   4. else it is a new section, with a new id.
 * None of these is a position, so adding or removing a section changes no
 * other section's lens.
 *
 * A lens no section continues is missing. It stays in its module, as it
 * was, until a run at least RETIRE_AFTER_MS after the first that missed it
 * still misses it (`missing_since` in the course file, by lens id): a Doc
 * edited by hand is often wrong for a few minutes. Then it is retired: its
 * lens and article go to the trash. One run retires at most MAX_RETIRED
 * lenses, and never every lens of a chapter, unless
 * ATLAS_SYNC_APPROVE_RETIREMENT is `retirementApproval` of the lenses it
 * would retire; a run that would do more retires none and logs that value.
 * An approval names those lenses, so an edit elsewhere in the Docs leaves it
 * standing.
 *
 * Lenses of a chapter the run does not have (not configured, or not read
 * this run) are left as they are.
 */

import { createHash } from "node:crypto";
import type { StructuralElement } from "../google-docs/docs-types";
import { MAX_RETIRED } from "../iliad/course-files";
import { fingerprint, fingerprintSimilarity, MATCH } from "../iliad/plan";
import type { Atom } from "../iliad/types";
import { sameChapter } from "./config";
import type { AtlasLens, ChapterFacts, ChapterSource, Section } from "./types";

export const RETIRE_AFTER_MS = 60 * 60_000;
/**
 * A lens's stored fingerprint is kept while the section is this alike to
 * it, so that a small edit rewrites the article and not the lens too. Below
 * it (or when the lens is rewritten anyway) the fingerprint is renewed, so
 * that many small edits never take a section out of reach of rule 3.
 */
const KEEP_PRINT = 0.85;

/** All the text of some Docs elements, in tables too, one paragraph a line. */
function textOf(elements: StructuralElement[]): string {
  return elements
    .map((el) => (el.paragraph ? (el.paragraph.elements ?? []).map((pe) => pe.textRun?.content ?? "").join("") : textOf((el.table?.tableRows ?? []).flatMap((row) => (row.tableCells ?? []).flatMap((cell) => cell.content ?? [])))))
    .join("\n");
}

/** A section's fingerprint (iliad/plan.ts): its text without its title, so that a renamed section is as alike as before. */
export function sectionFingerprint(section: Section): string {
  const atom: Atom = { anchor: section.slug, level: 2, title: section.title, words: section.words, parts: [{ kind: "text", markdown: textOf(section.content) }], links: [] };
  return fingerprint([atom], [atom]);
}

/** The fingerprint a lens file stores: its old one while the section is still like it, else the section's own. */
export const printToStore = (stored: string, fresh: string): string => (stored && fingerprintSimilarity(stored, fresh) >= KEEP_PRINT ? stored : fresh);

/** One chapter of the run that was read and split. */
export interface AtlasChapter {
  source: ChapterSource;
  facts: ChapterFacts;
  sections: Section[];
}

export interface PlannedSection {
  section: Section;
  /** "<chapter slug>#<section slug>": its address, written as `upstream_key`. */
  key: string;
  id: string;
  /** The lens it continues, or null for a new section. */
  pin: AtlasLens | null;
  fingerprint: string;
}

export interface AtlasPlan {
  /** The chapters given, in order, each with its sections and its missing lenses that stay for now. */
  chapters: { chapter: AtlasChapter; sections: PlannedSection[]; waiting: AtlasLens[] }[];
  retired: { pin: AtlasLens; reason: string }[];
  /** How many lenses due to be retired wait for a person's approval, and the value that approves them. */
  held: number;
  approval: string;
  /** `missing_since` after the run, by lens id. */
  missingSince: Map<string, string>;
  warnings: string[];
}

export interface PlanOptions {
  now: Date;
  /** ATLAS_SYNC_APPROVE_RETIREMENT: the `retirementApproval` of the lenses a person approved retiring. */
  approvedRetirement?: string;
  newId: () => string;
}

/** The value of ATLAS_SYNC_APPROVE_RETIREMENT that approves retiring these lenses, and only these. */
export const retirementApproval = (ids: string[]): string => createHash("sha256").update([...ids].sort().join("\n")).digest("hex").slice(0, 12);

/** Whether a lens belongs to a chapter: by its key, or by its Doc tab when the chapter was renamed. */
const ofChapter = (pin: AtlasLens, chapter: Pick<AtlasChapter, "facts" | "source">): boolean =>
  pin.key.slice(0, pin.key.indexOf("#")) === chapter.facts.slug || sameChapter(pin.url, chapter.source.url);

export function planAtlas(chapters: AtlasChapter[], state: { pins: AtlasLens[]; missingSince: Map<string, string> }, options: PlanOptions): AtlasPlan {
  const warnings: string[] = [];
  const used = new Set<AtlasLens>();
  const headings = chapters.flatMap((c) => c.sections.flatMap((s) => s.headingId ?? []));
  const shared = new Set(headings.filter((id, i) => headings.indexOf(id) !== i));
  const planned = chapters.map((chapter) => {
    const sections = chapter.sections.map((section): PlannedSection => ({ section, key: `${chapter.facts.slug}#${section.slug}`, id: "", pin: null, fingerprint: sectionFingerprint(section) }));
    const take = (s: PlannedSection, pin: AtlasLens) => {
      used.add(pin);
      s.pin = pin;
      s.id = pin.id;
    };
    const free = () => state.pins.filter((pin) => !used.has(pin) && ofChapter(pin, chapter));
    for (const s of sections) {
      const pin = s.section.headingId && !shared.has(s.section.headingId) ? free().find((p) => p.heading === s.section.headingId) : undefined;
      if (pin) take(s, pin);
    }
    for (const s of sections.filter((s) => !s.pin)) {
      const pins = free().filter((p) => p.key === s.key);
      if (pins.length === 1 && sections.filter((other) => other.key === s.key).length === 1) take(s, pins[0]);
    }
    const pairs = free().flatMap((pin) => sections.filter((s) => !s.pin).map((s) => ({ pin, s, like: fingerprintSimilarity(pin.fingerprint, s.fingerprint) })));
    for (const { pin, s } of pairs.filter((pair) => pair.like >= MATCH).sort((a, b) => b.like - a.like)) if (!used.has(pin) && !s.pin) take(s, pin);
    for (const s of sections) s.id ||= options.newId();
    return { chapter, sections };
  });

  // Each lens's chapter: the one a section of which continues it, else the first it belongs to.
  const home = new Map<AtlasLens, AtlasChapter>();
  for (const { chapter, sections } of planned) for (const s of sections) if (s.pin) home.set(s.pin, chapter);
  for (const pin of state.pins) {
    const chapter = home.has(pin) ? null : chapters.find((c) => ofChapter(pin, c));
    if (chapter) home.set(pin, chapter);
  }
  const missing = chapters.map((chapter) => {
    const all = state.pins.filter((pin) => home.get(pin) === chapter);
    return { chapter, all, gone: all.filter((pin) => !used.has(pin)) };
  });

  // Missing lenses: wait, or retire. A lens of a chapter the run does not have keeps its clock.
  const nowIso = options.now.toISOString();
  const missingSince = new Map<string, string>();
  for (const pin of state.pins) {
    const since = home.has(pin) ? undefined : state.missingSince.get(pin.id);
    if (since) missingSince.set(pin.id, since);
  }
  const due: { pin: AtlasLens; since: string; wholeChapter: boolean }[] = [];
  for (const { chapter, all, gone } of missing) {
    for (const pin of gone) {
      const recorded = state.missingSince.get(pin.id);
      const since = recorded && !Number.isNaN(Date.parse(recorded)) ? recorded : nowIso;
      if (options.now.getTime() - Date.parse(since) >= RETIRE_AFTER_MS) due.push({ pin, since, wholeChapter: gone.length === all.length });
      else {
        missingSince.set(pin.id, since);
        if (since === nowIso) {
          const at = new Date(Date.parse(since) + RETIRE_AFTER_MS).toISOString().slice(0, 16).replace("T", " ");
          warnings.push(`"${pin.title}" (${pin.lensPath}) is gone from Chapter ${chapter.facts.number}; it stays until a run from ${at} UTC still misses it, then it is retired.`);
        }
      }
    }
  }

  const retired: AtlasPlan["retired"] = [];
  const tooMany = due.length > MAX_RETIRED;
  const approval = retirementApproval(due.map(({ pin }) => pin.id));
  const held = due.length && (tooMany || due.some((d) => d.wholeChapter)) && options.approvedRetirement !== approval ? due.length : 0;
  if (held) {
    for (const { pin, since } of due) missingSince.set(pin.id, since);
    warnings.push(
      `${due.length} lens(es) are gone from the Docs for over an hour, and the sync retires ${tooMany ? `at most ${MAX_RETIRED} at once` : "no whole chapter"} by itself, so it retired none: ` +
        due.map(({ pin }) => `"${pin.title}" (${pin.lensPath})`).join(", ") +
        `. If the Docs lost the text by mistake, put it back; nothing else to do. If the loss is right, set ATLAS_SYNC_APPROVE_RETIREMENT=${approval} and restart the lens-editor container; that approves retiring these lenses and no others.`,
    );
  } else {
    for (const { pin, since } of due) retired.push({ pin, reason: `its section is gone from the Doc since ${since.slice(0, 16).replace("T", " ")} UTC` });
  }

  const retiredPins = new Set(retired.map(({ pin }) => pin));
  return {
    chapters: planned.map(({ chapter, sections }, i) => ({ chapter, sections, waiting: missing[i].gone.filter((pin) => !retiredPins.has(pin)) })),
    retired,
    held,
    approval,
    missingSince,
    warnings,
  };
}
