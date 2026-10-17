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

  it('ignores modifiers, and swallows a held Space without toggling', () => {
    expect(key({ key: ']', metaKey: true })).toBeNull();
    expect(key({ code: 'Space', key: ' ', repeat: true })).toBe('swallow');
  });

  it('leaves text fields alone, but not a focused slider (arrows excepted)', () => {
    const on = (el: HTMLElement, init: KeyboardEventInit) => {
      document.body.appendChild(el);
      const event = new KeyboardEvent('keydown', { bubbles: true, ...init });
      let result: ReturnType<typeof readAloudKeyFor> = null;
      el.addEventListener('keydown', e => { result = readAloudKeyFor(e); }, { once: true });
      el.dispatchEvent(event);
      el.remove();
      return result;
    };
    const text = document.createElement('input');
    const slider = Object.assign(document.createElement('input'), { type: 'range' });
    expect(on(text, { code: 'Space', key: ' ' })).toBeNull();
    expect(on(slider, { code: 'Space', key: ' ' })).toBe('toggle');
    expect(on(slider, { key: '>' })).toBe('faster');
    expect(on(slider, { key: 'ArrowRight' })).toBeNull();
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
