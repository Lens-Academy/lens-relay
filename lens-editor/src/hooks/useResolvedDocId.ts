import { useState, useEffect, useMemo } from 'react';
import type { FolderMetadata } from './useFolderMetadata';
import { compoundIdFromDocUuid } from '../lib/url-utils';

export interface ResolvedDocId {
  /** Full compound doc ID, or null while resolving / when unresolvable. */
  docId: string | null;
  /** True when the server definitively answered that the doc doesn't exist. */
  notFound: boolean;
}

/**
 * Resolve a possibly-short compound doc ID to a full compound doc ID.
 *
 * Strategy:
 * 1. If empty, return null immediately (no doc selected).
 * 2. If already full-length (73 chars), return immediately.
 * 3. Try client-side prefix match against loaded metadata (instant).
 * 4. Fall back to server-side resolution via /api/relay/doc/resolve/ (cold page loads).
 *
 * Returns { docId, notFound }: docId is null while resolving; notFound turns true
 * only when the server answered non-ok, so callers can show a "not found" state
 * instead of loading forever. A later client-side match (metadata load) wins over
 * a failed server lookup; a network error keeps notFound false.
 */
export function useResolvedDocId(
  compoundId: string,
  metadata: FolderMetadata,
): ResolvedDocId {
  // Empty or too-short input — no doc to resolve
  const isValid = compoundId.length > 37; // At minimum: 36-char relay ID + dash + 1 char
  // Full-length compound IDs need no resolution (73 = 36 relay + 1 dash + 36 doc)
  const isShort = isValid && compoundId.length < 73;

  // Extract the short doc UUID prefix (everything after the relay ID + dash)
  const docPrefix = isShort ? compoundId.slice(37) : '';
  const relayId = isValid ? compoundId.slice(0, 36) : '';

  // 1. Client-side resolution from loaded metadata
  const clientResolved = useMemo(() => {
    if (!isValid) return null;
    if (!isShort) return compoundId;

    for (const meta of Object.values(metadata)) {
      if (meta.id.startsWith(docPrefix)) {
        return compoundIdFromDocUuid(relayId, meta.id);
      }
    }
    return null;
  }, [isValid, isShort, compoundId, docPrefix, relayId, metadata]);

  // 2. Server-side fallback for cold page loads
  const [serverResolved, setServerResolved] = useState<string | null>(null);
  const [serverNotFound, setServerNotFound] = useState(false);

  useEffect(() => {
    // A stale answer for a previous compoundId must not leak into this one
    setServerResolved(null);
    setServerNotFound(false);

    // Skip server resolution if not needed
    if (!isValid || !isShort || clientResolved) return;

    let cancelled = false;

    fetch(`/api/relay/doc/resolve/${compoundId}`, {
      headers: (() => {
        const h: Record<string, string> = {};
        const token = localStorage.getItem('lens-share-token');
        if (token) h['X-Share-Token'] = token;
        return h;
      })(),
    })
      .then((res) => {
        if (!res.ok) {
          // Only 404 is a definitive "no such doc" (relay's resolve_doc);
          // 401 (bad token) or 5xx (relay/proxy down) say nothing about the doc
          if (!cancelled && res.status === 404) setServerNotFound(true);
          return null;
        }
        return res.json();
      })
      .then((data) => {
        if (!cancelled && data?.docId) {
          setServerResolved(data.docId);
        }
      })
      .catch(() => {
        // Network error: not a definitive answer, keep the loading state
      });

    return () => {
      cancelled = true;
    };
  }, [isValid, isShort, clientResolved, compoundId]);

  const docId = clientResolved ?? serverResolved;
  return { docId, notFound: !docId && serverNotFound };
}
