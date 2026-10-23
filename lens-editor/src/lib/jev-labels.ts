// Labels: a person's judgement that some course text has (fail) or has not (pass) the problem a
// check asks about, or can't tell. Kept in the check's own file, in a "## Labels" section of one
// JSON line each, so they live in git with the check and anyone can read or fix them (Lauren,
// 2026-10-23; docs/course-dev-set/live-checks/checks-and-labels-redesign.plain.md). A label is
// about the words, not about what jev was shown: it is found again by its quote, in its file, at
// its level (a label on one sentence says nothing about the paragraph around it).

export interface Label {
  check: string;  // the check's id
  path: string;
  unit?: string;  // the level judged (paragraph, sentence, ...); paragraph when absent
  line: number;   // where the words were when labelled
  quote: string;  // the words judged
  label: 'fail' | 'pass' | 'cant_tell';
  note?: string;
  by: string;
  at: string;     // ISO time
}

const HEAD = '## Labels';
const FENCE = /^## Labels(?:\r?\n)+```jsonl\r?\n([\s\S]*?)```/gm;
// The platform cuts a unit's text at 600 characters and adds "…" (present.batches), and a quote is
// stored without it; both sides drop it, so two long units sharing those 600 characters (in one
// file, at one level) would share labels (Assay, #195).
const words = (s: string) => s.replace(/…\s*$/, '').toLowerCase().replace(/\s+/g, ' ').trim();

export function parseLabels(text: string): Label[] {
  // Every block: two viewers making a file's first label at once each add one.
  return [...text.matchAll(FENCE)].flatMap((m) => m[1].split(/\r?\n/)).flatMap((line) => {
    try { const l = JSON.parse(line); return l && typeof l.quote === 'string' && typeof l.check === 'string' ? [l as Label] : []; } catch { return []; }
  });
}

/** `text` with `label` appended to its Labels section (made at the end when missing). */
export function addLabel(text: string, label: Label): string {
  // A backtick is escaped, so a quote can never close the fence.
  const line = JSON.stringify(label).replace(/`/g, '\\u0060') + '\n';
  const m = [...text.matchAll(FENCE)].pop();
  if (m) {
    const end = m.index! + m[0].length - 3;  // before the closing fence
    return text.slice(0, end) + line + text.slice(end);
  }
  return `${text.trimEnd()}\n\n${HEAD}\n\n\`\`\`jsonl\n${line}\`\`\`\n`;
}

/** Where a label applies: a check's unit of some level, in a file, with these words. */
export interface Unit { path: string; unit?: string; text: string }

/** The newest label of `check` on exactly this unit: same file, same level, same words. */
export function labelFor(labels: Label[], check: string, u: Unit): Label | undefined {
  const w = words(u.text), level = u.unit ?? 'paragraph';
  return labels.filter((l) => l.check === check && l.path === u.path && (l.unit ?? 'paragraph') === level && words(l.quote) === w)
    .sort((a, b) => b.at.localeCompare(a.at))[0];
}

/** How a run's bands compare with the labels on its units. */
export function agreement(labels: Label[], check: string, units: (Unit & { band: 'fail' | 'unsure' | 'pass' })[]) {
  const out = { labelled: 0, agree: 0, disagree: 0, unsure: 0 };
  for (const u of units) {
    const l = labelFor(labels, check, u);
    if (!l || l.label === 'cant_tell') continue;
    out.labelled++;
    if (u.band === 'unsure') out.unsure++;
    else if (u.band === l.label) out.agree++;
    else out.disagree++;
  }
  return out;
}
