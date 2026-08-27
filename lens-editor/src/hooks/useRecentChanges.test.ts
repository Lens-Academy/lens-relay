/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useRecentChanges } from './useRecentChanges';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const event = {
  id: '1-7-0', ts: 1_000, actor: 'ai:fable-5:luc', author: "Luc's AI", mode: 'direct', kind: 'insert',
  old: '', new: 'x', old_truncated: false, new_truncated: false, ctx_before: '', ctx_after: '',
  pos: 0, client: 7, clock_from: 0, clock_to: 1, anchor: null,
};

describe('useRecentChanges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches per folder with since_ms and tags results with folder_id', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ files: [{ path: '/A.md', doc_id: 'relay-doc-a', events: [event] }], since_ms: 500 }),
    } as Response);

    const { result } = renderHook(() => useRecentChanges(['folder-1', 'folder-2'], 500));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/relay/recent-changes?folder_id=folder-1&since_ms=500',
      expect.objectContaining({ headers: expect.any(Object) }),
    );
    expect(result.current.data).toHaveLength(2);
    expect(result.current.data[0].folder_id).toBe('folder-1');
    expect(result.current.data[0].events[0].new).toBe('x');
    expect(result.current.error).toBeNull();
  });

  it('reports an error only when every folder failed', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ files: [{ path: '/B.md', doc_id: 'relay-doc-b', events: [event] }], since_ms: 0 }),
      } as Response);
    const { result } = renderHook(() => useRecentChanges(['f1', 'f2']));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.data).toHaveLength(1);

    mockFetch.mockRejectedValue(new Error('boom'));
    const failing = renderHook(() => useRecentChanges(['f1']));
    await waitFor(() => expect(failing.result.current.loading).toBe(false));
    expect(failing.result.current.error).toMatch(/Failed to fetch recent changes/);
  });
});
