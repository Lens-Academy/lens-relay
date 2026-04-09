const USE_LOCAL_RELAY = import.meta.env.VITE_LOCAL_RELAY === 'true';

/**
 * Fetch blob (binary file) content from the relay server as text.
 *
 * In local dev: uses /api/relay/blob/:docId/:hash (proxied, requires share token).
 * In production: uses presigned download URLs with share token auth.
 */
export async function fetchBlobContent(docId: string, hash: string): Promise<string> {
  const shareToken = localStorage.getItem('lens-share-token') || '';

  if (USE_LOCAL_RELAY) {
    const response = await fetch(`/api/relay/blob/${docId}/${hash}`, {
      headers: { 'X-Share-Token': shareToken },
    });
    if (!response.ok) throw new Error(`Failed to fetch blob: ${response.status}`);
    return response.text();
  }

  // Production: get presigned download URL, then fetch via proxy
  const dlRes = await fetch(`/api/relay/f/${docId}/download-url?hash=${hash}`, {
    headers: { 'X-Share-Token': shareToken },
  });
  if (!dlRes.ok) throw new Error(`Failed to get download URL: ${dlRes.status}`);
  const { downloadUrl } = await dlRes.json();

  const contentRes = await fetch(`/api/blob-fetch?url=${encodeURIComponent(downloadUrl)}`);
  if (!contentRes.ok) throw new Error(`Failed to download blob: ${contentRes.status}`);
  return contentRes.text();
}
