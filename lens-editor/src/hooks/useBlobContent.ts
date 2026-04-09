import { useState, useEffect } from 'react';
import { fetchBlobContent } from '../lib/fetchBlob';

/**
 * React hook to fetch blob (binary file) content from the relay server.
 * Returns the content as a string, or null while loading, or an error string.
 *
 * Uses fetchBlobContent internally — see src/lib/fetchBlob.ts for details.
 */
export function useBlobContent(
  docId: string | null,
  hash: string | null,
): { content: string | null; loading: boolean; error: string | null } {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!docId || !hash) {
      setContent(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchBlobContent(docId, hash).then(
      (text) => {
        if (!cancelled) {
          setContent(text);
          setLoading(false);
        }
      },
      (err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      },
    );

    return () => { cancelled = true; };
  }, [docId, hash]);

  return { content, loading, error };
}
