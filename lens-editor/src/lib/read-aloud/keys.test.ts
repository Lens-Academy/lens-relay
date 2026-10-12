import { describe, expect, it, vi } from 'vitest';
import { applyReadAloudKey, readAloudKeyFor } from './keys';
import type { ReadAloudEngine } from './engine';

const key = (init: KeyboardEventInit) => readAloudKeyFor(new KeyboardEvent('keydown', init));

describe('readAloudKeyFor', () => {
  it('maps the player shortcuts', () => {
    expect(key({ code: 'Space', key: ' ' })).toBe('toggle');
    expect(key({ key: ']' })).toBe('next');
    expect(key({ key: 'ArrowLeft' })).toBe('prev');
    expect(key({ key: '>', shiftKey: true })).toBe('faster');
    expect(key({ key: '<', shiftKey: true })).toBe('slower');
    expect(key({ key: 'a' })).toBeNull();
  });

  it('ignores modifiers and a held Space', () => {
    expect(key({ key: ']', metaKey: true })).toBeNull();
    expect(key({ code: 'Space', key: ' ', repeat: true })).toBeNull();
  });
});

describe('applyReadAloudKey', () => {
  it('steps the speed within the slider range', () => {
    let rate = 4.5;
    const engine = {
      getSnapshot: () => ({ prefs: { speakingRate: rate } }),
      setPrefs: vi.fn((p: { speakingRate: number }) => { rate = p.speakingRate; }),
    } as unknown as ReadAloudEngine;
    applyReadAloudKey(engine, 'faster');
    expect(rate).toBe(4.5);
    applyReadAloudKey(engine, 'slower');
    expect(rate).toBe(4.25);
  });
});
