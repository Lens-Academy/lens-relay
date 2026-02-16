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
  it('returns null for empty input', () => {
    const { result } = renderHook(() =>
      useResolvedDocId('', {})
    );
    expect(result.current).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns full compound ID immediately when input is already full-length', () => {
    const { result } = renderHook(() =>
      useResolvedDocId(FULL_COMPOUND, {})
    );
    expect(result.current).toBe(FULL_COMPOUND);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('resolves short compound ID from metadata (client-side)', () => {
    const metadata = {
      '/Lens/Welcome.md': { id: FULL_DOC_UUID, type: 'markdown' as const, version: 0 },
    };
    const { result } = renderHook(() =>
      useResolvedDocId(SHORT_COMPOUND, metadata)
    );
    expect(result.current).toBe(FULL_COMPOUND);
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

    // Initially null (loading)
    expect(result.current).toBeNull();

    await waitFor(() => {
      expect(result.current).toBe(FULL_COMPOUND);
    });

    expect(mockFetch).toHaveBeenCalledWith(`/api/relay/doc/resolve/${SHORT_COMPOUND}`);
  });

  it('returns null when server resolution fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    const { result } = renderHook(() =>
      useResolvedDocId(SHORT_COMPOUND, {})
    );

    // Wait for the fetch to complete
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });

    expect(result.current).toBeNull();
  });
});
