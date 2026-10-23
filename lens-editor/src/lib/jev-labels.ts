// Labels: a person's judgement that some course text has (fail) or has not (pass) the problem a
// check asks about, or can't tell. Kept in the check's own file, in a "## Labels" section of one
// JSON line each, so they live in git with the check and anyone can read or fix them (Lauren,
// 2026-10-23; docs/course-dev-set/live-checks/checks-and-labels-redesign.plain.md). A label is
// about the words, not about what jev was shown: it is found again by its quote.

export interface Label {
  check: string;  // the check's id
  path: string;
  line: number;   // where the words were when labelled
  quote: string;  // the words judged
  label: 'fail' | 'pass' | 'cant_tell';
  note?: string;
  by: string;
  at: string;     // ISO time
}

const HEAD = '## Labels';
const FENCE = /^## Labels\n+```jsonl\n([\s\S]*?)```/m;
const words = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function parseLabels(text: string): Label[] {
  const m = text.match(FENCE);
  if (!m) return [];
  return m[1].split('\n').flatMap((line) => {
    try { const l = JSON.parse(line); return l && typeof l.quote === 'string' && typeof l.check === 'string' ? [l as Label] : []; } catch { return []; }
  });
}

/** `text` with `label` appended to its Labels section (made at the end when missing). */
export function addLabel(text: string, label: Label): string {
  const line = JSON.stringify(label) + '\n';
  const m = text.match(FENCE);
  if (m) {
    const end = m.index! + m[0].length - 3;  // before the closing fence
    return text.slice(0, end) + line + text.slice(end);
  }
  return `${text.trimEnd()}\n\n${HEAD}\n\n\`\`\`jsonl\n${line}\`\`\`\n`;
}

/** The newest label of `check` whose words are in `unit`. */
export function labelFor(labels: Label[], check: string, unit: string): Label | undefined {
  const u = words(unit);
  return labels.filter((l) => l.check === check && u.includes(words(l.quote))).sort((a, b) => b.at.localeCompare(a.at))[0];
}

/** How a run's bands compare with the labels on its units. */
export function agreement(labels: Label[], check: string, units: { text: string; band: 'fail' | 'unsure' | 'pass' }[]) {
  const out = { labelled: 0, agree: 0, disagree: 0, unsure: 0 };
  for (const u of units) {
    const l = labelFor(labels, check, u.text);
    if (!l || l.label === 'cant_tell') continue;
    out.labelled++;
    if (u.band === 'unsure') out.unsure++;
    else if (u.band === l.label) out.agree++;
    else out.disagree++;
  }
  return out;
}
