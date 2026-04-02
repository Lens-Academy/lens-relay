import { useState, useEffect } from 'react';
import { getClientToken } from '../lib/auth';

/**
 * Fetch blob (binary file) content from the relay server.
 * Returns the content as a string, or null while loading, or an error string.
 */
export function useBlobContent(
  docId: string | null,
  hash: string | null
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

    (async () => {
      try {
        // Get auth token to access relay
        const clientToken = await getClientToken(docId);
        const baseUrl = clientToken.baseUrl;
        const token = clientToken.token;

        // Get download URL
        const downloadUrlResponse = await fetch(
          `${baseUrl}/f/${docId}/download-url?hash=${hash}`,
          {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          }
        );

        if (!downloadUrlResponse.ok) {
          throw new Error(`Failed to get download URL: ${downloadUrlResponse.status}`);
        }

        const { download_url } = await downloadUrlResponse.json();

        // Fetch the actual blob content
        const contentResponse = await fetch(download_url);
        if (!contentResponse.ok) {
          throw new Error(`Failed to download blob: ${contentResponse.status}`);
        }

        const text = await contentResponse.text();
        if (!cancelled) {
          setContent(text);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [docId, hash]);

  return { content, loading, error };
}
