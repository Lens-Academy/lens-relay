/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useDocFromUrl } from './useDocFromUrl';
import { RELAY_ID } from '../lib/constants';

const mockFetch = vi.fn();
global.fetch = mockFetch;

const DOC = 'c0000002-0000-4000-8000-000000000002';
const METADATA = { '/Lens/Getting Started.md': { id: DOC, type: 'markdown', version: 0 } } as never;

// The relay: /doc/resolve knows no prefix "cafe"; /open knows one vault path
function relay(url: string) {
  if (url.startsWith('/api/relay/doc/resolve/')) return Promise.resolve({ ok: false, status: 404 });
  if (url === '/open/cafe/Getting%20Started.md' || url === '/open/Lens/Getting%20Started.md') {
    return Promise.resolve({
      ok: true, status: 200, redirected: true,
      url: 'https://editor.test/c0000002/Lens/Getting-Started.md',
    });
  }
  return Promise.resolve({ ok: false, status: 404, redirected: false, url });
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(relay);
});

describe('useDocFromUrl', () => {
  it('resolves a doc prefix without asking for a path', () => {
    const { result } = renderHook(() => useDocFromUrl('c0000002', '/c0000002/Lens/Getting-Started.md', METADATA));
    expect(result.current.docId).toBe(`${RELAY_ID}-${DOC}`);
    expect(result.current.asPath).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('opens a non-hex first segment as a vault path', async () => {
    const { result } = renderHook(() => useDocFromUrl('Lens', '/Lens/Getting%20Started.md', {}));
    expect(result.current.asPath).toBe(true);
    await waitFor(() => expect(result.current.redirectTo).toBe('/c0000002/Lens/Getting-Started.md'));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('tries a hex segment as a prefix first, then as a path', async () => {
    const { result } = renderHook(() => useDocFromUrl('cafe', '/cafe/Getting%20Started.md', {}));
    await waitFor(() => expect(result.current.redirectTo).toBe('/c0000002/Lens/Getting-Started.md'));
    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
      `/api/relay/doc/resolve/${RELAY_ID}-cafe`,
      '/open/cafe/Getting%20Started.md',
    ]);
  });

  it('is notFound when neither the prefix nor the path exists', async () => {
    const { result } = renderHook(() => useDocFromUrl('cafe', '/cafe/Nope.md', {}));
    await waitFor(() => expect(result.current.notFound).toBe(true));
    expect(result.current.redirectTo).toBeNull();
  });
});
