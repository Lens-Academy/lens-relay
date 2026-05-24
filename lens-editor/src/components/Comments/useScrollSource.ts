import { useEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import type { ScrollSource } from './types';

/** ScrollSource backed by a real scrollable DOM element. The returned object
 *  is stable for the lifetime of the hook; getters re-read live values, and
 *  subscribers fanout from a single underlying scroll + ResizeObserver wiring. */
export function useScrollSource(ref: RefObject<HTMLElement | null>): ScrollSource {
  const subsRef = useRef(new Set<() => void>());

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const fire = () => {
      subsRef.current.forEach(fn => fn());
    };
    el.addEventListener('scroll', fire, { passive: true });
    const ro = new ResizeObserver(fire);
    ro.observe(el);

    return () => {
      el.removeEventListener('scroll', fire);
      ro.disconnect();
    };
  }, [ref]);

  return useMemo<ScrollSource>(() => ({
    getScrollTop: () => ref.current?.scrollTop ?? 0,
    getScrollHeight: () => ref.current?.scrollHeight ?? 0,
    getClientHeight: () => ref.current?.clientHeight ?? 0,
    subscribe(onChange) {
      subsRef.current.add(onChange);
      return () => {
        subsRef.current.delete(onChange);
      };
    },
  }), [ref]);
}
