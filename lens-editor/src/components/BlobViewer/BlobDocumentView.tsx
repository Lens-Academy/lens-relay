import { useBlobContent } from '../../hooks/useBlobContent';
import { BlobViewer } from './BlobViewer';

interface BlobDocumentViewProps {
  docId: string;        // compound doc ID (relay_id-uuid)
  hash: string;         // file hash from filemeta
  folderDocId: string;  // folder doc ID (for auth)
  fileName?: string;    // display name
}

export function BlobDocumentView({ docId, hash, folderDocId, fileName }: BlobDocumentViewProps) {
  const { content, loading, error } = useBlobContent(docId, hash, folderDocId);

  if (loading || content === null) {
    return (
      <main className="flex-1 flex items-center justify-center bg-gray-50">
        <div className="text-sm text-gray-500">Loading file...</div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="flex-1 flex items-center justify-center bg-gray-50">
        <div className="text-sm text-red-500">Error loading file: {error}</div>
      </main>
    );
  }

  return (
    <main className="h-full flex flex-col min-h-0 bg-white">
      {fileName && (
        <div className="max-w-[700px] mx-auto w-full">
          <div className="px-6 pt-5 pb-1">
            <h1 className="text-lg font-semibold text-gray-900">{fileName}</h1>
          </div>
          <div className="mx-6 border-b border-gray-200" />
          <div className="mx-6 mt-2 px-3 py-1.5 text-xs text-amber-700 bg-amber-50 rounded-md border border-amber-200">
            JSON is read-only in Lens Editor. Edit via Lens Relay MCP.
          </div>
        </div>
      )}
      <div className="flex-1 min-h-0 relative">
        <BlobViewer content={content} fileName={fileName} />
      </div>
    </main>
  );
}
