interface BlobSummary {
  oid: string;
  size: number;
}

interface DiffViewerProps {
  diff: string;
  isBinary?: boolean;
  beforeBlob?: BlobSummary | null;
  afterBlob?: BlobSummary | null;
}

function blobSummary(blob: BlobSummary | null | undefined) {
  if (!blob) return 'not present';
  return `${blob.oid} (${blob.size} bytes)`;
}

function lineKind(line: string) {
  if (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ')
  ) {
    return 'header';
  }
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'added';
  if (line.startsWith('-')) return 'removed';
  return 'context';
}

function lineClass(kind: string) {
  switch (kind) {
    case 'header':
      return 'bg-gray-100 text-gray-700';
    case 'hunk':
      return 'bg-blue-50 text-blue-800';
    case 'added':
      return 'bg-emerald-50 text-emerald-800';
    case 'removed':
      return 'bg-red-50 text-red-800';
    default:
      return 'text-gray-700';
  }
}

export function DiffViewer({
  diff,
  isBinary = false,
  beforeBlob = null,
  afterBlob = null,
}: DiffViewerProps) {
  if (isBinary) {
    return (
      <div className="rounded-md border border-gray-200 bg-white p-3 text-sm text-gray-700">
        <p className="font-medium text-gray-900">Binary file changed.</p>
        <div className="mt-2 space-y-1 text-xs">
          <div className="break-all font-mono text-gray-700">Before {blobSummary(beforeBlob)}</div>
          <div className="break-all font-mono text-gray-700">After {blobSummary(afterBlob)}</div>
        </div>
      </div>
    );
  }

  if (!diff.trim()) {
    return (
      <div className="rounded-md border border-gray-200 bg-white p-3 text-sm text-gray-500">
        No text diff available.
      </div>
    );
  }

  return (
    <div
      aria-label="Unified diff"
      className="max-h-[520px] min-w-0 overflow-x-auto overflow-y-auto rounded-md border border-gray-200 bg-white py-2 text-xs leading-5"
    >
      {diff.split('\n').map((line, index) => {
        const kind = lineKind(line);
        return (
          <div
            key={index}
            data-line-kind={kind}
            className={`min-w-max whitespace-pre px-3 font-mono ${lineClass(kind)}`}
          >
            {line || ' '}
          </div>
        );
      })}
    </div>
  );
}
