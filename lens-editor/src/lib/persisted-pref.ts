/**
 * Per-browser editor preference: a CodeMirror StateField seeded from
 * localStorage, with an effect to change it and load/save helpers for the
 * React side. Storage failures (private mode, blocked site data) fall back
 * to the default.
 */
import { StateEffect, StateField, type StateEffectType } from '@codemirror/state';

export interface PersistedPref<T> {
  load(): T;
  save(value: T): void;
  set: StateEffectType<T>;
  field: StateField<T>;
}

export function persistedPref<T>(
  key: string,
  fallback: T,
  codec: { parse: (raw: string) => T | undefined; format: (value: T) => string },
): PersistedPref<T> {
  const load = (): T => {
    try {
      const raw = localStorage.getItem(key);
      const value = raw === null ? undefined : codec.parse(raw);
      return value === undefined ? fallback : value;
    } catch {
      return fallback;
    }
  };
  const save = (value: T): void => {
    try {
      localStorage.setItem(key, codec.format(value));
    } catch {
      // storage unavailable
    }
  };
  const set = StateEffect.define<T>();
  const field = StateField.define<T>({
    create: () => load(),
    update: (value, tr) => {
      for (const e of tr.effects) {
        if (e.is(set)) return e.value;
      }
      return value;
    },
  });
  return { load, save, set, field };
}

export function persistedFlag(key: string, fallback: boolean): PersistedPref<boolean> {
  return persistedPref(key, fallback, {
    parse: (raw) => (raw === '1' ? true : raw === '0' ? false : undefined),
    format: (value) => (value ? '1' : '0'),
  });
}

export function persistedChoice<T extends string>(
  key: string,
  values: readonly T[],
  fallback: T,
): PersistedPref<T> {
  return persistedPref(key, fallback, {
    parse: (raw) => (values.includes(raw as T) ? (raw as T) : undefined),
    format: (value) => value,
  });
}

/** Positive finite number, e.g. a duration in milliseconds. */
export function persistedPositiveNumber(key: string, fallback: number): PersistedPref<number> {
  return persistedPref(key, fallback, {
    parse: (raw) => {
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    },
    format: String,
  });
}
