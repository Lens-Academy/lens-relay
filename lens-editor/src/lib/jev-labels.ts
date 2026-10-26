// Labels: a person's judgement that some course text has (fail) or has not (pass) the problem a
// check asks about, or can't tell. The platform keeps them as judgements (lens-platform
// core/course_checks/store.judge), where the same judgement also settles the live check's
// finding on those words for agents and reviewers (Lauren, 2026-10-25). A label is about the
// words, at a level, in a file, under a check id: not about what jev was shown, and not about
// one wording of the check, so it still scores a reworded draft.

export interface Label {
  id?: number;
  check_id: string;
  path: string;
  level: string;
  words: string;
  verdict: 'fail' | 'pass' | 'cant_tell';
  note?: string | null;
  by: string;
  line?: number | null;
  answer_key?: string | null;
  created_at?: string;
}

/** The words as the platform compares them (store.words_sha): whitespace runs are one space
 *  and a trailing "…" does not count. Case counts. */
const words = (s: string) => s.replace(/…\s*$/, '').replace(/\s+/g, ' ').trim();

/** A unit of a run: its file, level, display text, and (when the platform built the run) all
 *  its words, since the display text is cut at 600 characters. */
export interface Unit { path: string; unit?: string; text: string; words?: string; line?: number; answerKey?: string }

/** The label to post for `u` under `check`: always the unit's full words (Assay, #1420: a label
 *  on the cut display text would never match its row). */
export function labelBody(check: string, u: Unit, verdict: Label['verdict'], by: string): Label {
  return {
    check_id: check, path: u.path, level: u.unit ?? 'paragraph', words: u.words ?? u.text, verdict, by,
    ...(u.line != null ? { line: u.line } : {}), ...(u.answerKey ? { answer_key: u.answerKey } : {}),
  };
}

/** The newest label of `check` on exactly this unit: same file, same level, same words. */
export function labelFor(labels: Label[], check: string, u: Unit): Label | undefined {
  const w = words(u.words ?? u.text), level = u.unit ?? 'paragraph';
  let found: Label | undefined;
  for (const l of labels) if (l.check_id === check && l.path === u.path && l.level === level && words(l.words) === w) found = l;
  return found;  // labels come oldest first
}

/** How a run's bands compare with the labels on its units. */
export function agreement(labels: Label[], check: string, units: (Unit & { band: 'fail' | 'unsure' | 'pass' })[]) {
  const out = { labelled: 0, agree: 0, disagree: 0, unsure: 0 };
  for (const u of units) {
    const l = labelFor(labels, check, u);
    if (!l || l.verdict === 'cant_tell') continue;
    out.labelled++;
    if (u.band === 'unsure') out.unsure++;
    else if (u.band === l.verdict) out.agree++;
    else out.disagree++;
  }
  return out;
}
