/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useSuggestions } from './useSuggestions';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('useSuggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts in loading state', () => {
    mockFetch.mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useSuggestions(['folder-1']));
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('fetches suggestions for a single folder', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        files: [{ path: 'Notes/Test.md', doc_id: 'doc-1', suggestions: [{ type: 'addition', content: 'hello' }] }],
      }),
    } as Response);

    const { result } = renderHook(() => useSuggestions(['folder-1']));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data).toHaveLength(1);
    expect(result.current.data[0].path).toBe('Notes/Test.md');
    expect(mockFetch).toHaveBeenCalledWith('/api/relay/suggestions?folder_id=folder-1', expect.objectContaining({ headers: expect.any(Object) }));
  });

  it('aggregates suggestions across multiple folders', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          files: [{ path: 'A.md', doc_id: 'doc-a', suggestions: [] }],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          files: [{ path: 'B.md', doc_id: 'doc-b', suggestions: [] }],
        }),
      } as Response);

    const { result } = renderHook(() => useSuggestions(['folder-1', 'folder-2']));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('sets error when fetch fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({}),
    } as Response);

    const { result } = renderHook(() => useSuggestions(['folder-1']));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeTruthy();
    expect(result.current.data).toEqual([]);
  });

  it('fetches all folders in parallel, not sequentially', async () => {
    // Prevents: N folders taking N x latency because each fetch waits for
    // the previous one (page appears stuck when the backend is slow)
    let resolveFirst: (value: unknown) => void = () => {};
    mockFetch
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ files: [] }) } as Response);

    renderHook(() => useSuggestions(['folder-1', 'folder-2']));

    // Both requests must be issued while the first is still unresolved
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    resolveFirst({ ok: true, json: async () => ({ files: [] }) });
  });

  it('passes an abort signal so a hung backend cannot spin forever', async () => {
    // Prevents: infinite loading spinner when the relay hangs (2026-07-02
    // prod incident: /suggestions requests stuck until watchdog restart)
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ files: [] }) } as Response);

    const { result } = renderHook(() => useSuggestions(['folder-1']));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const options = mockFetch.mock.calls[0][1] as RequestInit;
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('keeps data from successful folders when another folder fails', async () => {
    // Prevents: one failing folder wiping out results from healthy folders
    // (e.g. Promise.all rejecting on first error)
    mockFetch
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          files: [{ path: 'B.md', doc_id: 'doc-b', suggestions: [] }],
        }),
      } as Response);

    const { result } = renderHook(() => useSuggestions(['folder-1', 'folder-2']));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data).toHaveLength(1);
    expect(result.current.data[0].path).toBe('B.md');
    expect(result.current.error).toBeNull();
  });

  it('refresh re-fetches data', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ files: [] }),
    } as Response);

    const { result } = renderHook(() => useSuggestions(['folder-1']));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    await act(() => result.current.refresh());
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
