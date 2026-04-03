import { useState, useEffect } from 'react';
import { getClientToken } from '../lib/auth';

const USE_LOCAL_RELAY = import.meta.env.VITE_LOCAL_RELAY === 'true';

/**
 * Fetch blob (binary file) content from the relay server.
 * Returns the content as a string, or null while loading, or an error string.
 *
 * In local dev (no auth): uses relay's /blob/:docId/:hash endpoint (proxied via /api/relay).
 * In production: uses relay's presigned download URLs with folder-based auth.
 */
export function useBlobContent(
  docId: string | null,
  hash: string | null,
  folderDocId?: string
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
        let text: string;

        if (USE_LOCAL_RELAY) {
          // Local dev (no auth): use relay's unauthenticated /blob/ endpoint
          const response = await fetch(`/api/relay/blob/${docId}/${hash}`);
          if (!response.ok) {
            throw new Error(`Failed to fetch blob: ${response.status}`);
          }
          text = await response.text();
        } else {
          // Production: use relay's presigned download URLs
          const authDocId = folderDocId || docId;
          const clientToken = await getClientToken(authDocId);
          const baseUrl = clientToken.baseUrl;
          const token = clientToken.token;

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
          const contentResponse = await fetch(download_url);
          if (!contentResponse.ok) {
            throw new Error(`Failed to download blob: ${contentResponse.status}`);
          }
          text = await contentResponse.text();
        }

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
  }, [docId, hash, folderDocId]);

  return { content, loading, error };
}
