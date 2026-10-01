import { useState, useEffect } from 'react';
import { relayHeaders } from '../lib/relay-api';

export interface OpenByPath {
  /** Canonical `/{prefix}/{path}` pathname, once the relay has resolved the path. */
  target: string | null;
  /** True when the relay answered that no document lives at the path. */
  notFound: boolean;
  /** True when the lookup failed for another reason (relay down, token rejected). */
  failed: boolean;
}

const PENDING: OpenByPath = { target: null, notFound: false, failed: false };

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
  const [result, setResult] = useState<OpenByPath & { path: string | null }>({ path: null, ...PENDING });

  useEffect(() => {
    if (!encodedPath) return;
    let cancelled = false;
    const settle = (r: Partial<OpenByPath>) => {
      if (!cancelled) setResult({ path: encodedPath, ...PENDING, ...r });
    };

    fetch(`/open${encodedPath}`, { headers: relayHeaders() })
      .then((res) => {
        const target = res.ok && res.redirected ? new URL(res.url).pathname : null;
        if (target && /^\/[0-9a-f]{8}(\/|$)/.test(target)) settle({ target });
        // Like useResolvedDocId, only a 404 (or an answer that is not a redirect
        // to a doc) says the document doesn't exist; 401/5xx say nothing about it
        else if (res.ok || res.status === 404) settle({ notFound: true });
        else settle({ failed: true });
      })
      .catch(() => settle({ failed: true }));

    return () => {
      cancelled = true;
    };
  }, [encodedPath]);

  if (!encodedPath || result.path !== encodedPath) return PENDING;
  return { target: result.target, notFound: result.notFound, failed: result.failed };
}
