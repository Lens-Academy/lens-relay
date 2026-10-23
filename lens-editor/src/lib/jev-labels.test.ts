import { describe, expect, it } from 'vitest';
import { addLabel, agreement, labelFor, parseLabels, type Label } from './jev-labels';

const CHECK = `---\nid: T1\nquestion: Is \`paragraph\` x?\n---\n\nNotes about the check.\n`;
const lab = (o: Partial<Label>): Label => ({ check: 'T1', path: 'Lens Edu/a.md', line: 3, quote: 'METR measures task length.', label: 'fail', by: 'Lauren', at: '2026-10-23T14:00:00Z', ...o });

describe('labels in a check file (Lauren, 2026-10-23: a judgement about the text, kept with the check)', () => {
  it('a file without labels has none, and the first label adds the section', () => {
    expect(parseLabels(CHECK)).toEqual([]);
    const once = addLabel(CHECK, lab({}));
    expect(once.startsWith(CHECK.trimEnd())).toBe(true);
    expect(once).toContain('## Labels');
    expect(parseLabels(once)).toEqual([lab({})]);
  });
  it('later labels append, one line each, and the notes above stay', () => {
    const two = addLabel(addLabel(CHECK, lab({})), lab({ quote: 'Other words.', label: 'pass' }));
    expect(parseLabels(two).map((l) => l.label)).toEqual(['fail', 'pass']);
    expect(two).toContain('Notes about the check.');
    expect(two.match(/## Labels/g)).toHaveLength(1);
  });
  it('the newest label on exactly this unit counts: same file, level and words', () => {
    const labels = [lab({}), lab({ label: 'pass', at: '2026-10-23T15:00:00Z' }), lab({ check: 'T5', label: 'fail' })];
    const u = { path: 'Lens Edu/a.md', text: 'METR  measures task length.' };
    expect(labelFor(labels, 'T1', u)?.label).toBe('pass');
    expect(labelFor(labels, 'T9', u)).toBeUndefined();
    // Assay, #195: a label on a short quote must not match a paragraph that merely contains it,
    // another file, or another level.
    expect(labelFor([lab({ quote: 'Why?' })], 'T1', { path: 'Lens Edu/a.md', text: 'Why? Because of METR.' })).toBeUndefined();
    expect(labelFor(labels, 'T1', { ...u, path: 'Lens Edu/b.md' })).toBeUndefined();
    expect(labelFor([lab({ unit: 'sentence' })], 'T1', u)).toBeUndefined();
    expect(labelFor([lab({ unit: 'sentence' })], 'T1', { ...u, unit: 'sentence' })?.label).toBe('fail');
  });
  it('agreement counts labelled units where the band matches; unsure counts as neither', () => {
    const labels = [lab({ quote: 'a fail here' }), lab({ quote: 'a pass here', label: 'pass' }), lab({ quote: 'unsure one', label: 'fail' })];
    const at = (text: string, band: 'fail' | 'unsure' | 'pass') => ({ path: 'Lens Edu/a.md', text, band });
    const units = [at('a fail here', 'fail'), at('a pass here', 'fail'), at('unsure one', 'unsure'), at('unlabelled', 'pass')];
    expect(agreement(labels, 'T1', units)).toEqual({ labelled: 3, agree: 1, disagree: 1, unsure: 1 });
  });
  it('reads every Labels block (two first labels made at once), CRLF files, and backticks in a quote', () => {
    const block = (l: object) => '## Labels\n\n```jsonl\n' + JSON.stringify(l) + '\n```\n';
    const two = CHECK + '\n' + block(lab({})) + '\n' + block(lab({ quote: 'B.' }));
    expect(parseLabels(two).map((l) => l.quote)).toEqual(['METR measures task length.', 'B.']);
    expect(parseLabels(addLabel(CHECK, lab({})).replace(/\n/g, '\r\n'))).toEqual([lab({})]);
    const ticks = addLabel(addLabel(CHECK, lab({ quote: 'Use ```code``` here.' })), lab({ quote: 'Next.' }));
    expect(parseLabels(ticks).map((l) => l.quote)).toEqual(['Use ```code``` here.', 'Next.']);
  });
  it('finds a label on a long unit, whose text the platform cuts at 600 characters with "…"', () => {
    const shown = 'x'.repeat(600) + '…';
    const l = lab({ quote: shown.replace(/…$/, '') });
    expect(labelFor([l], 'T1', { path: 'Lens Edu/a.md', text: shown })?.label).toBe('fail');
  });
  it('ignores a broken line rather than losing every label', () => {
    const broken = addLabel(CHECK, lab({})).replace('```jsonl\n', '```jsonl\nnot json\n');
    expect(parseLabels(broken)).toEqual([lab({})]);
  });
});
