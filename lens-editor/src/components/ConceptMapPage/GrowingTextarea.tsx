import { useCallback, useEffect, useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';

/** The share of the window's height a box may take before it scrolls inside. */
const CAP = 0.6;

/**
 * A textarea that is as tall as its text: it grows while typing and opens at
 * the height of the text it already holds. `rows` is its least height; from
 * 60% of the window's height on it scrolls inside instead.
 */
export function GrowingTextarea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // Measuring makes the box short for a moment: what scrolls around it must stay where it is
    const scrolled: Array<[Element, number]> = [];
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      if (parent.scrollTop > 0) scrolled.push([parent, parent.scrollTop]);
    }
    el.style.height = 'auto';
    const wanted = el.scrollHeight + (el.offsetHeight - el.clientHeight);
    // Nothing to measure (not laid out): `rows` decides
    if (el.scrollHeight > 0) {
      const cap = Math.round(window.innerHeight * CAP);
      el.style.height = `${Math.min(wanted, cap)}px`;
      el.style.overflowY = wanted > cap ? 'auto' : 'hidden';
    }
    for (const [parent, top] of scrolled) parent.scrollTop = top;
  }, []);

  useLayoutEffect(fit, [fit, props.value]);

  // A narrower box wraps its text onto more lines
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit]);

  return <textarea ref={ref} {...props} className={`${className} resize-none`} />;
}
