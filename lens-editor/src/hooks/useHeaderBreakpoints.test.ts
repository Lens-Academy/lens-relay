// useHeaderBreakpoints.test.ts
import { describe, it, expect } from 'vitest';
import { useHeaderBreakpoints, type HeaderStage } from './useHeaderBreakpoints';

describe('useHeaderBreakpoints', () => {
  it('returns "full" for wide widths', () => {
    expect(useHeaderBreakpoints(1200)).toBe('full');
  });

  it('returns "compact-toggles" below 1100px', () => {
    expect(useHeaderBreakpoints(1050)).toBe('compact-toggles');
  });

  it('returns "hide-title" below 900px', () => {
    expect(useHeaderBreakpoints(850)).toBe('hide-title');
  });

  it('returns "hide-username" below 750px', () => {
    expect(useHeaderBreakpoints(700)).toBe('hide-username');
  });

  it('returns "overflow" below 600px', () => {
    expect(useHeaderBreakpoints(550)).toBe('overflow');
  });

  it('returns "full" for zero width (not yet measured)', () => {
    expect(useHeaderBreakpoints(0)).toBe('full');
  });
});
