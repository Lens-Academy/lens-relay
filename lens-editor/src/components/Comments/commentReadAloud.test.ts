import { describe, expect, it } from 'vitest';
import { buildThreadReading, unitAtOffset } from './commentReadAloud';
import type { ThreadView, MessageView } from './types';

const message = (id: string, body: string) => ({ id, author: 'A', body, timestamp: 0, canModify: false }) as unknown as MessageView;
const thread = {
  key: 't1',
  root: message('m1', 'First point. Second point.'),
  replies: [message('m2', 'A reply.')],
} as unknown as ThreadView;

describe('comment read-aloud', () => {
  it('reads the thread sentence by sentence, pausing between messages', () => {
    const reading = buildThreadReading(thread);
    expect(reading.units.map(u => u.text)).toEqual(['First point.', 'Second point.', 'A reply.']);
    expect(reading.units.map(u => u.pauseBefore)).toEqual([0.5, 0, 0.5]);
    expect(reading.parts[1]).toEqual({ messageId: 'm1', range: { start: 13, end: 26 } });
  });

  it('starts at the clicked sentence of the clicked message', () => {
    const reading = buildThreadReading(thread);
    expect(unitAtOffset(reading, 'm1', 0)).toBe(0);
    expect(unitAtOffset(reading, 'm1', 15)).toBe(1);
    expect(unitAtOffset(reading, 'm1', 26)).toBe(1);
    expect(unitAtOffset(reading, 'm2', 3)).toBe(2);
    expect(unitAtOffset(reading, 'missing', 0)).toBe(null);
  });
});
