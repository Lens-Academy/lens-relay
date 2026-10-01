import { useState, useEffect } from 'react';

export interface OpenByPath {
  /** Canonical `/{prefix}/{path}` pathname, once the relay has resolved the path. */
  target: string | null;
  /** True when the relay could not resolve the path to a document. */
  notFound: boolean;
}

/**
 * Resolve a prefix-less editor URL (`/Lens/Some Doc.md`, the real vault path,
 * URL-encoded) to the canonical prefixed URL.
 *
 * The relay's GET /open/*path answers with a redirect to `/{prefix}/{path}`;
 * fetch follows it, so the final response URL carries the prefix. Pass null
 * to skip (the URL already resolved as a prefix).
 */
export function useOpenByPath(encodedPath: string | null): OpenByPath {
  // Keyed by path, so an answer for a previous path never leaks into this one
  const [result, setResult] = useState<OpenByPath & { path: string | null }>({
    path: null, target: null, notFound: false,
  });

  useEffect(() => {
    if (!encodedPath) return;

    let cancelled = false;
    const headers: Record<string, string> = {};
    const token = localStorage.getItem('lens-share-token');
    if (token) headers['X-Share-Token'] = token;

    fetch(`/open${encodedPath}`, { headers })
      .then((res) => {
        if (cancelled) return;
        const target = res.ok && res.redirected ? new URL(res.url).pathname : null;
        // Only a redirect to a doc prefix is an answer; anything else (404, 401,
        // a page served without redirect) means we cannot open this path
        if (target && /^\/[0-9a-f]{8}(\/|$)/.test(target)) {
          setResult({ path: encodedPath, target, notFound: false });
        } else {
          setResult({ path: encodedPath, target: null, notFound: true });
        }
      })
      .catch(() => {
        if (!cancelled) setResult({ path: encodedPath, target: null, notFound: true });
      });

    return () => {
      cancelled = true;
    };
  }, [encodedPath]);

  if (!encodedPath || result.path !== encodedPath) return { target: null, notFound: false };
  return { target: result.target, notFound: result.notFound };
}
