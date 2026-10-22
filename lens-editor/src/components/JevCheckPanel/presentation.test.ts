import { describe, expect, it } from 'vitest';
import { buildRequests, DEFAULT_PRESENTATION } from './presentation';
import type { JevCheck } from '../../lib/jev-check';

const check = { id: 'T', name: 'n', model: 'jev-1.14.0', fail_at: 0.8, pass_below: 0.5, question: 'Is `paragraph` x?', criteria: { true: '`paragraph` is', false: 'it is not' }, enabled: true } as JevCheck;
const row = { id: 'a.md:1', path: 'a.md', line: 1, kind: 'Text', title: null, courses: [], text: 'One. Two.' };

describe('buildRequests', () => {
  it('the default asks the platform text as a lone paragraph, with no files needed', () => {
    const { requests } = buildRequests(check, [row], DEFAULT_PRESENTATION, {});
    expect(requests).toEqual([{ question: { instructions: 'Is `paragraph` x?', criteria: { true: '`paragraph` is', false: 'it is not' } }, state: { paragraph: 'One. Two.' } }]);
  });
  it('refuses to show jev an empty document when the file is missing', () => {
    expect(() => buildRequests(check, [row], { ...DEFAULT_PRESENTATION, mode: 'parsed' }, {})).toThrow(/no snapshot of a.md/);
  });
  it('templates question and criteria onto the parsed key, one request per sentence', () => {
    const { units, requests } = buildRequests(check, [row], { ...DEFAULT_PRESENTATION, mode: 'parsed', unit: 'sentence' }, { 'a.md': 'One. Two.\n' });
    expect(units.map((u) => u.text)).toEqual(['One.', 'Two.']);
    expect(requests[1].question).toEqual({ instructions: 'Is `sentence_1` x?', criteria: { true: '`sentence_1` is', false: 'it is not' } });
  });
});
