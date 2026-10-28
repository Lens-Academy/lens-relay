import { describe, expect, it } from 'vitest';
import { DEFAULT_PRESENTATION } from './jev-presentation';
import { newCheckText, auroc, bandOf, bandRule, discardDraft, isCheckPath, parseCheck, parseCheckFile, parsePercentiles, platformWordProblems, percentileRows, histogram, saveDraft, setCheckFields, setDraftField, shares , platformProblems, setDraftPresentation, readView, setView, wobbles} from './jev-check';

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
      criteria: { true: 'It uses one.', false: 'It does not.' }, enabled: true, presentation: DEFAULT_PRESENTATION,
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

describe('parsePercentiles: the lower half, up to 0.5', () => {
  it('reads a list, sorted, without repeats', () => {
    expect(parsePercentiles('[0.3, 0, 0.01, 0.3]')).toEqual([0, 0.01, 0.3]);
  });
  it('refuses nonsense and stops past the middle', () => {
    expect(() => parsePercentiles('[0.7]')).toThrow(/0 to 0.5/);
    expect(() => parsePercentiles('banana')).toThrow();
    expect(() => parsePercentiles('[]')).toThrow();
  });
});

describe('percentileRows: stops up to 0.5, mirrored, each taking the next free index in from the ends', () => {
  const idx = (n: number, half: number[]) => {
    const items = Array.from({ length: n }, (_, i) => ({ id: String(i), p: i / n }));
    return percentileRows(items, half).map((r) => Number(r.item.id));
  };
  it("Lauren's example: four tiny stops on ten items take the four from each end", () => {
    expect(idx(10, [0.0001, 0.0002, 0.0003, 0.0004])).toEqual([0, 1, 2, 3, 6, 7, 8, 9]);
  });
  it('a big sample gives the true percentiles again', () => {
    expect(idx(1_000_000, [0.0001, 0.0002]).map(String)).toEqual(['100', '200', '999799', '999899']);
  });
  it('a stop at the middle is shown once (odd length)', () => {
    expect(idx(200, [0, 0.01, 0.03, 0.1, 0.3, 0.5])).toEqual([0, 2, 6, 20, 60, 100, 139, 179, 193, 197, 199]);
    expect(idx(11, [0, 0.5])).toEqual([0, 5, 10]);
  });
  it('a sample smaller than the stops shows every item once', () => {
    expect(idx(3, [0, 0.01, 0.03, 0.1, 0.3, 0.5])).toEqual([0, 1, 2]);
    expect(idx(1, [0, 0.5])).toEqual([0]);
    expect(idx(2, [0, 0.5])).toEqual([0, 1]);
    expect(idx(10, [0.4, 0.5])).toEqual([4, 5]);
  });
  it('labels each row with its stop, mirrored ones as 1 minus it', () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ id: String(i), p: i }));
    expect(percentileRows(items, [0.1, 0.5]).map((r) => r.at)).toEqual([0.1, 0.5, 0.9]);
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
  it('says when one request\'s answers fall in different bands', () => {
    expect(wobbles(c, [0.81, 0.95, 0.8])).toBe(false);
    expect(wobbles(c, [0.81, 0.79])).toBe(true);
    expect(wobbles(c, [0.49, 0.5])).toBe(true);
    expect(wobbles(c, [0.3])).toBe(false);
  });
  it('states each rule and counts shares', () => {
    expect(bandRule(c, 'unsure')).toBe('0.5 ≤ p < 0.8');
    expect(shares(c, [0.9, 0.6, 0.1, 0.2])).toEqual({ fail: 0.25, unsure: 0.25, pass: 0.5 });
  });
});

