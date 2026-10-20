import { describe, expect, it } from 'vitest';
import { auroc, bandOf, bandRule, isCheckPath, parseCheck, parsePercentiles, percentileRows, histogram, setCheckFields, shares } from './jev-check';

const T1 = `---
id: T1
name: term used before it is explained
model: jev-1.14.0
fail_at: 0.8
pass_below: 0.5
question: Does \`paragraph\` use a technical term without explaining it?
criteria:
  "true": It uses one.
  "false": It does not.
---
notes`;

describe('parseCheck', () => {
  it('reads a check file', () => {
    const c = parseCheck(T1);
    expect(c).toEqual({
      id: 'T1', name: 'term used before it is explained', model: 'jev-1.14.0', fail_at: 0.8, pass_below: 0.5,
      question: 'Does `paragraph` use a technical term without explaining it?',
      criteria: { true: 'It uses one.', false: 'It does not.' },
    });
  });
  it('says what is missing rather than guessing', () => {
    expect(() => parseCheck('---\nid: T9\n---\n')).toThrow(/question/);
    expect(() => parseCheck('no frontmatter')).toThrow(/frontmatter/);
  });
  it('defaults model and thresholds to the deployed ones', () => {
    const c = parseCheck('---\nid: X\nquestion: Q?\n---\n');
    expect([c.model, c.fail_at, c.pass_below, c.criteria]).toEqual(['jev-1.14.0', 0.8, 0.5, null]);
  });
});

describe('isCheckPath', () => {
  it('matches files directly in Lens Edu/Checks', () => {
    expect(isCheckPath('/Lens Edu/Checks/T1 - term.md')).toBe(true);
    expect(isCheckPath('/Lens Edu/Checks/T1.labels.json')).toBe(false);
    expect(isCheckPath('/Lens Edu/Lenses/T1.md')).toBe(false);
    expect(isCheckPath(undefined)).toBe(false);
  });
});

describe('parsePercentiles', () => {
  it('reads a list', () => {
    expect(parsePercentiles('[0, 0.01, 0.5, 1]')).toEqual([0, 0.01, 0.5, 1]);
  });
  it('reads "N even" inclusive of both ends', () => {
    expect(parsePercentiles('5 even')).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });
  it('refuses nonsense', () => {
    expect(() => parsePercentiles('[2]')).toThrow();
    expect(() => parsePercentiles('banana')).toThrow();
    expect(() => parsePercentiles('1 even')).toThrow();
  });
});

describe('percentileRows', () => {
  it('picks the item at each percentile of the sorted scores', () => {
    const items = [0.9, 0.1, 0.5, 0.3, 0.7].map((p, i) => ({ id: String(i), p }));
    expect(percentileRows(items, [0, 0.5, 1]).map((r) => r.item.p)).toEqual([0.1, 0.5, 0.9]);
  });
});

describe('histogram', () => {
  it('counts into equal bins with 1.0 in the last bin', () => {
    expect(histogram([0, 0.05, 0.55, 1], 10)).toEqual([2, 0, 0, 0, 0, 1, 0, 0, 0, 1]);
  });
});

describe('auroc', () => {
  it('is 1 when every bad scores above every good, 0.5 on ties', () => {
    expect(auroc([0.9, 0.8], [0.1, 0.2])).toBe(1);
    expect(auroc([0.5], [0.5])).toBe(0.5);
    expect(auroc([], [0.1])).toBeNull();
  });
});

describe('setCheckFields', () => {
  it('changes only the named fields and keeps the body', () => {
    const out = setCheckFields(T1, [{ path: ['question'], value: 'New?' }, { path: ['criteria', 'true'], value: 'Yes.' }]);
    const c = parseCheck(out);
    expect([c.question, c.criteria?.true, c.criteria?.false, c.fail_at]).toEqual(['New?', 'Yes.', 'It does not.', 0.8]);
    expect(out.endsWith('\nnotes')).toBe(true);
  });
  it('adds criteria when the file had none', () => {
    const c = parseCheck(setCheckFields('---\nid: X\nquestion: Q?\n---\n', [{ path: ['criteria', 'true'], value: 'a' }, { path: ['criteria', 'false'], value: 'b' }]));
    expect(c.criteria).toEqual({ true: 'a', false: 'b' });
  });
});

describe('bands', () => {
  const c = parseCheck(T1);
  it('puts the thresholds in the right band', () => {
    expect([0.8, 0.79, 0.5, 0.49].map((p) => bandOf(c, p))).toEqual(['fail', 'unsure', 'unsure', 'pass']);
  });
  it('states each rule and counts shares', () => {
    expect(bandRule(c, 'unsure')).toBe('0.5 ≤ p < 0.8');
    expect(shares(c, [0.9, 0.6, 0.1, 0.2])).toEqual({ fail: 0.25, unsure: 0.25, pass: 0.5 });
  });
});
