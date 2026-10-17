/** The listener's read-aloud settings, kept per browser (like the platform's). */

export const MIN_SPEAKING_RATE = 0.75;
export const MAX_SPEAKING_RATE = 4.5;
export const SPEAKING_RATE_STEP = 0.25;
export const DEFAULT_VOICE_ID = 'harper_32';

export interface ReadAloudPrefs {
  speakingRate: number;
  voiceId: string;
  highlightMode: 'word' | 'sentence';
}

const STORAGE_KEY = 'lens-read-aloud-prefs';
const DEFAULTS: ReadAloudPrefs = { speakingRate: 1.5, voiceId: DEFAULT_VOICE_ID, highlightMode: 'word' };

/** Clamp to the slider's range and snap to its step; null for non-numbers. */
export function normalizeSpeakingRate(n: unknown): number | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const clamped = Math.min(MAX_SPEAKING_RATE, Math.max(MIN_SPEAKING_RATE, n));
  return Math.round(clamped / SPEAKING_RATE_STEP) * SPEAKING_RATE_STEP;
}

export function loadPrefs(): ReadAloudPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<ReadAloudPrefs>;
    return {
      speakingRate: normalizeSpeakingRate(raw.speakingRate) ?? DEFAULTS.speakingRate,
      voiceId: typeof raw.voiceId === 'string' && /^[\w-]{1,64}$/.test(raw.voiceId) ? raw.voiceId : DEFAULTS.voiceId,
      highlightMode: raw.highlightMode === 'sentence' ? 'sentence' : 'word',
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(prefs: ReadAloudPrefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Private mode or full storage: the settings just don't persist.
  }
}
