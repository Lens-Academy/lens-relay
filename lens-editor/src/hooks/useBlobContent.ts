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
          // Production: proxy through /api/relay to avoid CORS.
          // The proxy injects the server token, so we just need the share token.
          const shareToken = localStorage.getItem('lens-share-token') || '';
          const authDocId = folderDocId || docId;

          // Step 1: Get presigned download URL via proxy
          // Relay route is /f/:doc_id/download-url (server token from proxy handles auth)
          const downloadUrlResponse = await fetch(
            `/api/relay/f/${docId}/download-url?hash=${hash}`,
            {
              headers: { 'X-Share-Token': shareToken },
            }
          );

          if (!downloadUrlResponse.ok) {
            throw new Error(`Failed to get download URL: ${downloadUrlResponse.status}`);
          }

          const { downloadUrl: download_url } = await downloadUrlResponse.json();

          // Step 2: Fetch the actual blob content.
          // The download URL may be a presigned R2 URL (cross-origin, no CORS issue
          // since presigned URLs allow anonymous access) or a local relay endpoint.
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