describe('drafts', () => {
  it('has no draft until a field differs from the live one', () => {
    expect(parseCheckFile(T1).draft).toBeNull();
    expect(setDraftField(T1, ['question'], parseCheck(T1).question)).toBe(T1);
  });
  it('keeps only the changed fields in the draft and overlays them on the live check', () => {
    const t = setDraftField(T1, ['criteria', 'true'], 'Yes it does.');
    const { live, draft } = parseCheckFile(t);
    expect(live.criteria?.true).toBe('It uses one.');
    expect(draft?.criteria).toEqual({ true: 'Yes it does.', false: 'It does not.' });
    expect(draft?.question).toBe(live.question);
    expect(t.endsWith('\nnotes')).toBe(true);
  });
  it('drops the draft when it is edited back to the live text', () => {
    const t = setDraftField(T1, ['question'], 'New?');
    expect(parseCheckFile(setDraftField(t, ['question'], parseCheck(T1).question)).draft).toBeNull();
  });
  it('save makes the draft live; discard removes it', () => {
    const t = setDraftField(setDraftField(T1, ['question'], 'New?'), ['fail_at'], 0.9);
    const saved = parseCheckFile(saveDraft(t));
    expect([saved.live.question, saved.live.fail_at, saved.draft]).toEqual(['New?', 0.9, null]);
    expect(discardDraft(t)).toBe(T1);
  });
  it('refuses a draft key the check does not have', () => {
    expect(() => parseCheckFile(T1.replace('---\nnotes', 'draft:\n  questoin: x\n---\nnotes'))).toThrow(/questoin/);
  });
});

describe('frontmatter edits', () => {
  it('never re-wraps long lines', () => {
    const long = 'word '.repeat(40).trim();
    const t = T1.replace('It does not.', long);
    const out = setDraftField(t, ['question'], 'Q?');
    expect(out.split('\n').length - t.split('\n').length).toBe(2);
    expect(out).toContain(long);
  });
});

describe('newCheckText', () => {
  it('parses as a check with the given id and name', () => {
    const c = parseCheck(newCheckText('T6', 'hedges every claim'));
    expect([c.id, c.name, c.model, c.fail_at, c.enabled]).toEqual(['T6', 'hedges every claim', 'jev-1.14.0', 0.8, false]);
    expect(c.question).toContain('`paragraph`');
  });
  it('refuses ids and names that would make a bad file', () => {
    expect(() => newCheckText('6 x', 'n')).toThrow();
    expect(() => newCheckText('T6', 'a/b')).toThrow();
  });
});

describe('platformProblems: what would make the platform drop the check', () => {
  const ok = `---\nid: T9\nname: n\nmodel: jev-1.14.0\nfail_at: 0.8\npass_below: 0.5\nquestion: Is \`paragraph\` bad?\ncriteria:\n  "true": it does\n  "false": it does not\nfix: Fix it.\n---\nnotes\n`;
  it('passes a well-formed check', () => expect(platformProblems(ok)).toEqual([]));
  it('names each rule broken', () => {
    expect(platformProblems(ok.replace('jev-1.14.0', 'jev-1.15.0'))).toEqual(['model must be jev-1.14.0 (the platform pins it)']);
    expect(platformProblems(ok.replace('fail_at: 0.8', 'fail_at: 80'))).toEqual(['fail_at must be a number from 0 to 1']);
    expect(platformProblems(ok.replace('fix: Fix it.\n', ''))).toEqual(['fix must be text']);
    expect(platformProblems(ok.replace('  "false": it does not\n', ''))).toEqual(['criteria must have exactly "true" and "false" texts']);
  });
  it('catches --- anywhere in the frontmatter, even in a draft', () => {
    const t = ok.replace('fix: Fix it.\n', 'fix: Fix it.\ndraft:\n  question: a --- b\n');
    expect(platformProblems(t)).toEqual(['"---" inside the frontmatter cuts it short for the platform']);
  });
});

describe('platformProblems reads YAML as the platform does (1.1)', () => {
  const ok = `---\nid: T9\nname: n\nmodel: jev-1.14.0\nquestion: q\ncriteria:\n  "true": it does\n  "false": it does not\nfix: f\n---\n`;
  it('rejects unquoted true/false criteria keys and a yes/no name', () => {
    expect(platformProblems(ok.replace('"true"', 'true').replace('"false"', 'false'))).toEqual(['criteria must have exactly "true" and "false" texts']);
    expect(platformProblems(ok.replace('name: n', 'name: no'))).toEqual(['name must be text']);
    expect(platformProblems(ok.replace('name: n', 'name: "no"'))).toEqual([]);
    expect(platformProblems(ok)).toEqual([]); // y/n stay text for PyYAML
  });
  it('treats unquoted dates and base-60 numbers as not text, and any id as an id', () => {
    expect(platformProblems(ok.replace('name: n', 'name: 2026-10-22'))).toEqual(['name must be text']);
    expect(platformProblems(ok.replace('name: n', 'name: 1:30'))).toEqual(['name must be text']);
    expect(platformProblems(ok.replace('name: n', 'name: "1:30"'))).toEqual([]);
    expect(platformProblems(ok.replace('id: T9', 'id: 7'))).toEqual([]);
  });
});

