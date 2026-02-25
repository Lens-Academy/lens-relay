export type HeaderStage =
  | 'full'             // > 1100px: everything visible
  | 'compact-toggles'  // < 1100px: toggles become icon-only
  | 'hide-title'       // < 900px: "Lens Editor" title hidden
  | 'hide-username'    // < 750px: display name hidden
  | 'overflow';        // < 600px: toggles move to overflow menu

const BREAKPOINTS: [number, HeaderStage][] = [
  [600, 'overflow'],
  [750, 'hide-username'],
  [900, 'hide-title'],
  [1100, 'compact-toggles'],
];

/**
 * Returns the current header responsive stage based on container width.
 * Check narrowest breakpoints first — first match wins.
 */
export function useHeaderBreakpoints(headerWidth: number): HeaderStage {
  if (headerWidth === 0) return 'full'; // Not yet measured

  for (const [breakpoint, stage] of BREAKPOINTS) {
    if (headerWidth < breakpoint) return stage;
  }
  return 'full';
}
