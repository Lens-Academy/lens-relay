import { useSyncExternalStore } from 'react';

/**
 * Light or dark appearance, as in Notion's settings: follow the computer
 * (System, the default), or always Light or Dark. The setting is remembered
 * in this browser. The resolved theme is `data-theme` on <html>, which
 * index.css's colour tokens and Tailwind's `dark:` variant read.
 */
export type ThemeSetting = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'lens-theme';
const darkQuery = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: dark)') : undefined;
const listeners = new Set<() => void>();

function readSetting(): ThemeSetting {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // Storage blocked (private window): fall back to the computer's setting
  }
  return 'system';
}

let setting: ThemeSetting = typeof window !== 'undefined' ? readSetting() : 'system';

function resolved(): 'light' | 'dark' {
  if (setting === 'system') return darkQuery?.matches ? 'dark' : 'light';
  return setting;
}

function apply() {
  const theme = resolved();
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  for (const listener of listeners) listener();
}

/** Applies the remembered setting and follows the computer's changes. Call once, before rendering. */
export function initTheme() {
  apply();
  darkQuery?.addEventListener('change', () => {
    if (setting === 'system') apply();
  });
}

export function setThemeSetting(next: ThemeSetting) {
  setting = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Not remembered, but still applied for this visit
  }
  apply();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The setting (system / light / dark) and the theme in effect. */
export function useTheme(): { setting: ThemeSetting; theme: 'light' | 'dark' } {
  const current = useSyncExternalStore(subscribe, () => `${setting}:${resolved()}`, () => 'system:light');
  const [s, t] = current.split(':') as [ThemeSetting, 'light' | 'dark'];
  return { setting: s, theme: t };
}
