import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { __embedDocsTesting } from '../../lib/embed-docs';
import { SNAPSHOT_REFRESH_MS, useSnapshots } from './useConceptRows';

afterEach(() => {
  __embedDocsTesting.reset();
  vi.useRealTimers();
});

describe('useSnapshots', () => {
  it('reads concept files again on window focus, so edits made elsewhere show up', async () => {
    let version = 1;
    __embedDocsTesting.setReader(async () => `text v${version}`);
    const { result } = renderHook(() => useSnapshots(['c1']));
    await waitFor(() => expect(result.current.texts.get('c1')).toBe('text v1'));

    version = 2;
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(result.current.texts.get('c1')).toBe('text v2'));
  });

  it('reads them again on a timer while open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let version = 1;
    __embedDocsTesting.setReader(async () => `text v${version}`);
    const { result } = renderHook(() => useSnapshots(['c1']));
    await waitFor(() => expect(result.current.texts.get('c1')).toBe('text v1'));

    version = 2;
    await act(async () => { await vi.advanceTimersByTimeAsync(SNAPSHOT_REFRESH_MS); });
    await waitFor(() => expect(result.current.texts.get('c1')).toBe('text v2'));
  });
});
