import { useSyncExternalStore } from 'react';

/**
 * Mobile breakpoint. Two cases get the mobile shell:
 * - width < 500px — phone-sized portrait viewports, leaving tablets on the
 *   desktop shell (`not all and (min-width: ...)` covers fractional widths);
 * - landscape phones — wide enough for the desktop breakpoint but with a
 *   touch pointer and very little height, where pinned sidebars and drag
 *   handles are unusable. Tablets (taller) stay on the desktop layout.
 * Note: load-bearing mobile/desktop switches must branch on useIsMobile(), not CSS.
 */
export const MOBILE_QUERY = 'not all and (min-width: 500px), ((pointer: coarse) and (max-height: 480px))';

// Single shared MediaQueryList — getSnapshot runs on every render of every
// consumer, so avoid re-parsing the query each time.
let mql: MediaQueryList | null = null;
function getMql(): MediaQueryList {
  mql ??= window.matchMedia(MOBILE_QUERY);
  return mql;
}

function subscribe(callback: () => void): () => void {
  const m = getMql();
  m.addEventListener('change', callback);
  return () => m.removeEventListener('change', callback);
}

function getSnapshot(): boolean {
  return getMql().matches;
}

/** True for phone-sized viewports. SSR-safe default: false. */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
