/**
 * The read-aloud player's keyboard shortcuts, shared by the player bar (keys
 * pressed in the editor window) and the HTML preview frame (keys pressed in
 * the page, which the frame forwards because focus often sits there).
 */

import type { ReadAloudEngine } from './engine';
import { SPEAKING_RATE_STEP, normalizeSpeakingRate } from './prefs';

export type ReadAloudKey = 'toggle' | 'next' | 'prev' | 'slower' | 'faster';

export const READ_ALOUD_KEYS: readonly ReadAloudKey[] = ['toggle', 'next', 'prev', 'slower', 'faster'];

/**
 * The action a keydown asks for: Space plays / pauses, [ / ] and the arrows
 * step by sentence, < / > change speed (as on YouTube). Null while the user
 * types in a field, holds a modifier, or the page already used the key.
 * Tag checks rather than instanceof, so it works on a frame's events too.
 */
export function readAloudKeyFor(e: KeyboardEvent): ReadAloudKey | null {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return null;
  const target = e.target as HTMLElement | null;
  if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName ?? '')) return null;
  if (target?.isContentEditable) return null;
  if (e.code === 'Space') return e.repeat ? null : 'toggle';
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
