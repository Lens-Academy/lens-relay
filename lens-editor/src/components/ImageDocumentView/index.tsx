import { useState, useEffect } from 'react';

const USE_LOCAL_RELAY = import.meta.env.VITE_LOCAL_RELAY === 'true';
const USE_LOCAL_R2 = USE_LOCAL_RELAY && import.meta.env.VITE_LOCAL_R2 === 'true';

async function resolveImageUrl(docId: string, hash: string): Promise<string> {
  if (USE_LOCAL_RELAY && !USE_LOCAL_R2) {
    return `/api/blob/${docId}/${hash}`;
  }
  const shareToken = localStorage.getItem('lens-share-token') ?? '';
  const dlRes = await fetch(`/api/relay/f/${docId}/download-url?hash=${hash}`, {
    headers: { 'X-Share-Token': shareToken },
  });
  if (!dlRes.ok) throw new Error(`Download URL failed: ${dlRes.status}`);
  const { downloadUrl } = await dlRes.json() as { downloadUrl: string };
  return `/api/blob-fetch?url=${encodeURIComponent(downloadUrl)}`;
}

interface ImageDocumentViewProps {
  docId: string;
  hash: string;
  fileName?: string;
}

export function ImageDocumentView({ docId, hash, fileName }: ImageDocumentViewProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUrl(null);
    setError(null);
    resolveImageUrl(docId, hash).then(setUrl, (err) => setError(String(err)));
  }, [docId, hash]);

  if (error) {
    return (
      <main className="flex-1 flex items-center justify-center bg-gray-50">
        <div className="text-sm text-red-500">Failed to load image: {error}</div>
      </main>
    );
  }

  if (!url) {
    return (
      <main className="flex-1 flex items-center justify-center bg-gray-50">
        <div className="text-sm text-gray-500">Loading image...</div>
      </main>
    );
  }

  return (
    <main className="flex-1 flex flex-col items-center justify-start bg-gray-50 overflow-auto p-8">
      {fileName && (
        <p className="mb-4 text-sm font-medium text-gray-700">{fileName}</p>
      )}
      <img
        src={url}
        alt={fileName ?? 'attachment'}
        className="max-w-full rounded shadow"
        onError={() => setError('Image not found')}
      />
    </main>
  );
}
