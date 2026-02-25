import { useRef, useState, useEffect } from 'react';

/**
 * Tracks an element's width via ResizeObserver.
 * Returns { ref, width } — attach ref to the element you want to observe.
 */
export function useContainerWidth() {
  const ref = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setWidth(entry.contentRect.width);
      }
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return { ref, width };
}
