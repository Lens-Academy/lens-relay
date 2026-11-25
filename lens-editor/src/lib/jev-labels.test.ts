import { describe, expect, it } from 'vitest';
import { agreement, labelBody, labelFor, type Label } from './jev-labels';

const lab = (o: Partial<Label>): Label => ({ check_id: 'T1', path: 'Lens Edu/a.md', level: 'paragraph', words: 'METR measures task length.', verdict: 'fail', by: 'Lauren', ...o });

describe('labels are the platform\'s judgements of words, at a level, in a file', () => {
  it('a label posts the unit\'s full words, not its display text cut at 600 (Assay, #1420)', () => {
    const full = 'x'.repeat(700);
    const body = labelBody('T1', { path: 'Lens Edu/a.md', unit: 'lens', text: full.slice(0, 600) + '…', words: full, line: 3, answerKey: 'k' }, 'pass', 'Lauren');
    expect(body).toEqual({ check_id: 'T1', path: 'Lens Edu/a.md', level: 'lens', words: full, verdict: 'pass', by: 'Lauren', line: 3, answer_key: 'k' });
    // Without words (each paragraph alone: the corpus text is whole), the text is the words.
    expect(labelBody('T1', { path: 'Lens Edu/a.md', text: 'Short.' }, 'fail', 'L').words).toBe('Short.');
  });
  it('the newest label on these words at this level counts, in any file', () => {
    const labels = [lab({}), lab({ verdict: 'pass' }), lab({ check_id: 'T5' })];
    const u = { path: 'Lens Edu/a.md', text: 'METR  measures\ntask length.' };
    expect(labelFor(labels, 'T1', u)?.verdict).toBe('pass');
    expect(labelFor(labels, 'T9', u)).toBeUndefined();
    expect(labelFor([lab({ words: 'Why?' })], 'T1', { path: 'Lens Edu/a.md', text: 'Why? Because of METR.' })).toBeUndefined();
    expect(labelFor(labels, 'T1', { ...u, path: 'Lens Edu/b.md' })?.verdict).toBe('pass');  // same words, another file
    expect(labelFor([lab({ level: 'sentence' })], 'T1', u)).toBeUndefined();
    expect(labelFor([lab({ level: 'sentence' })], 'T1', { ...u, unit: 'sentence' })?.verdict).toBe('fail');
    // Case counts, as on the platform.
    expect(labelFor(labels, 'T1', { ...u, text: 'metr measures task length.' })).toBeUndefined();
  });
  it('a long unit\'s label is found by its full words', () => {
    const full = 'y'.repeat(700);
    expect(labelFor([lab({ words: full })], 'T1', { path: 'Lens Edu/a.md', text: full.slice(0, 600) + '…', words: full })?.verdict).toBe('fail');
  });
  it('agreement counts labelled units where the band matches; unsure counts as neither', () => {
    const labels = [lab({ words: 'a fail here' }), lab({ words: 'a pass here', verdict: 'pass' }), lab({ words: 'unsure one' })];
    const at = (text: string, band: 'fail' | 'unsure' | 'pass') => ({ path: 'Lens Edu/a.md', text, band });
    const units = [at('a fail here', 'fail'), at('a pass here', 'fail'), at('unsure one', 'unsure'), at('unlabelled', 'pass')];
    expect(agreement(labels, 'T1', units)).toEqual({ labelled: 3, agree: 1, disagree: 1, unsure: 1 });
  });
});