describe('platformProblems: the words must suit the platform, which shows each paragraph alone', () => {
  const ok = `---\nid: T9\nname: n\nmodel: jev-1.14.0\nquestion: Is \`paragraph\` x?\ncriteria:\n  "true": "\`paragraph\` is"\n  "false": it is not\nfix: f\n---\n`;
  it('refuses a reference the platform cannot resolve, in the question or the criteria', () => {
    expect(platformProblems(ok)).toEqual([]);
    expect(platformProblems(ok.replace('Is `paragraph` x?', 'Is `sentence` x?'))).toEqual(['`sentence` in the question: finer than the paragraph asked about, so no one sentence']);
    expect(platformProblems(ok.replace('`paragraph` is', '`section` is'))).toEqual(['`section` in the "true" criterion: jev sees only one paragraph, not the section around it']);
    expect(platformProblems(ok.replace('Is `paragraph` x?', 'Is `paragraph_3` x?'))[0]).toMatch(/^`paragraph_3` in the question: write `paragraph`/);
  });
  it('names the word problems apart, since the platform still runs such a check', () => {
    const bad = ok.replace('Is `paragraph` x?', 'Is `sentence` x?').replace('model: jev-1.14.0', 'model: jev-9');
    expect(platformWordProblems(bad)).toEqual(['`sentence` in the question: finer than the paragraph asked about, so no one sentence']);
    expect(platformProblems(bad)).toHaveLength(2);
  });
  it('leaves other backticked words alone', () => {
    expect(platformProblems(ok.replace('Is `paragraph` x?', 'Is `paragraph` a `foo()`?'))).toEqual([]);
  });
});

describe('a check file\'s presentation and view', () => {
  const T = `---\nid: T9\nmodel: jev-1.14.0\nquestion: Is \`paragraph\` x?\nfix: f\n---\n`;
  it('drafts a presentation, and drops the draft when it is the live one again', () => {
    const lens = { context: 'lens', question: 'sentence', nest: ['section'] } as const;
    const drafted = setDraftPresentation(T, { ...lens, nest: [...lens.nest] });
    expect(parseCheckFile(drafted).draft?.presentation).toEqual({ context: 'lens', question: 'sentence', nest: ['section'] });
    expect(parseCheckFile(drafted).live.presentation).toEqual(DEFAULT_PRESENTATION);
    expect(setDraftPresentation(drafted, DEFAULT_PRESENTATION)).toBe(T);
  });
  it('drafts a presentation over an unreadable live block', () => {
    const bad = T.replace('fix: f', 'fix: f\npresentation: {context: page}');
    expect(setDraftPresentation(bad, DEFAULT_PRESENTATION)).toContain('draft:');
  });
  it('saves any readable presentation, and checks words against it', () => {
    const shown = (p: Parameters<typeof setDraftPresentation>[1]) => platformProblems(saveDraft(setDraftPresentation(T, p)));
    expect(shown({ context: 'document', question: 'paragraph', nest: [] })).toEqual([]);
    expect(shown({ context: 'document', question: 'sentence', nest: [] })).toEqual([expect.stringMatching(/`paragraph` in the question: nesting by paragraph is off/)]);
    expect(platformProblems(T.replace('fix: f', 'fix: f\npresentation: {context: page}'))).toHaveLength(1);
  });
  it('keeps a shared view block the check ignores', () => {
    const v = setView(setView(T, 'sample', 10), 'courses', ['a', 'b']);
    expect(readView(v)).toEqual({ sample: 10, courses: ['a', 'b'] });
    expect(parseCheck(v).question).toBe('Is `paragraph` x?');
    expect(platformProblems(v)).toEqual([]);
    expect(setView(v, 'sample', 10)).toBe(v);
  });
});

describe('placeholders', () => {
  it("names the new check's placeholder words as problems, and nothing else that has an ellipsis", () => {
    const t = newCheckText('T9', 'x');
    expect(platformWordProblems(t).filter((p) => p.includes('placeholder'))).toHaveLength(4);
    const written = setCheckFields(t, [{ path: ['fix'], value: 'Say it plainly…' }, { path: ['question'], value: 'Does `paragraph` trail off…?' }]);
    expect(platformWordProblems(written).filter((p) => p.includes('placeholder'))).toHaveLength(2);
  });
});
