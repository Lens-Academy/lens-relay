import { useState, useEffect, useMemo } from 'react';
import type { FolderMetadata } from './useFolderMetadata';
import { compoundIdFromDocUuid } from '../lib/url-utils';

/**
 * Resolve a possibly-short compound doc ID to a full compound doc ID.
 *
 * Strategy:
 * 1. If empty, return null immediately (no doc selected).
 * 2. If already full-length (73 chars), return immediately.
 * 3. Try client-side prefix match against loaded metadata (instant).
 * 4. Fall back to server-side resolution via /api/relay/doc/resolve/ (cold page loads).
 *
 * Returns the full compound ID, or null while resolving / for invalid input.
 */
export function useResolvedDocId(
  compoundId: string,
  metadata: FolderMetadata,
): string | null {
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

  useEffect(() => {
    // Skip server resolution if not needed
    if (!isValid || !isShort || clientResolved) return;

    let cancelled = false;

    fetch(`/api/relay/doc/resolve/${compoundId}`)
      .then((res) => {
        if (!res.ok) return null;
        return res.json();
      })
      .then((data) => {
        if (!cancelled && data?.docId) {
          setServerResolved(data.docId);
        }
      })
      .catch(() => {
        // Resolution failed — leave as null
      });

    return () => {
      cancelled = true;
    };
  }, [isValid, isShort, clientResolved, compoundId]);

  return clientResolved ?? serverResolved;
}
