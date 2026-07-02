/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useResolvedDocId } from './useResolvedDocId';

const RELAY_ID = 'a0000000-0000-4000-8000-000000000000';
const FULL_DOC_UUID = 'c0000001-0000-4000-8000-000000000001';
const SHORT_PREFIX = 'c0000001';
const FULL_COMPOUND = `${RELAY_ID}-${FULL_DOC_UUID}`;
const SHORT_COMPOUND = `${RELAY_ID}-${SHORT_PREFIX}`;

// Mock fetch for server-side resolution
const mockFetch = vi.fn();
global.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

describe('useResolvedDocId', () => {
  it('returns null docId for empty input', () => {
    const { result } = renderHook(() =>
      useResolvedDocId('', {})
    );
    expect(result.current).toEqual({ docId: null, notFound: false });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns full compound ID immediately when input is already full-length', () => {
    const { result } = renderHook(() =>
      useResolvedDocId(FULL_COMPOUND, {})
    );
    expect(result.current).toEqual({ docId: FULL_COMPOUND, notFound: false });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('resolves short compound ID from metadata (client-side)', () => {
    const metadata = {
      '/Lens/Welcome.md': { id: FULL_DOC_UUID, type: 'markdown' as const, version: 0 },
    };
    const { result } = renderHook(() =>
      useResolvedDocId(SHORT_COMPOUND, metadata)
    );
    expect(result.current).toEqual({ docId: FULL_COMPOUND, notFound: false });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('resolves short compound ID from server when metadata is empty', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ docId: FULL_COMPOUND }),
    });

    const { result } = renderHook(() =>
      useResolvedDocId(SHORT_COMPOUND, {})
    );

    // Initially null (loading), not yet notFound
    expect(result.current).toEqual({ docId: null, notFound: false });

    await waitFor(() => {
      expect(result.current).toEqual({ docId: FULL_COMPOUND, notFound: false });
    });

    expect(mockFetch).toHaveBeenCalledWith(`/api/relay/doc/resolve/${SHORT_COMPOUND}`, expect.objectContaining({ headers: expect.any(Object) }));
  });

  // Prevents: infinite "Loading document..." spinner for nonexistent doc URLs,
  // where the caller couldn't distinguish "still resolving" from "resolution failed"
  it('reports notFound when server resolution returns non-ok', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    const { result } = renderHook(() =>
      useResolvedDocId(SHORT_COMPOUND, {})
    );

    await waitFor(() => {
      expect(result.current).toEqual({ docId: null, notFound: true });
    });
  });

  // Prevents: "Document Not Found" flash for a valid doc, a stale notFound from
  // a previous URL must reset when the compound ID changes
  it('clears notFound when the compound ID changes to a resolvable one', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ docId: FULL_COMPOUND }),
    });

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useResolvedDocId(id, {}),
      { initialProps: { id: `${RELAY_ID}-deadbeef` } },
    );

    await waitFor(() => {
      expect(result.current.notFound).toBe(true);
    });

    rerender({ id: SHORT_COMPOUND });
    expect(result.current.notFound).toBe(false);

    await waitFor(() => {
      expect(result.current.docId).toBe(FULL_COMPOUND);
    });
  });

  // Prevents: notFound shown even though the doc exists in loaded metadata;
  // client-side resolution must override a stale/failed server answer
  it('client-side resolution wins over a failed server lookup', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const metadata = {
      '/Lens/Welcome.md': { id: FULL_DOC_UUID, type: 'markdown' as const, version: 0 },
    };
    const { result, rerender } = renderHook(
      ({ meta }: { meta: typeof metadata | Record<string, never> }) =>
        useResolvedDocId(SHORT_COMPOUND, meta),
      { initialProps: { meta: {} as Record<string, never> } },
    );

    await waitFor(() => {
      expect(result.current.notFound).toBe(true);
    });

    rerender({ meta: metadata });
    expect(result.current).toEqual({ docId: FULL_COMPOUND, notFound: false });
  });

  // Prevents: transient network failure rendered as a permanent "Document Not
  // Found", only a definitive server answer may declare a doc missing
  it('does not report notFound on network error', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const { result } = renderHook(() =>
      useResolvedDocId(SHORT_COMPOUND, {})
    );

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });

    expect(result.current).toEqual({ docId: null, notFound: false });
  });
});
