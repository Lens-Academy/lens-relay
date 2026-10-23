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
  it('the newest label for a unit is the one that counts; words are matched, not lines', () => {
    const labels = [lab({}), lab({ label: 'pass', at: '2026-10-23T15:00:00Z' }), lab({ check: 'T5', label: 'fail' })];
    expect(labelFor(labels, 'T1', 'Intro. METR  measures task length. More.')?.label).toBe('pass');
    expect(labelFor(labels, 'T1', 'Nothing like it.')).toBeUndefined();
    expect(labelFor(labels, 'T9', 'METR measures task length.')).toBeUndefined();
  });
  it('agreement counts labelled units where the band matches; unsure counts as neither', () => {
    const labels = [lab({ quote: 'a fail here' }), lab({ quote: 'a pass here', label: 'pass' }), lab({ quote: 'unsure one', label: 'fail' })];
    const units = [
      { text: 'a fail here', band: 'fail' as const },
      { text: 'a pass here', band: 'fail' as const },
      { text: 'unsure one', band: 'unsure' as const },
      { text: 'unlabelled', band: 'pass' as const },
    ];
    expect(agreement(labels, 'T1', units)).toEqual({ labelled: 3, agree: 1, disagree: 1, unsure: 1 });
  });
  it('ignores a broken line rather than losing every label', () => {
    const broken = addLabel(CHECK, lab({})).replace('```jsonl\n', '```jsonl\nnot json\n');
    expect(parseLabels(broken)).toEqual([lab({})]);
  });
});
