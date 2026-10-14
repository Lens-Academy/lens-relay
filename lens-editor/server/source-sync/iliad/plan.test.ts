import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { headingAnchor, uniqueAnchors } from "./anchor";
import { convertWorksheet } from "./convert";
import { adoptPin, fingerprint, fingerprintSimilarity, MATCH, planCourse, type CoursePlan, type ExistingLens } from "./plan";
import { type Atom, type Pin, type Worksheet } from "./types";

// ------------------------------------------------------- hand-built sheets

/** Made-up words. Two seeds give texts with no pair of words in common. */
function prose(seed: string, count = 60): string {
  const syllables = ["ka", "lo", "mi", "ne", "ru", "sa", "ti", "vo", "xe", "zu", "ba", "de", "fi", "go", "hu", "ja"];
  let state = [...seed].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261) >>> 0;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) >>> 8;
  return Array.from({ length: count }, () => [0, 1, 2].map(() => syllables[next() % 16]).join("")).join(" ");
}

/** An atom from its heading line ("" for text before the first heading), with a size in words. */
function atom(heading: string, words: number, text = prose(heading)): Atom {
  const title = heading.replace(/^#+ /, "");
  return {
    anchor: headingAnchor(title),
    level: (/^#+/.exec(heading)?.[0].length ?? 0) as Atom["level"],
    title,
    words,
    parts: [{ kind: "text", markdown: `${heading}\n\n${text}` }],
    links: [],
  };
}

/** An atom that starts at an exercise: no heading, and the exercise's id as its anchor. */
function exercise(id: string, words: number): Atom {
  return { anchor: id, level: 5, title: "", words, parts: [{ kind: "text", markdown: `:::callout {title="Exercise" tone="amber"}\n${prose(id)}\n:::` }], links: [] };
}

const sheet = (slug: string, ...atoms: Atom[]) => ({ slug, atoms });

/** Each lens of a worksheet as the titles of its atoms (an exercise has none: its id). */
const shape = (plan: CoursePlan, worksheet = 0) => plan.worksheets[worksheet].lenses.map((l) => l.atoms.map((a) => a.title || a.anchor || "(top)").join(" + "));

/** The pins a run writes: one per lens of its plan. */
const pinsOf = (plan: CoursePlan): Pin[] =>
  plan.worksheets.flatMap((w) => w.lenses.map((l) => ({ key: l.key, id: l.pinned?.id ?? `id of ${l.key}`, fingerprint: l.fingerprint })));

/** Pins for lenses that start at these anchors of a worksheet, as the run that made them writes them. */
const lensesAt = (worksheet: { slug: string; atoms: Atom[] }, ...anchors: string[]): Pin[] => {
  const starts = anchors.map((anchor) => worksheet.atoms.findIndex((a) => a.anchor === anchor));
  return starts.map((start, i) => ({
    key: `${worksheet.slug}#${anchors[i]}`,
    id: `id of ${worksheet.slug}#${anchors[i]}`,
    fingerprint: fingerprint(worksheet.atoms.slice(start, starts[i + 1] ?? worksheet.atoms.length), worksheet.atoms),
  }));
};

/** A pin with no fingerprint: all that is known of its lens is where it starts. */
const bare = (key: string, id = `id of ${key}`): Pin => ({ key, id, fingerprint: "" });

const retiredPins = (plan: CoursePlan) => plan.retired.map((r) => r.pin);

const ids = (plan: CoursePlan, worksheet = 0) => plan.worksheets[worksheet].lenses.map((l) => l.pinned?.id ?? null);

// ------------------------------------------------------------------ rule 6

describe("planCourse: a worksheet with no pins is packed by size", () => {
  it("starts a lens at an H2 when the lens so far and the section both have `min` words", () => {
    const plan = planCourse([sheet("s", atom("", 50), atom("## A", 300), atom("## B", 300), atom("## C", 100), atom("## D", 300))], []);
    // The opening text and the small section C each join what is before them.
    expect(shape(plan)).toEqual(["(top) + A", "B + C", "D"]);
    expect(plan.worksheets[0].lenses.map((l) => l.key)).toEqual(["s#", "s#b", "s#d"]);
    expect(plan.worksheets[0].lenses.every((l) => l.pinned === null)).toBe(true);
    expect(plan.retired).toEqual([]);
  });

  it("keeps an H2 with its H3 and H4 atoms as one section", () => {
    const plan = planCourse([sheet("s", atom("## A", 100), atom("### A1", 150), atom("#### A1a", 150), atom("## B", 90), atom("### B1", 150))], []);
    expect(shape(plan)).toEqual(["A + A1 + A1a", "B + B1"]);
  });

  it("starts a lens at a small section that would push the lens past `max`", () => {
    const plan = planCourse([sheet("s", atom("## A", 2900), atom("## B", 150), atom("## C", 100), atom("## D", 300))], []);
    expect(shape(plan)).toEqual(["A", "B + C", "D"]);
  });

  it("joins a last lens under `min` to the lens before it, past `max` if need be", () => {
    expect(shape(planCourse([sheet("s", atom("## A", 2900), atom("## B", 150))], []))).toEqual(["A + B"]);
  });

  it("cuts at an H3 only when staying would pass `max`", () => {
    const under = sheet("s", atom("## A", 300), atom("### A1", 1000), atom("### A2", 1000));
    expect(shape(planCourse([under], []))).toEqual(["A + A1 + A2"]);

    const over = sheet("s", atom("## A", 400), atom("### A1", 1500), atom("### A2", 1500), atom("### A3", 100));
    expect(shape(planCourse([over], []))).toEqual(["A + A1", "A2 + A3"]);
  });

  it("does not cut at an H3 that would leave under `min` on one side of its section", () => {
    // Before A1 the section has 100 words; from A2 on it has 100.
    const plan = planCourse([sheet("s", atom("## A", 100), atom("### A1", 2950), atom("### A2", 100))], []);
    expect(shape(plan)).toEqual(["A + A1 + A2"]);
  });

  it("cuts at an H4 only inside a section that alone exceeds `max`", () => {
    const alone = sheet("s", atom("## A", 100), atom("### A1", 200), atom("#### A1a", 1600), atom("#### A1b", 1600));
    expect(shape(planCourse([alone], []))).toEqual(["A + A1 + A1a", "A1b"]);

    // 3,050 words in the lens, and the section B has 2,900: the H4s stay.
    const withMore = sheet("s", atom("## A", 150), atom("## B", 100), atom("#### Ba", 1400), atom("#### Bb", 1400));
    expect(shape(planCourse([withMore], []))).toEqual(["A + B + Ba + Bb"]);
  });

  it("does not cut at an exercise where a heading or the size gives another way", () => {
    // An exercise does not end a section: A with its exercise has 250 words, so B starts a lens.
    expect(shape(planCourse([sheet("s", atom("## A", 150), exercise("ex-a", 100), atom("## B", 300))], []))).toEqual(["A + ex-a", "B"]);
    // 2,300 words are one lens.
    expect(shape(planCourse([sheet("s", atom("## A", 300), exercise("ex-first", 1000), exercise("ex-second", 1000))], []))).toEqual(["A + ex-first + ex-second"]);
    // Past `max`, the lens is cut at the H3 ...
    const withH3 = sheet("s", atom("## A", 1000), exercise("ex-first", 1500), atom("### A1", 1500), exercise("ex-second", 100));
    expect(shape(planCourse([withH3], []))).toEqual(["A + ex-first", "A1 + ex-second"]);
    // ... and at an H4 before an exercise.
    const withH4 = sheet("s", atom("## A", 100), exercise("ex-first", 1500), atom("#### A1", 200), exercise("ex-second", 1500));
    expect(shape(planCourse([withH4], []))).toEqual(["A + ex-first", "A1 + ex-second"]);
  });

  it("cuts at an exercise as the last resort, inside a section that alone exceeds `max`", () => {
    const long = sheet("s", atom("## A", 200), exercise("ex-first", 1600), exercise("ex-second", 1600), exercise("ex-third", 300));
    const plan = planCourse([long], []);
    expect(shape(plan)).toEqual(["A + ex-first", "ex-second + ex-third"]);
    // The new lens is keyed on the exercise's id.
    expect(plan.worksheets[0].lenses[1]).toMatchObject({ key: "s#ex-second", pinned: null });

    // Each side of the cut keeps `min` words, or there is no cut.
    const lopsided = sheet("s", atom("## A", 100), exercise("ex-first", 2950), exercise("ex-second", 100));
    expect(shape(planCourse([lopsided], []))).toEqual(["A + ex-first + ex-second"]);

    // The lens passes `max` because of A. The section B has 2,900 words: its exercises stay.
    const withMore = sheet("s", atom("## A", 150), atom("## B", 100), exercise("ex-first", 1400), exercise("ex-second", 1400));
    expect(shape(planCourse([withMore], []))).toEqual(["A + B + ex-first + ex-second"]);
  });

  it("cuts at the exercises of an H4 only when that H4 alone exceeds `max`", () => {
    const deep = sheet("s", atom("## A", 100), atom("#### A1", 300), exercise("ex-first", 1600), exercise("ex-second", 1600), atom("#### A2", 300), exercise("ex-third", 1600));
    // A2 is a heading to cut at; inside A1, which has 3,500 words, only an exercise is.
    expect(shape(planCourse([deep], []))).toEqual(["A + A1 + ex-first", "ex-second", "A2 + ex-third"]);
  });

  it("plans a worksheet that has no atoms, and one that is a single atom", () => {
    const plan = planCourse([sheet("empty"), sheet("one", atom("", 40))], []);
    expect(plan.worksheets).toEqual([
      { slug: "empty", lenses: [] },
      { slug: "one", lenses: [expect.objectContaining({ key: "one#", pinned: null })] },
    ]);
  });
});

// ------------------------------------------------------------ rules 1 to 5

describe("planCourse: pins", () => {
  const before = sheet("s", atom("## A", 300), atom("## B", 50), atom("## C", 2000), atom("### C1", 2000), atom("## D", 300));
  /** A pin for a lens of these atoms, in a worksheet where no other atom has the name of its first. */
  const pin = (key: string, atoms: Atom[] = []): Pin => ({ key, id: `id of ${key}`, fingerprint: fingerprint(atoms, atoms) });

  it("starts a lens at a pin's anchor whatever the sizes say", () => {
    // B alone is under `min`; C with C1 is over `max` and C1 could be cut off. Both are lenses that exist.
    const pins = [pin("s#b", [before.atoms[1]]), pin("s#c", before.atoms.slice(2, 4)), pin("s#d", [before.atoms[4]])];
    const plan = planCourse([before], pins);
    expect(shape(plan)).toEqual(["A", "B", "C + C1", "D"]);
    expect(plan.worksheets[0].lenses.map((l) => l.pinned)).toEqual([null, pins[0], pins[1], pins[2]]);
    expect(plan.worksheets[0].lenses.map((l) => l.key)).toEqual(["s#a", "s#b", "s#c", "s#d"]);
  });

  it("covers every atom once, in order", () => {
    const pins = [pin("s#c", before.atoms.slice(2, 4))];
    for (const plan of [planCourse([before], []), planCourse([before], pins)]) {
      expect(plan.worksheets[0].lenses.flatMap((l) => l.atoms)).toEqual(before.atoms);
      expect(plan.worksheets[0].lenses.every((l) => l.atoms.length > 0 && l.key === `s#${l.atoms[0].anchor}`)).toBe(true);
    }
  });

  it("makes a new section a lens of its own, up to the next pin and after the last one", () => {
    const first = planCourse([sheet("s", atom("## A", 300), atom("## B", 300))], []);
    expect(shape(first)).toEqual(["A", "B"]);

    const grown = sheet("s", atom("## A", 300), atom("### A new", 200), atom("## X", 500), atom("## B", 300), atom("## Y", 900));
    const plan = planCourse([grown], pinsOf(first));
    // The new atoms from "A new" on are packed like a worksheet of their own.
    expect(shape(plan)).toEqual(["A", "A new", "X", "B", "Y"]);
    expect(ids(plan)).toEqual(["id of s#a", null, null, "id of s#b", null]);
    // And the next run keeps them.
    expect(shape(planCourse([grown], pinsOf(plan)))).toEqual(shape(plan));
  });

  it("lets a pinned lens take in new material with no heading of its own, or too little for a lens", () => {
    // As in A.1, where each session is a lens: a new session of 321 words is a lens, one of 150 is not.
    const sessions = [atom("## Sessions", 50), atom("### Session 5", 400), atom("### Session 6", 400), atom("### Closing", 20), atom("## Reading guide", 600)];
    const first = planCourse([sheet("a1", ...sessions)], lensesAt(sheet("a1", ...sessions), "sessions", "session-5", "session-6", "reading-guide"));
    const written = pinsOf(first);
    expect(shape(first)).toEqual(["Sessions", "Session 5", "Session 6 + Closing", "Reading guide"]);

    const seventh = planCourse([sheet("a1", ...sessions.slice(0, 3), atom("### Session 7", 321), ...sessions.slice(3))], written);
    // The pinned lens of Session 6 ends where Session 7 starts; the closing words follow Session 7.
    expect(shape(seventh)).toEqual(["Sessions", "Session 5", "Session 6", "Session 7 + Closing", "Reading guide"]);
    expect(ids(seventh)).toEqual([written[0].id, written[1].id, written[2].id, null, written[3].id]);

    const short = planCourse([sheet("a1", ...sessions.slice(0, 3), atom("### Session 7", 150), ...sessions.slice(3))], written);
    expect(shape(short)).toEqual(["Sessions", "Session 5", "Session 6 + Session 7 + Closing", "Reading guide"]);
    // Without a heading of its own (an H4, an exercise), the new material joins the lens before it.
    const noHeading = planCourse([sheet("a1", ...sessions.slice(0, 3), atom("#### A worked example", 400), exercise("ex-session-6", 300), ...sessions.slice(3))], written);
    expect(shape(noHeading)).toEqual(["Sessions", "Session 5", "Session 6 + A worked example + ex-session-6 + Closing", "Reading guide"]);
  });

  it("cuts new lenses at new atoms only, when a pinned lens would pass `max`", () => {
    const first = planCourse([sheet("s", atom("## A", 1500), atom("### A1", 1400), atom("## B", 300))], []);
    expect(shape(first)).toEqual(["A + A1", "B"]);

    const grown = sheet("s", atom("## A", 1500), atom("### A1", 1400), atom("## X", 400), atom("## Y", 100), atom("## B", 300));
    const plan = planCourse([grown], pinsOf(first));
    expect(shape(plan)).toEqual(["A + A1", "X + Y", "B"]);
    expect(ids(plan)).toEqual(["id of s#a", null, "id of s#b"]);
  });

  it("never cuts a pinned lens at an atom it already held", () => {
    // 4,000 words since the hand import, with an H3 a size rule would cut at.
    const pins = [pin("s#c", before.atoms.slice(2, 4)), pin("s#d", [before.atoms[4]])];
    const grown = { slug: "s", atoms: [...before.atoms.slice(2, 4), atom("### C2", 100), before.atoms[4]] };
    const plan = planCourse([grown], pins);
    // C2 is new and under `min`: it cannot stand alone, so the lens grows.
    expect(shape(plan)).toEqual(["C + C1 + C2", "D"]);
  });

  it("cuts a new section out of the middle of a pinned lens that would pass `max`", () => {
    const first = planCourse([sheet("s", atom("## A", 1000), atom("## B", 150), atom("## C", 2000))], [pin("s#a"), pin("s#c")]);
    expect(shape(first)).toEqual(["A + B", "C"]);
    const grown = sheet("s", atom("## A", 1000), atom("## X", 2500), atom("## B", 150), atom("## C", 2000));
    // B was in the lens of A. It now follows X, because a lens is one run of atoms.
    expect(shape(planCourse([grown], pinsOf(first)))).toEqual(["A", "X + B", "C"]);
  });

  it("joins less than `min` words before the first pin to the first pinned lens", () => {
    const video = atom("", 11, '<YouTube id="FaXazOpzLvQ" title="When Bad Goals ALSO Fit Your Training Data" />');
    const pins = [pin("s#prerequisites"), pin("s#content")];
    const plan = planCourse([sheet("s", video, atom("## Prerequisites", 125), atom("## Content", 700))], pins);
    expect(shape(plan)).toEqual(["(top) + Prerequisites", "Content"]);
    // The lens keeps its pin and is now keyed on its new first atom.
    expect(plan.worksheets[0].lenses[0]).toMatchObject({ key: "s#", pinned: pins[0] });
    expect(plan.retired).toEqual([]);
  });

  it("packs `min` words or more before the first pin into new lenses", () => {
    const pins = [pin("s#content")];
    const plan = planCourse([sheet("s", atom("", 150), atom("## Intro", 400), atom("## Setup", 500), atom("## Content", 700))], pins);
    expect(shape(plan)).toEqual(["(top) + Intro", "Setup", "Content"]);
    expect(ids(plan)).toEqual([null, null, "id of s#content"]);
  });

  it("starts a pinned lens at an exercise, and new atoms join it as they join any lens", () => {
    const atoms = [atom("## A", 300), exercise("ex-warm-up", 400), exercise("ex-main", 400), atom("## B", 300)];
    const pins = [pin("s#a", [atoms[0]]), pin("s#ex-warm-up", atoms.slice(1, 3)), pin("s#b", [atoms[3]])];
    expect(shape(planCourse([sheet("s", ...atoms)], pins))).toEqual(["A", "ex-warm-up + ex-main", "B"]);

    const grown = sheet("s", atoms[0], exercise("ex-new", 200), atoms[1], atoms[2], atom("### More", 200), exercise("ex-extra", 200), atoms[3]);
    const plan = planCourse([grown], pins);
    // A new exercise joins the lens before it; the new section "More" is a lens, with its exercise.
    expect(shape(plan)).toEqual(["A + ex-new", "ex-warm-up + ex-main", "More + ex-extra", "B"]);
    expect(ids(plan)).toEqual(["id of s#a", "id of s#ex-warm-up", null, "id of s#b"]);
  });

  it("retires a pin whose section is gone, and the other lenses stay", () => {
    const first = planCourse([sheet("s", atom("## A", 300), atom("## B", 300), atom("## C", 300))], []);
    const pins = pinsOf(first);
    const plan = planCourse([sheet("s", atom("## A", 300), atom("## C", 300))], pins);
    expect(shape(plan)).toEqual(["A", "C"]);
    expect(plan.retired).toEqual([{ pin: pins[1], reason: 'its text is not in the source any more (its section "b" is gone from "s")' }]);
  });

  it("keeps the first of two pins with one key, and the second does not take the rest of the lens", () => {
    const atoms = [atom("## A", 300), atom("### A1", 300)];
    const pins = [pin("s#a", atoms), { ...pin("s#a", atoms), id: "a copy" }];
    const plan = planCourse([sheet("s", ...atoms)], pins);
    expect(shape(plan)).toEqual(["A + A1"]);
    expect(ids(plan)).toEqual(["id of s#a"]);
    expect(plan.retired).toEqual([{ pin: pins[1], reason: 'another lens already starts at its section "a"' }]);
  });
});

// -------------------------------------------------------------- 0 words

describe("planCourse: an atom a learner sees nothing of (0 words)", () => {
  const timetable = atom("## Roadmap for today", 0);
  const notes = atom("## Notes for facilitators", 0);
  const pin = (key: string, id: string): Pin => ({ key, id, fingerprint: "" });

  it("is never a lens of its own in a worksheet with no pins", () => {
    const plan = planCourse([sheet("s", timetable, atom("## A", 300), atom("## B", 300), notes)], []);
    expect(shape(plan)).toEqual(["Roadmap for today + A", "B + Notes for facilitators"]);
    // After a lens that is past `max` it would start a lens: alone at the end it joins that lens, ...
    expect(shape(planCourse([sheet("s", atom("## A", 3100), notes)], []))).toEqual(["A + Notes for facilitators"]);
    // ... and with a section after it, it starts the lens of that section.
    expect(shape(planCourse([sheet("s", atom("## A", 3100), timetable, atom("## B", 300))], []))).toEqual(["A", "Roadmap for today + B"]);
  });

  it("retires a pin whose lens would be hidden atoms only: at the start, in the middle, at the end", () => {
    const course = [sheet("s", timetable, atom("## A", 300), atom("## Schedule", 0), atom("## B", 300), notes)];
    const pins = [pin("s#roadmap-for-today", "T"), pin("s#a", "A"), pin("s#schedule", "S"), pin("s#b", "B"), pin("s#notes-for-facilitators", "N")];
    const plan = planCourse(course, pins);

    expect(shape(plan)).toEqual(["Roadmap for today + A + Schedule", "B + Notes for facilitators"]);
    expect(plan.worksheets[0].lenses.map((l) => [l.key, l.pinned?.id])).toEqual([
      ["s#roadmap-for-today", "A"],
      ["s#b", "B"],
    ]);
    expect(plan.retired.map((r) => r.pin.id)).toEqual(["T", "S", "N"]);
    expect(new Set(plan.retired.map((r) => r.reason))).toEqual(new Set(["all that is left of it in the source is hidden from learners"]));
    expect(shape(planCourse(course, pinsOf(plan)))).toEqual(shape(plan));
  });

  it("keeps a pin on a hidden atom when its lens has more than hidden atoms", () => {
    const plan = planCourse([sheet("s", timetable, atom("### Session 1", 300), atom("## B", 300))], [pin("s#roadmap-for-today", "T"), pin("s#b", "B")]);
    expect(shape(plan)).toEqual(["Roadmap for today + Session 1", "B"]);
    expect(ids(plan)).toEqual(["T", "B"]);
  });

  it("gives a worksheet that is all hidden no lens", () => {
    const plan = planCourse([sheet("s", timetable, notes), sheet("t", atom("## A", 300))], [pin("s#roadmap-for-today", "T")]);
    expect(plan.worksheets[0]).toEqual({ slug: "s", lenses: [] });
    expect(shape(plan, 1)).toEqual(["A"]);
    expect(plan.retired.map((r) => r.pin.id)).toEqual(["T"]);
  });
});

// ------------------------------------------------------------------ rule 7

describe("planCourse: planning its own output again changes nothing", () => {
  const course = [
    sheet("small", atom("", 20), atom("## A", 90), atom("## B", 80)),
    sheet("plain", atom("", 50), atom("## A", 300), atom("## B", 300), atom("## C", 100), atom("## D", 300)),
    sheet("deep", atom("## A", 400), atom("### A1", 1500), atom("### A2", 1500), atom("### A3", 100), atom("## B", 3500), atom("## C", 150)),
    sheet("h4", atom("## A", 100), atom("### A1", 200), atom("#### A1a", 1600), atom("#### A1b", 1600), atom("## Exercises", 250), atom("## Exercises", 250)),
  ];
  course[3].atoms[5].anchor = "exercises-1";

  const same = (a: CoursePlan, b: CoursePlan) => expect(b.worksheets.map((w) => w.lenses.map((l) => [l.key, l.atoms]))).toEqual(a.worksheets.map((w) => w.lenses.map((l) => [l.key, l.atoms])));

  it("from no pins", () => {
    const first = planCourse(course, []);
    const again = planCourse(course, pinsOf(first));
    same(first, again);
    expect(again.retired).toEqual([]);
    expect(again.worksheets.flatMap((w) => w.lenses).every((l) => l.pinned !== null)).toBe(true);
  });

  it("from pins that the size rule would not have set", () => {
    const pins: Pin[] = ["plain#c", "deep#a1", "deep#a3", "h4#a1a"].map((key) => ({ key, id: `id of ${key}`, fingerprint: "" }));
    const first = planCourse(course, pins);
    expect(shape(first, 1)).toEqual(["(top) + A", "B", "C + D"]);
    expect(shape(first, 2)).toEqual(["A", "A1 + A2", "A3 + B + C"]);
    same(first, planCourse(course, pinsOf(first)));
  });

  it("is the same plan each time", () => {
    expect(planCourse(course, [])).toEqual(planCourse(course, []));
  });
});

// ------------------------------------------------------------------ rule 3

describe("planCourse: a pin whose anchor is gone", () => {
  const overview = atom("## Overview", 300);
  const mixture = atom("## The mixture is a predictor", 400);
  const bounds = atom("### Error bounds", 300);
  const reading = atom("## Further reading", 300);
  const course = [sheet("solomonoff", overview, mixture, bounds, reading), sheet("aixi", atom("## Setup", 500), atom("## Value functions", 500))];
  const pins = pinsOf(planCourse(course, []));
  const mixturePin = pins[1];

  /** The same atom under another heading: Iliad renamed the section. */
  const renamed = (a: Atom, heading: string): Atom => ({ ...atom(heading, a.words), parts: [{ kind: "text", markdown: textOf(a).replace(/^.*$/m, heading) }] });

  it("is found again by its text when the heading was renamed", () => {
    expect(mixturePin.key).toBe("solomonoff#the-mixture-is-a-predictor");
    const now = [sheet("solomonoff", overview, renamed(mixture, "## 1. Properties of the Bayesian mixture"), bounds, reading), course[1]];
    const plan = planCourse(now, pins);

    expect(shape(plan)).toEqual(["Overview", "1. Properties of the Bayesian mixture + Error bounds", "Further reading"]);
    expect(plan.worksheets[0].lenses[1]).toMatchObject({ key: "solomonoff#1-properties-of-the-bayesian-mixture", pinned: mixturePin });
    expect(plan.retired).toEqual([]);
  });

  it("is found again in another worksheet when the section moved there", () => {
    const now = [sheet("solomonoff", overview, reading), sheet("aixi", ...course[1].atoms, mixture, bounds)];
    const plan = planCourse(now, pins);

    expect(shape(plan, 0)).toEqual(["Overview", "Further reading"]);
    expect(shape(plan, 1)).toEqual(["Setup", "Value functions", "The mixture is a predictor + Error bounds"]);
    expect(plan.worksheets[1].lenses[2]).toMatchObject({ key: "aixi#the-mixture-is-a-predictor", pinned: mixturePin });
    expect(plan.retired).toEqual([]);
  });

  it("is found again when its worksheet was renamed", () => {
    const plan = planCourse([{ ...course[0], slug: "solomonoff-induction" }, course[1]], pins);
    expect(ids(plan, 0)).toEqual(pins.slice(0, 3).map((p) => p.id));
    expect(plan.worksheets[0].lenses.map((l) => l.key)).toEqual([
      "solomonoff-induction#overview",
      "solomonoff-induction#the-mixture-is-a-predictor",
      "solomonoff-induction#further-reading",
    ]);
    expect(plan.retired).toEqual([]);
  });

  it("is found again after a small edit to the renamed section", () => {
    const edited = renamed(mixture, "## The Bayesian mixture");
    const text = prose("## The mixture is a predictor").split(" ");
    text.splice(20, 3, "one", "new", "sentence", "here");
    edited.parts = [{ kind: "text", markdown: `## The Bayesian mixture\n\n${text.join(" ")}` }];
    const plan = planCourse([sheet("solomonoff", overview, edited, bounds, reading), course[1]], pins);
    expect(plan.worksheets[0].lenses[1].pinned).toBe(mixturePin);
  });

  it("is retired when the section was renamed and rewritten, and nothing of the lens is left", () => {
    const readingPin = pins[2];
    const plan = planCourse([sheet("solomonoff", overview, mixture, bounds, atom("## Sources", 300)), course[1]], pins);
    expect(plan.retired).toEqual([{ pin: readingPin, reason: 'its text is not in the source any more (its section "further-reading" is gone from "solomonoff")' }]);
    // "Sources" is a new section: a lens of its own.
    expect(shape(plan)).toEqual(["Overview", "The mixture is a predictor + Error bounds", "Sources"]);
    expect(ids(plan)).toEqual([pins[0].id, mixturePin.id, null]);
  });

  it("takes the place between its neighbouring lenses when its text is in two places", () => {
    // As A.3's "AI control", renamed, with a section 0.91 like it in A.2.
    const readingPin = pins[2];
    const here = renamed(reading, "## Sources");
    const there = renamed(reading, "## Sources and more");
    const plan = planCourse([sheet("solomonoff", overview, mixture, bounds, here), sheet("aixi", ...course[1].atoms, there)], pins);
    expect(plan.retired).toEqual([]);
    expect(plan.worksheets[0].lenses[2]).toMatchObject({ key: "solomonoff#sources", pinned: readingPin });
    // The copy in the other worksheet is a lens of its own.
    expect(shape(plan, 1)).toEqual(["Setup", "Value functions", "Sources and more"]);
  });

  it("is retired when its text is in two places and not one of them is between its neighbouring lenses", () => {
    const readingPin = pins[2];
    // Its worksheet was renamed, and the text is in two other worksheets.
    const now = [sheet("solomonoff-induction", overview, mixture, bounds), sheet("aixi", ...course[1].atoms, renamed(reading, "## Sources")), sheet("aixi-2", renamed(reading, "## Sources, again"))];
    expect(planCourse(now, pins).retired.filter((r) => r.pin === readingPin)).toEqual([
      { pin: readingPin, reason: 'its text is in 2 places of the source, and nothing says which of them is the lens (its worksheet "solomonoff" is gone from the source)' },
    ]);
    // Two copies, both between its neighbours: no telling which.
    const twice = [sheet("solomonoff", overview, mixture, bounds, renamed(reading, "## Sources"), renamed(reading, "## Sources, again")), course[1]];
    expect(planCourse(twice, pins).retired.map((r) => r.reason)).toEqual([
      'its text is in 2 places of the source, and nothing says which of them is the lens (its section "further-reading" is gone from "solomonoff")',
    ]);
  });

  it("is found by an atom it held that is still there, when its text is in two places", () => {
    // The lens was "The mixture is a predictor" with "Error bounds". Both are in "aixi" too, under other headings.
    const copy = [renamed(mixture, "## The mixture, again"), renamed(bounds, "### Error bounds, again")];
    const now = [sheet("solomonoff", overview, renamed(mixture, "## The mixture"), bounds, reading), sheet("aixi", ...course[1].atoms, ...copy)];
    const plan = planCourse(now, pins);
    // "Error bounds" is where it was, and the section before it is text of the lens: the lens starts there.
    expect(shape(plan, 0)).toEqual(["Overview", "The mixture + Error bounds", "Further reading"]);
    expect(plan.worksheets[0].lenses[1]).toMatchObject({ key: "solomonoff#the-mixture", pinned: mixturePin });
    expect(plan.retired).toEqual([]);
  });

  it("is retired when the lens had too little text to know it by", () => {
    const stub = atom("## Slides", 6, "See the slides.");
    const first = planCourse([sheet("s", atom("## A", 300)), sheet("t", stub)], []);
    const plan = planCourse([sheet("s", atom("## A", 300)), sheet("t", { ...stub, anchor: "deck", title: "Deck" })], pinsOf(first));
    expect(plan.retired).toEqual([{ pin: expect.objectContaining({ key: "t#slides" }), reason: 'it has too little text to be found by (its section "slides" is gone from "t")' }]);
  });

  it("does not take a place where a lens already starts", () => {
    // The section now in "aixi" is the text of the lost pin, and a pin of that worksheet starts there.
    const taken = bare("aixi#the-mixture-is-a-predictor", "another lens");
    const now = [sheet("solomonoff", overview, reading), sheet("aixi", ...course[1].atoms, mixture, bounds)];
    const plan = planCourse(now, [...pins, taken]);
    expect(plan.worksheets[1].lenses[2].pinned).toBe(taken);
    expect(retiredPins(plan)).toEqual([mixturePin]);
  });
});

describe("planCourse: several sections with one heading", () => {
  // The site names them "exercises", "exercises-1", ... by position.
  const named = (a: Atom, anchor: string): Atom => ({ ...a, anchor });
  const first = atom("### Exercises", 300, prose("exercises of part one"));
  const second = atom("### Exercises", 300, prose("exercises of part two"));
  const course = [sheet("s", atom("## Part one", 300), first, atom("## Part two", 300), named(second, "exercises-1"))];
  const print = (...atoms: Atom[]) => fingerprint(atoms, course[0].atoms);
  const pins: Pin[] = [
    { key: "s#part-one", id: "one", fingerprint: print(course[0].atoms[0]) },
    { key: "s#exercises", id: "exercises one", fingerprint: print(first) },
    { key: "s#part-two", id: "two", fingerprint: print(course[0].atoms[2]) },
    { key: "s#exercises-1", id: "exercises two", fingerprint: print(second) },
  ];

  it("keeps each pin on its own section", () => {
    expect(ids(planCourse(course, pins))).toEqual(["one", "exercises one", "two", "exercises two"]);
  });

  it("keeps a pin on its section when a new namesake higher up shifts the anchors", () => {
    const warmUp = atom("### Exercises", 250, prose("warm-up exercises"));
    const now = [sheet("s", warmUp, atom("## Part one", 300), named(first, "exercises-1"), atom("## Part two", 300), named(second, "exercises-2"))];
    const plan = planCourse(now, pins);
    // "s#exercises" is now the warm-up, which no learner has done.
    expect(plan.worksheets[0].lenses.map((l) => [l.key, l.pinned?.id ?? null])).toEqual([
      ["s#exercises", null],
      ["s#part-one", "one"],
      ["s#exercises-1", "exercises one"],
      ["s#part-two", "two"],
      ["s#exercises-2", "exercises two"],
    ]);
    expect(plan.retired).toEqual([]);
  });

  it("moves a pin up when the namesake above it is removed", () => {
    // What was "exercises-1" is now "exercises", the anchor of the pin whose section is gone.
    const now = [sheet("s", atom("## Part one", 300), atom("## Part two", 300), named(second, "exercises"))];
    const plan = planCourse(now, pins);
    expect(plan.worksheets[0].lenses.map((l) => [l.key, l.pinned?.id ?? null])).toEqual([
      ["s#part-one", "one"],
      ["s#part-two", "two"],
      ["s#exercises", "exercises two"],
    ]);
    expect(plan.retired).toEqual([
      {
        pin: pins[1],
        reason: 'its text is not in the source any more ("s" has 1 section(s) named like "exercises" and had 2, so the anchor alone cannot say which is the lens)',
      },
    ]);
  });

  it("keeps each pin on its own anchor when the namesakes have the same text", () => {
    const same = [sheet("s", atom("## Part one", 300), atom("### Exercises", 300), atom("## Part two", 300), named(atom("### Exercises", 300), "exercises-1"))];
    const plan = planCourse(same, pinsOf(planCourse(same, [])));
    expect(plan.retired).toEqual([]);
    expect(shape(planCourse(same, pinsOf(plan)))).toEqual(shape(plan));
  });

  it("does not place a pin with no fingerprint by an anchor the worksheet has several times", () => {
    const unknown = pins.map((p) => ({ ...p, fingerprint: "" }));
    const plan = planCourse(course, unknown);
    expect(ids(plan)).toEqual(["one", "two"]);
    expect(plan.retired.map((r) => r.reason)).toEqual([
      'it has no fingerprint to be found by ("s" has 2 section(s) named like "exercises" and had 0, so the anchor alone cannot say which is the lens)',
      'it has no fingerprint to be found by ("s" has 2 section(s) named like "exercises-1" and had 0, so the anchor alone cannot say which is the lens)',
    ]);
  });
});

describe("planCourse: a pin on the first of two sections with one heading, the second inside another lens", () => {
  // As in A.2: "Post-training" is a section of the day, and again a heading of the reading list at the end.
  const postTraining = atom("### Post-training", 2650, prose("post-training at length", 300));
  const inList = { ...atom("### Post-training", 200, prose("what to read on post-training", 80)), anchor: "post-training-1" };
  const rest = { pretraining: atom("## Pretraining", 600), deployment: atom("### Deployment", 2800), reading: atom("## Further reading", 300), monitoring: atom("### Monitoring", 300) };
  const before = [sheet("a2", rest.pretraining, postTraining, rest.deployment, rest.reading, inList, rest.monitoring)];
  // The lenses as a first run leaves them: the reading list is one lens.
  const written = lensesAt(before[0], "pretraining", "post-training", "deployment", "further-reading");
  const [, postTrainingPin] = written;
  /** With the first "Post-training" renamed or gone, the site gives the second one its anchor. */
  const shifted = { ...inList, anchor: "post-training" };

  it("starts from the lenses of the first run", () => {
    expect(shape(planCourse(before, written))).toEqual(["Pretraining", "Post-training", "Deployment", "Further reading + Post-training + Monitoring"]);
    expect(postTrainingPin.key).toBe("a2#post-training");
  });

  it("follows its section when Iliad renames it, and does not move to the namesake that now has its anchor", () => {
    const renamed: Atom = { ...postTraining, anchor: "post-training-and-evaluation", title: "Post-training and evaluation" };
    const plan = planCourse([sheet("a2", rest.pretraining, renamed, rest.deployment, rest.reading, shifted, rest.monitoring)], written);

    expect(shape(plan)).toEqual(["Pretraining", "Post-training and evaluation", "Deployment", "Further reading + Post-training + Monitoring"]);
    expect(plan.worksheets[0].lenses[1]).toMatchObject({ key: "a2#post-training-and-evaluation", pinned: postTrainingPin });
    expect(ids(plan)).toEqual(written.map((p) => p.id));
    expect(plan.retired).toEqual([]);
  });

  it("is retired when Iliad deletes its section, and the namesake stays in its own lens", () => {
    const plan = planCourse([sheet("a2", rest.pretraining, rest.deployment, rest.reading, shifted, rest.monitoring)], written);

    expect(shape(plan)).toEqual(["Pretraining", "Deployment", "Further reading + Post-training + Monitoring"]);
    expect(ids(plan)).toEqual([written[0].id, written[2].id, written[3].id]);
    expect(plan.retired).toEqual([
      {
        pin: postTrainingPin,
        reason: 'its text is not in the source any more ("a2" has 1 section(s) named like "post-training" and had 2, so the anchor alone cannot say which is the lens)',
      },
    ]);
  });

  it("is retired when its section is rewritten whole: with namesakes, only the text can place a lens", () => {
    const rewritten = atom("### Post-training", 2700, prose("post-training, written anew", 300));
    const plan = planCourse([sheet("a2", rest.pretraining, rewritten, rest.deployment, rest.reading, inList, rest.monitoring)], written);
    expect(plan.retired).toEqual([
      {
        pin: postTrainingPin,
        reason: 'its text is not in the source any more ("a2" has 2 section(s) named like "post-training" and had 2, so the anchor alone cannot say which is the lens)',
      },
    ]);
    // The section of that name in the reading list stays in its own lens.
    expect(plan.worksheets[0].lenses.find((l) => l.pinned === written[3])!.atoms).toEqual([rest.reading, inList, rest.monitoring]);
  });

  it("keeps the id with its own text, or retires it, when Iliad deletes its section and adds a new one of that name", () => {
    // As in the review: the count of "Post-training" sections stays 2, with other text under the anchor.
    const fresh = atom("### Post-training", 220, prose("a new subsection about evaluation pipelines", 120));
    for (const now of [
      [rest.pretraining, rest.deployment, rest.reading, { ...inList, anchor: "post-training" }, { ...fresh, anchor: "post-training-1" }, rest.monitoring],
      [rest.pretraining, rest.deployment, { ...fresh, anchor: "post-training" }, rest.reading, inList, rest.monitoring],
    ]) {
      const plan = planCourse([sheet("a2", ...now)], written);
      expect(plan.retired.map((r) => r.pin)).toEqual([postTrainingPin]);
      expect(plan.worksheets[0].lenses.find((l) => l.pinned === written[3])!.atoms).toContain(now.find((a) => a.title === "Post-training" && a.words === 200));
    }
  });
});

describe("planCourse: a lens whose first atom is gone", () => {
  const prerequisites = atom("## Prerequisites", 400, prose("prerequisites", 200));
  const fastTrack = atom("## Fast-track", 60, prose("the fast track", 60));
  const guide = atom("## Reading guide", 120, prose("the reading guide", 120));
  const lecture = atom("## Lecture notes", 1700);
  const before = [sheet("a3", prerequisites, fastTrack, guide, lecture)];
  const written = pinsOf(planCourse(before, [bare("a3#prerequisites", "overview"), bare("a3#lecture-notes", "lecture")]));

  it("starts from an overview lens of three sections", () => {
    expect(shape(planCourse(before, written))).toEqual(["Prerequisites + Fast-track + Reading guide", "Lecture notes"]);
  });

  it("goes on at the first atom it held that is still there", () => {
    // 400 of its 580 words are gone: too few are left for the lens to be found by its text as a whole.
    const plan = planCourse([sheet("a3", fastTrack, guide, lecture)], written);
    expect(shape(plan)).toEqual(["Fast-track + Reading guide", "Lecture notes"]);
    expect(plan.worksheets[0].lenses[0]).toMatchObject({ key: "a3#fast-track", pinned: written[0] });
    expect(ids(plan)).toEqual(["overview", "lecture"]);
    expect(plan.retired).toEqual([]);
    // And it is the same plan from its own output.
    expect(shape(planCourse([sheet("a3", fastTrack, guide, lecture)], pinsOf(plan)))).toEqual(shape(plan));
  });

  it("goes on at a later atom when the one after the first is gone too", () => {
    const plan = planCourse([sheet("a3", guide, lecture)], written);
    expect(plan.worksheets[0].lenses.map((l) => [l.key, l.pinned?.id])).toEqual([
      ["a3#reading-guide", "overview"],
      ["a3#lecture-notes", "lecture"],
    ]);
  });

  it("takes a new section before what is left as new, like any other", () => {
    const plan = planCourse([sheet("a3", atom("## Before you start", 300), fastTrack, guide, lecture)], written);
    // 300 words before the first pinned lens are a lens of their own.
    expect(plan.worksheets[0].lenses.map((l) => [l.key, l.pinned?.id ?? null])).toEqual([
      ["a3#before-you-start", null],
      ["a3#fast-track", "overview"],
      ["a3#lecture-notes", "lecture"],
    ]);
  });

  it("is retired when an atom of that name is there with other text", () => {
    const other = atom("## Fast-track", 60, prose("another fast track altogether", 60));
    const plan = planCourse([sheet("a3", other, lecture)], written);
    expect(plan.retired).toEqual([{ pin: written[0], reason: 'its text is not in the source any more (its section "prerequisites" is gone from "a3")' }]);
    // What is there joins the first pinned lens: 60 words are not a lens.
    expect(shape(plan)).toEqual(["Fast-track + Lecture notes"]);
    expect(ids(plan)).toEqual(["lecture"]);
  });

  it("is retired when all that is left of it is hidden from learners", () => {
    const timetable = atom("## Roadmap for today", 0, prose("a timetable for facilitators", 120));
    const withTimetable = [sheet("a3", prerequisites, timetable, lecture)];
    const pins = pinsOf(planCourse(withTimetable, [bare("a3#prerequisites", "overview"), bare("a3#lecture-notes", "lecture")]));
    const plan = planCourse([sheet("a3", timetable, lecture)], pins);
    expect(plan.retired).toEqual([{ pin: pins[0], reason: "all that is left of it in the source is hidden from learners" }]);
    expect(shape(plan)).toEqual(["Roadmap for today + Lecture notes"]);
  });
});

// -------------------------------------------------------------- fingerprint

describe("fingerprint", () => {
  const lens = [atom("## Setup", 300, prose("setup", 400)), atom("### Notation", 200, prose("notation", 300))];
  /** The fingerprint of a lens that is its whole worksheet. */
  const print = (atoms: Atom[]) => fingerprint(atoms, atoms);

  it("is letters, digits and three slashes, short enough for frontmatter", () => {
    // Two marks, 500 words, no other atom named like the first, 32 hashes.
    expect(print(lens)).toMatch(/^[0-9A-Za-z]{6}\/500\/1\/[0-9A-Za-z]{128}$/);
    // Three pairs of words: "slides see", "see the", "the slides".
    expect(print([atom("## Slides", 3, "See the slides.")])).toMatch(/^[0-9A-Za-z]{3}\/3\/1\/[0-9A-Za-z]{12}$/);
    expect(print([])).toBe("/0/0/");
    // The worksheet has the heading of the lens's first atom twice.
    const again = { ...atom("## Setup", 100), anchor: "setup-1" };
    expect(fingerprint(lens, [...lens, again]).split("/")[2]).toBe("2");
    const long = Array.from({ length: 40 }, (_, i) => atom(`### Part ${prose(String(i), 1)}`, 100));
    // A lens of 40 atoms: 3 characters each.
    expect(print(long).length).toBeLessThan(280);
  });

  it("depends on the text and not on the object", () => {
    expect(print(lens)).toBe(print(structuredClone(lens)));
    expect(fingerprintSimilarity(print(lens), print(lens))).toBe(1);
  });

  it("stays alike under a small edit and is unlike another text", () => {
    const words = prose("setup", 400).split(" ");
    words.splice(100, 8, ...prose("a new sentence", 10).split(" "));
    const edited = [atom("## Setup", 302, words.join(" ")), lens[1]];
    expect(fingerprintSimilarity(print(lens), print(edited))).toBeGreaterThan(0.8);

    const other = [atom("## Setup", 300, prose("another text", 400)), atom("### Notation", 200, prose("and more", 300))];
    expect(fingerprintSimilarity(print(lens), print(other))).toBeLessThan(0.2);
    expect(MATCH).toBeGreaterThan(0.5);
  });

  it("reads the same text the same as MDX and as Lens markdown", () => {
    const mdx = atom("", 40, '<Exercise id="ex-1">\n\n**Exercise 1.** Show that $G^\\Phi = G - \\Phi(s_0)$ holds for [every policy](/agency/rl#policies) in the class.\n\n</Exercise>');
    const lensMarkdown = atom("", 40, ':::callout {title="Exercise" tone="amber"}\n**Exercise 3.** Show that $$G^\\Phi = G - \\Phi(s_0)$$ holds for [every policy](https://iliad-intensive.org/agency/rl#policies) in the class.\n:::');
    expect(print([mdx]).split("/")[3]).toBe(print([lensMarkdown]).split("/")[3]);
  });

  it("cannot be more alike than the sizes allow", () => {
    // The same text with a 30-word section more: the sketches may agree, the sizes do not.
    const more = [...lens, atom("### Aside", 30, "See the slides.")];
    const alike = fingerprintSimilarity(print(lens), print(more));
    expect(alike).toBeLessThan(1);
    expect(alike).toBeCloseTo(500 / 530, 1);
  });
});

// ----------------------------------------------------------------- adoption

describe("adoptPin", () => {
  const exercise = `Exercise. ${prose("the exercise", 80)}`;
  const atoms = [
    atom("", 150, prose("opening text", 150)),
    atom("## Prerequisites", 120, prose("prerequisites", 120)),
    atom("## 1. The $\\xi$ mixture", 400, `${prose("the mixture", 150)}\n\n${exercise}`),
    atom("### Exercises", 200, prose("exercises one", 200)),
    atom("## 2. Bounds", 300, prose("bounds", 300)),
    { ...atom("### Exercises", 200, prose("exercises two", 200)), anchor: "exercises-1" },
  ];
  const lens = (id: string, headings: string[], text: string): ExistingLens => ({ id, headingAnchors: uniqueAnchors(headings), text });

  it("pins a lens to the atom its first heading names", () => {
    const pin = adoptPin("s", atoms, lens("L1", ["Prerequisites"], `\\## Prerequisites\n\n${prose("prerequisites", 120)}`));
    expect(pin).toMatchObject({ key: "s#prerequisites", id: "L1" });
    // The fingerprint is one the planner reads: the lens is like the atom it was made from.
    expect(fingerprintSimilarity(pin!.fingerprint, fingerprint([atoms[1]], atoms))).toBeGreaterThan(0.9);
  });

  it("pins a lens whose heading was rewritten by its text", () => {
    const text = `\\## 1. The xi mixture\n\n${prose("the mixture", 150)}\n\n${exercise}\n\n\\### Exercises\n\n${prose("exercises one", 200)}`;
    expect(adoptPin("s", atoms, lens("L2", ["1. The xi mixture", "Exercises"], text))?.key).toBe("s#1-the--mixture");
  });

  it("pins a lens that begins with the text before the first heading to that text", () => {
    const text = `${prose("opening text", 150)}\n\n\\## Prerequisites\n\n${prose("prerequisites", 120)}`;
    expect(adoptPin("s", atoms, lens("L3", ["Prerequisites"], text))?.key).toBe("s#");
  });

  it("tells two sections with one heading apart by their text", () => {
    const second = adoptPin("s", atoms, lens("L4", ["Exercises"], `\\### Exercises\n\n${prose("exercises two", 200)}`));
    expect(second?.key).toBe("s#exercises-1");
    const first = adoptPin("s", atoms, lens("L5", ["Exercises"], `\\### Exercises\n\n${prose("exercises one", 200)}`));
    expect(first?.key).toBe("s#exercises");
  });

  it("pins a lens that holds only the first part of its atom", () => {
    const text = `\\## 1. The $$\\xi$$ mixture\n\n${prose("the mixture", 150)}`;
    expect(adoptPin("s", atoms, lens("L6", ["1. The $\\xi$ mixture"], text))?.key).toBe("s#1-the--mixture");
  });

  it("does not place a lens that begins in the middle of an atom", () => {
    // The hand import cut this section at its exercise. No lens of the sync can start there.
    expect(adoptPin("s", atoms, lens("L7", [], exercise))).toBeNull();
    expect(adoptPin("s", atoms, lens("L8", ["Exercises"], `${exercise}\n\n\\### Exercises\n\n${prose("exercises one", 200)}`))).toBeNull();
  });

  it("does not place a lens whose text is not in the worksheet", () => {
    expect(adoptPin("s", atoms, lens("L9", ["Summary"], `\\## Summary\n\n${prose("a summary", 200)}`))).toBeNull();
    // A heading of the worksheet over other text is not enough either.
    expect(adoptPin("s", atoms, lens("L10", ["Prerequisites"], `\\## Prerequisites\n\n${prose("other prerequisites", 120)}`))).toBeNull();
  });

  it("records what the lens held, so a later run does not cut it there", () => {
    const big = [atom("## A", 2500, prose("part a", 200)), atom("### A1", 2500, prose("part a one", 200)), atom("## B", 300)];
    const text = `\\## A\n\n${prose("part a", 200)}\n\n\\### A1\n\n${prose("part a one", 200)}`;
    const pin = adoptPin("s", big, lens("L11", ["A", "A1"], text))!;
    expect(shape(planCourse([sheet("s", ...big)], [pin, bare("s#b", "B")]))).toEqual(["A + A1", "B"]);
  });
});

// ------------------------------------------------- real files: test data

/** A built MDX file as the Worksheet the converter takes. Its place in the schedule does not matter here. */
const pageOf = (slug: string, file: string): Worksheet => ({
  slug,
  cluster: { id: "X", label: "X", urlSlug: "x" },
  dayCode: "X.1",
  dayTitle: slug,
  code: "X.1",
  title: slug,
  summary: null,
  contributors: [],
  slides: null,
  pageUrl: `https://iliad-intensive.org/x/${slug}/`,
  mdx: file.replace(/^---\n[\s\S]*?\n---\n/, ""),
});

/** The converter's atoms for the text of a built MDX file. */
const atomsOfText = async (slug: string, mdx: string) => (await convertWorksheet(pageOf(slug, mdx), async (sitePath) => `https://img.test${sitePath}.png`)).atoms;
const atomsOfFile = (slug: string, path: string) => atomsOfText(slug, readFileSync(path, "utf8"));

interface HandLens extends ExistingLens {
  name: string;
  slug: string;
}

/** TEST ONLY. A lens file of the hand import as `adoptPin` takes it, or null when it is not from iliad-intensive.org. */
function handLens(path: string): HandLens | null {
  const file = readFileSync(path, "utf8");
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(file)!;
  const url = /^source_url:\s*['"]?https:\/\/iliad-intensive\.org\/[^/'"\s]+\/([^/'"\s]+)/m.exec(frontmatter[1]);
  if (!url) return null;
  const text = [...file.slice(frontmatter[0].length).matchAll(/^content::[ \t]*\n?([\s\S]*?)(?=^#### |(?![\s\S]))/gm)].map((m) => m[1]).join("\n");
  const plain = (heading: string) =>
    heading
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\$[^$]*\$/g, "")
      .replace(/[*_`]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  return {
    name: path.slice(path.lastIndexOf("/") + 1, -3),
    slug: url[1],
    id: /^id:\s*['"]?([^'"\s]+)/m.exec(frontmatter[1])![1],
    headingAnchors: [...text.matchAll(/^\\#{2,4} (.+)$/gm)].map((m) => headingAnchor(plain(m[1]))),
    text,
  };
}

const wordsOf = (atoms: Atom[]) => atoms.reduce((sum, a) => sum + a.words, 0);
const textOf = (atom: Atom) => atom.parts.map((p) => (p.kind === "text" ? p.markdown : "")).join("\n");

describe("the hand import of one worksheet (D.2, cut down)", () => {
  const FIXTURES = join(import.meta.dirname, "__fixtures__", "plan");
  const slug = "policy-gradients-misgeneralization";
  const lenses = readdirSync(join(FIXTURES, "lenses")).sort().map((name) => handLens(join(FIXTURES, "lenses", name))!);
  let atoms: Atom[] = [];
  beforeAll(async () => {
    atoms = await atomsOfFile(slug, join(FIXTURES, `${slug}.mdx`));
  });

  it("adopts the three lenses at their headings", () => {
    expect(atoms.map((a) => [a.level, a.anchor, a.words > 0])).toEqual([
      [0, "", true], // the video
      [2, "prerequisites", true],
      [2, "roadmap-for-today", false], // a timetable, hidden from learners
      [2, "vanilla-policy-gradient", true],
      [2, "goal-misgeneralization", true],
      [3, "potential-shaping", true],
      [5, "ex-shaping-telescope", true],
    ]);
    expect(lenses.map((l) => adoptPin(slug, atoms, l)?.key)).toEqual([`${slug}#prerequisites`, `${slug}#vanilla-policy-gradient`, `${slug}#goal-misgeneralization`]);
  });

  it("keeps the three lenses, and the section Iliad added since joins the lens it is under", () => {
    const pins = lenses.map((l) => adoptPin(slug, atoms, l)!);
    const plan = planCourse([{ slug, atoms }], pins);

    // "Potential shaping" and its exercise were not in the source when the import was made (commit 46ea03c).
    expect(shape(plan)).toEqual([
      "(top) + Prerequisites + Roadmap for today",
      "Vanilla Policy Gradient",
      "Goal Misgeneralization + Potential shaping + ex-shaping-telescope",
    ]);
    expect(ids(plan)).toEqual(lenses.map((l) => l.id));
    expect(plan.retired).toEqual([]);
    // The video before the first heading is 11 words: it joins the first lens, as in the hand import.
    expect(plan.worksheets[0].lenses[0].key).toBe(`${slug}#`);

    const again = planCourse([{ slug, atoms }], pinsOf(plan));
    expect(shape(again)).toEqual(shape(plan));
    expect(ids(again)).toEqual(ids(plan));
  });

  it("packs the worksheet into one lens when it has no pins", () => {
    // 191 words come before "Goal Misgeneralization" (the hidden timetable counts 0): under `min`, so no lens ends there.
    expect(wordsOf(atoms.slice(0, 4))).toBe(191);
    expect(planCourse([{ slug, atoms }], []).worksheets[0].lenses.map((l) => [l.key, l.atoms.length])).toEqual([[`${slug}#`, 7]]);
  });
});

// ----------------------------------------------------- the whole hand import
//
// Opt-in: ILIAD_FIXTURES is a directory with `built/<slug>.mdx` (the 28 built
// worksheets) and `lens-edu/` (a clone of the Lens Edu content). The atoms
// are the converter's.

const CORPUS = process.env.ILIAD_FIXTURES ?? "";

describe.skipIf(!CORPUS)("the hand import of the whole course", { timeout: 300_000 }, () => {
  const sheets: { slug: string; atoms: Atom[] }[] = [];
  /** The lenses of the import in the order the module files list them, each with its pin. */
  let adopted: { lens: HandLens; pin: Pin | null }[] = [];
  let pins: Pin[] = [];

  beforeAll(async () => {
    const slugs = readdirSync(join(CORPUS, "built"))
      .filter((name) => name.endsWith(".mdx") && !name.endsWith("-nosol.mdx"))
      .map((name) => name.replace(".mdx", ""))
      .sort();
    for (const slug of slugs) sheets.push({ slug, atoms: await atomsOfFile(slug, join(CORPUS, "built", `${slug}.mdx`)) });

    const edu = join(CORPUS, "lens-edu");
    const lenses: HandLens[] = [];
    for (const module of readdirSync(join(edu, "modules")).filter((name) => name.startsWith("Iliad ")).sort()) {
      for (const [, name] of readFileSync(join(edu, "modules", module), "utf8").matchAll(/^source:: \[\[\.\.\/Lenses\/(Iliad [^\]|]+)\]\]/gm)) {
        const path = join(edu, "Lenses", `${name}.md`);
        const lens = existsSync(path) && !lenses.some((l) => l.name === name) ? handLens(path) : null;
        if (lens) lenses.push(lens);
      }
    }
    adopted = lenses.map((lens) => ({ lens, pin: adoptPin(lens.slug, sheets.find((s) => s.slug === lens.slug)!.atoms, lens) }));
    pins = adopted.flatMap((a) => (a.pin ? [a.pin] : []));
  });

  const sizesOf = (plan: CoursePlan) => plan.worksheets.flatMap((w) => w.lenses.map((l) => wordsOf(l.atoms))).sort((a, b) => a - b);
  const sameLenses = (a: CoursePlan, b: CoursePlan) =>
    expect(b.worksheets.map((w) => w.lenses.map((l) => [l.key, l.atoms.length]))).toEqual(a.worksheets.map((w) => w.lenses.map((l) => [l.key, l.atoms.length])));

  it("adopts every lens that begins where a section or an exercise begins", () => {
    const atoms = sheets.flatMap((s) => s.atoms);
    const notPlaced = adopted.filter((a) => !a.pin).map((a) => a.lens.name);
    const atExercise = pins.filter((p) => atoms.some((a) => a.level === 5 && p.key.endsWith(`#${a.anchor}`)));
    console.log(`${atoms.length} atoms, ${atoms.filter((a) => a.level === 5).length} at an exercise, ${atoms.filter((a) => a.words === 0).length} of 0 words`);
    console.log(`adopted ${pins.length} of ${adopted.length} lenses, ${atExercise.length} at an exercise; not placed: ${notPlaced.join("; ")}`);
    console.log(`longest fingerprint: ${Math.max(...pins.map((p) => p.fingerprint.length))} characters`);

    expect(sheets).toHaveLength(28);
    expect(adopted).toHaveLength(198);
    // This one begins at the solution of an exercise.
    expect(notPlaced).toEqual(["Iliad E.2.6 - Solution to the random ReLU exercise and further reading"]);
    expect(atExercise).toHaveLength(5);
    expect(new Set(pins.map((p) => p.key)).size).toBe(pins.length);
    expect(Math.max(...pins.map((p) => p.fingerprint.length))).toBeLessThan(200);
  });

  it("plans the lenses of the import, each at its start, and adds only the section Iliad added since", () => {
    const plan = planCourse(sheets, pins);
    expect(plan.retired).toEqual([]);
    const added = plan.worksheets.filter((w) => w.slug !== "prerequisites").flatMap((w) => w.lenses.filter((l) => !l.pinned));
    console.log(`new lenses on the first run: ${added.map((l) => `${l.key} (${wordsOf(l.atoms)} words)`).join("; ")}`);
    // "Potential shaping" (an H3 of D.2 with its exercises) came to the source after the import (commit 46ea03c).
    expect(added.map((l) => l.key)).toEqual(["policy-gradients-misgeneralization#potential-shaping"]);
    for (const { slug, lenses } of plan.worksheets) {
      if (slug === "prerequisites") continue; // never imported
      const planned = lenses.filter((l) => l.pinned);
      // Every lens of the import goes on, in the import's order.
      expect(planned.map((l) => l.pinned?.id)).toEqual(adopted.filter((a) => a.pin && a.lens.slug === slug).map((a) => a.lens.id));
      for (const [n, lens] of planned.entries()) {
        // It starts at its pin, or at the top of the worksheet when less than a lens of text comes before the pin.
        const start = lens.atoms.findIndex((a) => `${slug}#${a.anchor}` === lens.pinned!.key);
        expect(start).toBeGreaterThanOrEqual(0);
        if (start > 0) expect([n, wordsOf(lens.atoms.slice(0, start)) < 200]).toEqual([0, true]);
      }
    }
    const sizes = sizesOf(plan);
    console.log(`with the import's pins: ${sizes.length} lenses, ${sizes.filter((s) => s > 3000).length} over 3,000 words (largest ${sizes[sizes.length - 1]}), ${sizes.filter((s) => s < 200).length} under 200, ${sizes.filter((s) => s === 0).length} of 0 words`);
    expect(sizes[0]).toBeGreaterThan(0);
    // The fingerprint goes into the frontmatter of the lens file.
    const prints = plan.worksheets.flatMap((w) => w.lenses.map((l) => l.fingerprint.length));
    console.log(`fingerprints of the plan: longest ${Math.max(...prints)} characters`);
    expect(Math.max(...prints)).toBeLessThan(260);
  });

  it("plans the same lenses again from its own output", () => {
    const plan = planCourse(sheets, pins);
    const again = planCourse(sheets, pinsOf(plan));
    sameLenses(plan, again);
    expect(again.retired).toEqual([]);
  });

  it("shows the upstream change since the import: D.2 gained 'Potential shaping'", () => {
    const d2 = planCourse(sheets, pins).worksheets.find((w) => w.slug === "policy-gradients-misgeneralization")!;
    console.log(d2.lenses.map((l) => `${l.pinned ? "kept" : "NEW "} ${l.key} (${wordsOf(l.atoms)} words): ${l.atoms.map((a) => a.anchor || "(top)").join(", ")}`).join("\n"));
    // A new section of 610 words under an H3 heading: a lens of its own, with its five exercises.
    expect(d2.lenses.map((l) => [l.key, Boolean(l.pinned)])).toEqual([
      ["policy-gradients-misgeneralization#", true],
      ["policy-gradients-misgeneralization#vanilla-policy-gradient", true],
      ["policy-gradients-misgeneralization#goal-misgeneralization", true],
      ["policy-gradients-misgeneralization#potential-shaping", false],
    ]);
    expect(wordsOf(d2.lenses[3].atoms)).toBe(610);
    expect(d2.lenses[3].atoms.slice(1).every((a) => a.level === 5)).toBe(true);
  });

  it("shows the plan with no pins: one worksheet, and the whole course", () => {
    const bare = planCourse(sheets, []);
    const prerequisites = bare.worksheets.find((w) => w.slug === "prerequisites")!.lenses;
    console.log(prerequisites.map((l) => `prerequisites: ${l.key} (${wordsOf(l.atoms)} words, ${l.atoms.length} atoms)`).join("\n"));
    expect(prerequisites.map((l) => l.key)).toEqual(["prerequisites#", "prerequisites#technical-prerequisites"]);

    const sizes = sizesOf(bare);
    const at = (share: number) => sizes[Math.floor(share * (sizes.length - 1))];
    console.log(`no pins: ${sizes.length} lenses; words min ${at(0)}, p10 ${at(0.1)}, median ${at(0.5)}, p90 ${at(0.9)}, max ${at(1)}; ${sizes.filter((s) => s > 3000).length} over 3,000`);
    const all = bare.worksheets.flatMap((w) => w.lenses);
    const starts = new Set(all.map((l) => l.key));
    console.log(`  ${pins.filter((p) => starts.has(p.key)).length} of the import's ${pins.length} lens starts are also starts of this plan; ${all.filter((l) => l.atoms[0].level === 5).length} lenses start at an exercise`);
    for (const lens of all.filter((l) => wordsOf(l.atoms) > 3000)) {
      console.log(`  over 3,000: ${lens.key} ${wordsOf(lens.atoms)} words: ${lens.atoms.map((a) => `L${a.level}:${a.words}`).join(" ")}`);
    }

    expect(sizes[0]).toBeGreaterThanOrEqual(200);
    // Past `max` only where no cut leaves `min` words on both sides: one atom, or a short head and one long atom.
    for (const lens of all.filter((l) => wordsOf(l.atoms) > 3000)) {
      expect(lens.atoms.filter((a) => a.words >= 200).length, lens.key).toBe(1);
    }
    expect(all.flatMap((l) => l.atoms)).toEqual(sheets.flatMap((s) => s.atoms));
    sameLenses(bare, planCourse(sheets, pinsOf(bare)));
  });

  // What the correctness review did to the source, here against the planner alone.
  const builtText = (slug: string) => readFileSync(join(CORPUS, "built", `${slug}.mdx`), "utf8");
  const withSheet = async (slug: string, mdx: string) => {
    const atoms = await atomsOfText(slug, mdx);
    return sheets.map((s) => (s.slug === slug ? { slug, atoms } : s));
  };
  const lensOf = (plan: CoursePlan, id: string) => plan.worksheets.flatMap((w) => w.lenses).find((l) => l.pinned?.id === id);

  it("keeps the id of A.2.3 with its text when the first of two 'Post-training' sections is renamed or deleted", async () => {
    const slug = "alignment-in-practice";
    const written = pinsOf(planCourse(sheets, pins)); // the pins after the first run
    const pin = written.find((p) => p.key === `${slug}#post-training`)!;
    const list = written.find((p) => p.key === `${slug}#further-reading`)!;
    const before = planCourse(sheets, written);
    // The reading list at the end has a "Post-training" heading too: "post-training-1".
    expect(lensOf(before, list.id)!.atoms.map((a) => a.anchor)).toContain("post-training-1");

    const text = builtText(slug);
    const at = text.indexOf("\n### Post-training\n");
    const end = text.indexOf("\n### Deployment 1: strategy\n", at);

    const renamed = planCourse(await withSheet(slug, `${text.slice(0, at)}\n### Post-training and evaluation\n${text.slice(at + "\n### Post-training\n".length)}`), written);
    expect(renamed.retired).toEqual([]);
    expect(lensOf(renamed, pin.id)!.key).toBe(`${slug}#post-training-and-evaluation`);
    expect(wordsOf(lensOf(renamed, pin.id)!.atoms)).toBeGreaterThan(2500);
    // The heading of the reading list now has the anchor "post-training", and it is still in the reading list.
    expect(lensOf(renamed, list.id)!.atoms.map((a) => a.anchor)).toContain("post-training");
    expect(wordsOf(lensOf(renamed, list.id)!.atoms)).toBe(wordsOf(lensOf(before, list.id)!.atoms));

    const deleted = planCourse(await withSheet(slug, text.slice(0, at) + text.slice(end)), written);
    console.log(`A.2.3 after its section is deleted: ${deleted.retired.map((r) => r.reason).join(" | ")}`);
    expect(deleted.retired.map((r) => r.pin.id)).toEqual([pin.id]);
    expect(deleted.retired[0].reason).toBe(
      'its text is not in the source any more ("alignment-in-practice" has 1 section(s) named like "post-training" and had 2, so the anchor alone cannot say which is the lens)',
    );
    expect(wordsOf(lensOf(deleted, list.id)!.atoms)).toBe(wordsOf(lensOf(before, list.id)!.atoms));
  });

  it("keeps the first lens of a worksheet when its first section is deleted and something a learner sees is left of it", async () => {
    const written = pinsOf(planCourse(sheets, pins));
    const before = planCourse(sheets, written);
    const kept: string[] = [];
    const lost: string[] = [];
    for (const { slug } of sheets) {
      const first = before.worksheets.find((w) => w.slug === slug)!.lenses[0];
      const text = builtText(slug);
      const heading = /\n(## [^\n]+)\n/.exec(text);
      if (slug === "prerequisites" || !heading) continue; // day 0 is not part of the synced course
      // The first H2 section, to the next H2.
      const start = text.indexOf(`\n${heading[1]}\n`) + 1;
      const next = text.indexOf("\n## ", start + heading[1].length);
      const sheetsNow = await withSheet(slug, text.slice(0, start) + text.slice(next + 1));
      const atomsNow = sheetsNow.find((s) => s.slug === slug)!.atoms;
      const plan = planCourse(sheetsNow, written);
      // Of every lens of the worksheet: its id is lost only when no word of it that a learner sees is left.
      for (const lens of before.worksheets.find((w) => w.slug === slug)!.lenses) {
        const left = atomsNow.filter((a) => lens.atoms.some((b) => b.anchor === a.anchor));
        const retired = plan.retired.find((r) => r.pin.id === lens.pinned!.id);
        expect([lens.key, Boolean(retired)]).toEqual([lens.key, wordsOf(left) === 0]);
        if (lens !== first) continue;
        const line = `${slug}: ${wordsOf(left)} of ${wordsOf(lens.atoms)} words left`;
        if (retired) lost.push(`${line}; ${retired.reason}`);
        else kept.push(line);
      }
    }
    console.log(`first section deleted: ${kept.length} first lenses keep their id, ${lost.length} lose it:\n  ${lost.join("\n  ")}`);
    // Nothing a learner sees is left of these five: the lens was that section, or the rest is a hidden timetable.
    expect(lost.map((line) => line.split(":")[0])).toEqual(["alignment-in-practice-ii", "mechanistic-interpretability", "open-source-game-theory", "world-models", "worst-case-interp"]);
    expect(kept).toHaveLength(22);
  });

  // A settled course: the plan with no pins, and the pins a run would write for it.
  const settled = () => {
    const plan = planCourse(sheets, []);
    const home = new Map(plan.worksheets.flatMap((w) => w.lenses.map((l) => [`id of ${l.key}`, l.atoms[0]] as const)));
    return { plan, written: pinsOf(plan), home };
  };
  const firstAtoms = (plan: CoursePlan) => new Map(plan.worksheets.flatMap((w) => w.lenses.filter((l) => l.pinned).map((l) => [l.pinned!.id, l.atoms[0]] as const)));

  it("finds every pin of a worksheet again when the worksheet is renamed", () => {
    const { written, home } = settled();
    for (const renamed of sheets) {
      const plan = planCourse(sheets.map((s) => (s === renamed ? { ...s, slug: `${s.slug}-renamed` } : s)), written);
      expect(plan.retired).toEqual([]);
      expect(firstAtoms(plan)).toEqual(home);
    }
  });

  it("finds every pin again when the first atom of each lens of a worksheet is renamed", () => {
    const { written, home } = settled();
    for (const changed of sheets) {
      const lensStarts = new Set(written.filter((p) => p.key.startsWith(`${changed.slug}#`)).map((p) => p.key.slice(changed.slug.length + 1)));
      const was = new Map<Atom, Atom>();
      const atoms = changed.atoms.map((a) => {
        if (!a.level || !lensStarts.has(a.anchor)) return a;
        // A new anchor, and a new heading where the atom has one (an exercise has an id only).
        const renamed: Atom = { ...a, anchor: `renamed-${a.anchor}`, parts: a.parts.map((p) => (p.kind === "text" ? { ...p, markdown: p.markdown.replace(/^\\#+ .*$/m, "\\## A wholly different heading") } : p)) };
        was.set(renamed, a);
        return renamed;
      });
      const plan = planCourse(sheets.map((s) => (s === changed ? { ...s, atoms } : s)), written);
      expect(plan.retired, changed.slug).toEqual([]);
      expect(new Map([...firstAtoms(plan)].map(([id, a]) => [id, was.get(a) ?? a]))).toEqual(home);
    }
  });

  it("finds the pins of a worksheet again when it is merged into another", () => {
    const { written, home } = settled();
    for (let i = 0; i + 1 < sheets.length; i += 2) {
      const [into, from] = [sheets[i], sheets[i + 1]];
      const was = new Map<Atom, Atom>();
      const moved = from.atoms.map((a) => {
        const clash = !a.anchor || into.atoms.some((b) => b.anchor === a.anchor);
        const atom: Atom = { ...a, level: a.level || 2, anchor: clash ? `${a.anchor}-moved` : a.anchor };
        was.set(atom, a);
        return atom;
      });
      const merged = { slug: into.slug, atoms: [...into.atoms, ...moved] };
      const plan = planCourse([...sheets.filter((s) => s !== into && s !== from), merged], written);
      expect(plan.retired, from.slug).toEqual([]);
      expect(new Map([...firstAtoms(plan)].map(([id, a]) => [id, was.get(a) ?? a]))).toEqual(home);
    }
  });

  it("retires the pin of a lens that is deleted, and no other", () => {
    const { plan, written } = settled();
    for (const worksheet of plan.worksheets) {
      // One lens of each worksheet: the middle one.
      const lens = worksheet.lenses[worksheet.lenses.length >> 1];
      const gone = new Set(lens.atoms);
      const without = sheets.map((s) => (s.slug === worksheet.slug ? { ...s, atoms: s.atoms.filter((a) => !gone.has(a)) } : s));
      expect(planCourse(without, written).retired.map((r) => r.pin.key)).toEqual([lens.key]);
    }
  });
});
