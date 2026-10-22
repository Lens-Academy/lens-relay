import { describe, expect, it } from 'vitest';
import { buildRequests, DEFAULT_PRESENTATION, type Presentation } from './presentation';
import type { JevCheck } from '../../lib/jev-check';

const check = { id: 'T', name: 'n', model: 'jev-1.14.0', fail_at: 0.8, pass_below: 0.5, question: 'Is `paragraph` x?', criteria: { true: '`paragraph` is', false: 'it is not' }, enabled: true } as JevCheck;
const row = (line: number, text: string) => ({ id: `a.md:${line}`, path: 'a.md', line, kind: 'Text', title: null, courses: [], text });
const FILE = '# One\n\nFirst. Second.\n\nThird.\n\n# Two\n\nFourth.\n';
const p = (o: Partial<Presentation>): Presentation => ({ ...DEFAULT_PRESENTATION, ...o });

describe('buildRequests', () => {
  it("the default asks the platform's text as a lone paragraph, with no files needed", () => {
    const { units, batches } = buildRequests(check, [row(3, 'First. Second.')], DEFAULT_PRESENTATION, {});
    expect(units[0].id).toBe('a.md:3');
    expect(batches).toEqual([{ state: { paragraph: 'First. Second.' }, questions: [{ instructions: 'Is `paragraph` x?', criteria: { true: '`paragraph` is', false: 'it is not' } }] }]);
  });
  it('refuses to show jev an empty document when the file is missing', () => {
    expect(() => buildRequests(check, [row(3, 'First.')], p({ context: 'document', question: 'sentence' }), {})).toThrow(/a.md could not be read/);
  });
  it('asks every sampled unit in one context in one batch, each question on its key', () => {
    const { units, batches } = buildRequests(check, [row(3, 'First. Second.'), row(9, 'Fourth.')], p({ context: 'document', question: 'sentence' }), { 'a.md': FILE });
    expect(batches).toHaveLength(1);
    expect(batches[0].questions.map((q) => q.instructions)).toEqual(['Is `sentence_0` x?', 'Is `sentence_1` x?', 'Is `sentence_3` x?']);
    expect(batches[0].questions[2].criteria).toEqual({ true: '`sentence_3` is', false: 'it is not' });
    expect(units.map((u) => [u.id, u.text])).toEqual([['a.md#sentence_0', 'First.'], ['a.md#sentence_1', 'Second.'], ['a.md#sentence_3', 'Fourth.']]);
  });
  it('one batch per context, and a coarser question unit asked once', () => {
    const { units, batches } = buildRequests(check, [row(3, 'First. Second.'), row(5, 'Third.'), row(9, 'Fourth.')], p({ context: 'section', question: 'section' }), { 'a.md': FILE });
    expect(units.map((u) => u.id)).toEqual(['a.md#section_0', 'a.md#section_1']);
    expect(batches.map((b) => b.state)).toEqual([{ section: '# One\n\nFirst. Second.\n\nThird.' }, { section: '# Two\n\nFourth.' }]);
    expect(batches[0].questions[0].instructions).toBe('Is `section` x?');
  });
});
