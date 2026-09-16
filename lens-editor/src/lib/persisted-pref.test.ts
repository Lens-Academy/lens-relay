/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { persistedChoice, persistedFlag, persistedPositiveNumber } from './persisted-pref';

beforeEach(() => localStorage.clear());

describe('persistedPref', () => {
  it('seeds the field from storage and falls back on garbage', () => {
    const flag = persistedFlag('t-flag', true);
    expect(flag.load()).toBe(true);
    flag.save(false);
    expect(EditorState.create({ extensions: [flag.field] }).field(flag.field)).toBe(false);

    localStorage.setItem('t-flag', 'maybe');
    expect(flag.load()).toBe(true);

    const choice = persistedChoice('t-choice', ['a', 'b'] as const, 'a');
    localStorage.setItem('t-choice', 'c');
    expect(choice.load()).toBe('a');
    choice.save('b');
    expect(choice.load()).toBe('b');

    const ms = persistedPositiveNumber('t-ms', 60);
    localStorage.setItem('t-ms', '-5');
    expect(ms.load()).toBe(60);
    ms.save(120);
    expect(ms.load()).toBe(120);
  });

  it('changes through its effect', () => {
    const flag = persistedFlag('t-flag', false);
    const state = EditorState.create({ extensions: [flag.field] });
    expect(state.update({ effects: flag.set.of(true) }).state.field(flag.field)).toBe(true);
  });

  it('survives storage that throws', () => {
    const flag = persistedFlag('t-flag', true);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(flag.load()).toBe(true);
    expect(() => flag.save(false)).not.toThrow();
    vi.restoreAllMocks();
  });
});
