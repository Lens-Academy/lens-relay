import { useEffect, useMemo, useRef } from 'react';
import type { ScrollSource } from './types';

/** ScrollSource backed by a real scrollable DOM element. Pass the element
 *  directly (not a ref) so the hook re-attaches when the element becomes
 *  available later. The returned object is stable for the lifetime of the
 *  hook; getters re-read live values, and subscribers fanout from a single
 *  underlying scroll + ResizeObserver wiring. */
export function useScrollSource(el: HTMLElement | null): ScrollSource {
  const subsRef = useRef(new Set<() => void>());
  const elRef = useRef<HTMLElement | null>(el);
  elRef.current = el;

  useEffect(() => {
    if (!el) return;

    const fire = (): void => {
      subsRef.current.forEach(fn => fn());
    };
    el.addEventListener('scroll', fire, { passive: true });
    const ro = new ResizeObserver(fire);
    ro.observe(el);

    return () => {
      el.removeEventListener('scroll', fire);
      ro.disconnect();
    };
  }, [el]);

  return useMemo<ScrollSource>(() => ({
    getScrollTop: () => elRef.current?.scrollTop ?? 0,
    getScrollHeight: () => elRef.current?.scrollHeight ?? 0,
    getClientHeight: () => elRef.current?.clientHeight ?? 0,
    subscribe(onChange) {
      subsRef.current.add(onChange);
      return () => {
        subsRef.current.delete(onChange);
      };
    },
  }), []);
}
