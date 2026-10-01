/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useOpenByPath } from './useOpenByPath';

const mockFetch = vi.fn();
global.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
  localStorage.clear();
});

function response(init: { ok: boolean; status?: number; redirected?: boolean; url?: string }) {
  return Promise.resolve({ status: 200, redirected: false, url: '', ...init });
}

describe('useOpenByPath', () => {
  it('does nothing for a null path', () => {
    const { result } = renderHook(() => useOpenByPath(null));
    expect(result.current).toEqual({ target: null, notFound: false, failed: false });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('asks the relay to open the encoded path, with the share token', async () => {
    localStorage.setItem('lens-share-token', 'tok');
    mockFetch.mockReturnValue(response({
      ok: true, redirected: true, url: 'https://editor.test/c0000002/Lens/Getting-Started.md',
    }));
    const { result } = renderHook(() => useOpenByPath('/Lens/Getting%20Started.md'));

    await waitFor(() => expect(result.current.target).toBe('/c0000002/Lens/Getting-Started.md'));
    expect(result.current.notFound).toBe(false);
    expect(mockFetch).toHaveBeenCalledWith('/open/Lens/Getting%20Started.md', { headers: { 'X-Share-Token': 'tok' } });
  });

  it('reports notFound when the relay has no document at the path', async () => {
    mockFetch.mockReturnValue(response({ ok: false, status: 404 }));
    const { result } = renderHook(() => useOpenByPath('/Lens/Missing.md'));
    await waitFor(() => expect(result.current.notFound).toBe(true));
    expect(result.current.target).toBeNull();
  });

  it('reports notFound when the answer is not a redirect to a doc prefix', async () => {
    mockFetch.mockReturnValue(response({ ok: true, redirected: false, url: 'https://editor.test/open/Lens/x.md' }));
    const { result } = renderHook(() => useOpenByPath('/Lens/x.md'));
    await waitFor(() => expect(result.current.notFound).toBe(true));
  });

  it.each([401, 502])('reports failed, not notFound, on a %i', async (status) => {
    mockFetch.mockReturnValue(response({ ok: false, status }));
    const { result } = renderHook(() => useOpenByPath('/Lens/x.md'));
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.notFound).toBe(false);
  });

  it('reports failed on a network error', async () => {
    mockFetch.mockReturnValue(Promise.reject(new Error('offline')));
    const { result } = renderHook(() => useOpenByPath('/Lens/x.md'));
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.notFound).toBe(false);
  });
});
