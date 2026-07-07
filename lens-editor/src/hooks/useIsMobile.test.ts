import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useIsMobile, MOBILE_QUERY } from './useIsMobile';

describe('useIsMobile', () => {
  it('reflects the current matchMedia state', () => {
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(window.matchMedia(MOBILE_QUERY).matches);
  });

  it('covers phone-width viewports plus landscape touch phones', () => {
    expect(MOBILE_QUERY).toBe('not all and (min-width: 500px), ((pointer: coarse) and (max-height: 480px))');
  });
});
