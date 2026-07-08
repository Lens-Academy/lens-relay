import { useEffect, useState } from 'react';

/**
 * Height in px of browser UI covering the bottom of the layout viewport —
 * in practice the on-screen keyboard. Tracked via visualViewport so fixed
 * bottom elements (edit toolbar, bottom sheets) can sit above it.
 * Returns 0 when visualViewport is unavailable or nothing is covered.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      setInset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  return inset;
}
