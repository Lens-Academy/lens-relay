/**
 * The read-aloud player's keyboard shortcuts, shared by the player bar (keys
 * pressed in the editor window) and the HTML preview frame (keys pressed in
 * the page, which the frame forwards because focus often sits there).
 */

import type { ReadAloudEngine } from './engine';
import { SPEAKING_RATE_STEP, normalizeSpeakingRate } from './prefs';

export const READ_ALOUD_KEYS = ['toggle', 'next', 'prev', 'slower', 'faster'] as const;
export type ReadAloudKey = (typeof READ_ALOUD_KEYS)[number];

export function isReadAloudKey(value: unknown): value is ReadAloudKey {
  return (READ_ALOUD_KEYS as readonly unknown[]).includes(value);
}

/** What a keydown means to the player: an action, 'swallow' for a key it owns
 *  that does nothing now (a held Space; prevent its default so the page does
 *  not scroll), or null for a key that is not the player's. */
export type ReadAloudKeyResult = ReadAloudKey | 'swallow' | null;

/**
 * The action a keydown asks for: Space plays / pauses, [ / ] and the arrows
 * step by sentence, < / > change speed (as on YouTube). Null while the user
 * types in a field, holds a modifier, or the page already used the key. On a
 * focused slider (the speed slider after a drag) the arrows stay the
 * slider's, but Space and < / > still work. Tag checks rather than
 * instanceof, so it works on a frame's events too.
 */
export function readAloudKeyFor(e: KeyboardEvent): ReadAloudKeyResult {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return null;
  const target = e.target as HTMLElement | null;
  const onSlider = target?.tagName === 'INPUT' && (target as HTMLInputElement).type === 'range';
  if (!onSlider && target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName ?? '')) return null;
  if (target?.isContentEditable) return null;
  if (onSlider && e.key.startsWith('Arrow')) return null;
  if (e.code === 'Space') return e.repeat ? 'swallow' : 'toggle';
  if (e.key === ']' || e.key === 'ArrowRight') return 'next';
  if (e.key === '[' || e.key === 'ArrowLeft') return 'prev';
  if (e.key === '>') return 'faster';
  if (e.key === '<') return 'slower';
  return null;
}

export function applyReadAloudKey(engine: ReadAloudEngine, key: ReadAloudKey): void {
  switch (key) {
    case 'toggle':
      engine.toggle();
      break;
    case 'next':
      engine.skip(1);
      break;
    case 'prev':
      engine.skip(-1);
      break;
    case 'faster':
    case 'slower': {
      const step = key === 'faster' ? SPEAKING_RATE_STEP : -SPEAKING_RATE_STEP;
      const rate = normalizeSpeakingRate(engine.getSnapshot().prefs.speakingRate + step);
      if (rate !== null) engine.setPrefs({ speakingRate: rate });
      break;
    }
  }
}
