import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSuggestions, type FileSuggestions, type SuggestionItem } from '../../hooks/useSuggestions';

interface ReviewPageProps {
  folderIds: string[];
  relayId?: string;
  onAction?: (docId: string, suggestion: SuggestionItem, action: 'accept' | 'reject') => Promise<void>;
  onAcceptAllFile?: (file: FileSuggestions) => Promise<void>;
  onRejectAllFile?: (file: FileSuggestions) => Promise<void>;
  onAcceptAll?: () => Promise<void>;
  onRejectAll?: () => Promise<void>;
}

export function ReviewPage({ folderIds, onAction, onAcceptAllFile, onRejectAllFile, onAcceptAll, onRejectAll }: ReviewPageProps) {
  const { data, loading, error, refresh } = useSuggestions(folderIds);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const navigate = useNavigate();

  const toggleFile = (docId: string) => {
    setExpandedFiles(prev => {
      const next = new Set(prev);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return next;
    });
  };

  const totalSuggestions = data.reduce((sum, f) => sum + f.suggestions.length, 0);

  const navigateToSuggestion = (docId: string, from: number) => {
    const uuid = docId.slice(-36);
    const shortUuid = uuid.slice(0, 8);
    navigate(`/${shortUuid}?pos=${from}`);
  };

  if (loading) {
    return <div className="p-8 text-gray-500">Scanning documents for suggestions...</div>;
  }

  if (error) {
    return <div className="p-8 text-red-600">Error: {error}</div>;
  }

  if (data.length === 0) {
    return (
      <div className="p-8 text-center text-gray-500">
        <p className="text-lg">No pending suggestions</p>
        <p className="text-sm mt-2">All documents are clean.</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Review Suggestions</h1>
            <p className="text-sm text-gray-500 mt-1">
              {totalSuggestions} suggestion{totalSuggestions !== 1 ? 's' : ''} across {data.length} file{data.length !== 1 ? 's' : ''}
            </p>
          </div>
          <div className="flex gap-2">
            {onAcceptAll && (
              <button onClick={onAcceptAll} className="px-3 py-1.5 text-sm bg-green-600 text-white rounded hover:bg-green-700">
                Accept All
              </button>
            )}
            {onRejectAll && (
              <button onClick={onRejectAll} className="px-3 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700">
                Reject All
              </button>
            )}
            <button onClick={refresh} className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50">
              Refresh
            </button>
          </div>
        </div>

        <div className="space-y-2">
          {data.map(file => (
            <FileSection
              key={file.doc_id}
              file={file}
              expanded={expandedFiles.has(file.doc_id)}
              onToggle={() => toggleFile(file.doc_id)}
              onAction={onAction}
              onAcceptAllFile={onAcceptAllFile}
              onRejectAllFile={onRejectAllFile}
              onNavigate={navigateToSuggestion}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function FileSection({ file, expanded, onToggle, onAction, onAcceptAllFile, onRejectAllFile, onNavigate }: {
  file: FileSuggestions;
  expanded: boolean;
  onToggle: () => void;
  onAction?: (docId: string, suggestion: SuggestionItem, action: 'accept' | 'reject') => Promise<void>;
  onAcceptAllFile?: (file: FileSuggestions) => Promise<void>;
  onRejectAllFile?: (file: FileSuggestions) => Promise<void>;
  onNavigate: (docId: string, from: number) => void;
}) {
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors">
        <button onClick={onToggle} className="flex items-center gap-3 flex-1">
          <span className="text-xs text-gray-400">{expanded ? '\u25BC' : '\u25B6'}</span>
          <span className="font-medium text-gray-800">{file.path}</span>
          <span className="text-xs text-gray-500 bg-gray-200 px-2 py-0.5 rounded-full">
            {file.suggestions.length} suggestion{file.suggestions.length !== 1 ? 's' : ''}
          </span>
        </button>
        {expanded && (
          <div className="flex gap-1 ml-2">
            {onAcceptAllFile && (
              <button onClick={() => onAcceptAllFile(file)} title="Accept all in file" className="px-2 py-1 text-xs text-green-700 hover:bg-green-50 rounded">
                Accept All
              </button>
            )}
            {onRejectAllFile && (
              <button onClick={() => onRejectAllFile(file)} title="Reject all in file" className="px-2 py-1 text-xs text-red-700 hover:bg-red-50 rounded">
                Reject All
              </button>
            )}
          </div>
        )}
      </div>
      {expanded && (
        <div className="divide-y divide-gray-100">
          {file.suggestions.map((s, i) => (
            <SuggestionRow
              key={i}
              suggestion={s}
              onAccept={onAction ? () => onAction(file.doc_id, s, 'accept') : undefined}
              onReject={onAction ? () => onAction(file.doc_id, s, 'reject') : undefined}
              onNavigate={() => onNavigate(file.doc_id, s.from)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SuggestionRow({ suggestion, onAccept, onReject, onNavigate }: {
  suggestion: SuggestionItem;
  onAccept?: () => void;
  onReject?: () => void;
  onNavigate: () => void;
}) {
  const typeColors = {
    addition: 'bg-green-100 text-green-800',
    deletion: 'bg-red-100 text-red-800',
    substitution: 'bg-yellow-100 text-yellow-800',
  };

  return (
    <div className="px-4 py-3 flex items-start gap-3">
      <span className={`text-xs px-2 py-0.5 rounded font-medium ${typeColors[suggestion.type]}`}>
        {suggestion.type}
      </span>
      <button onClick={onNavigate} className="flex-1 min-w-0 text-left hover:bg-gray-50 rounded px-1 -mx-1" title="Open in editor">
        <div className="font-mono text-sm">
          <span className="text-gray-400">{suggestion.context_before}</span>
          {suggestion.type === 'substitution' ? (
            <>
              <span className="bg-red-100 line-through">{suggestion.old_content}</span>
              <span className="bg-green-100">{suggestion.new_content}</span>
            </>
          ) : suggestion.type === 'deletion' ? (
            <span className="bg-red-100 line-through">{suggestion.content}</span>
          ) : (
            <span className="bg-green-100">{suggestion.content}</span>
          )}
          <span className="text-gray-400">{suggestion.context_after}</span>
        </div>
        <div className="flex items-center gap-2 mt-1 text-xs text-gray-400">
          {suggestion.author && <span className="bg-gray-100 px-1.5 py-0.5 rounded">{suggestion.author}</span>}
          {suggestion.timestamp && <span>{new Date(suggestion.timestamp).toLocaleString()}</span>}
        </div>
      </button>
      <div className="flex gap-1">
        {onAccept && (
          <button onClick={onAccept} title="Accept" className="p-1 text-green-600 hover:bg-green-50 rounded">
            &#x2713;
          </button>
        )}
        {onReject && (
          <button onClick={onReject} title="Reject" className="p-1 text-red-600 hover:bg-red-50 rounded">
            &#x2717;
          </button>
        )}
      </div>
    </div>
  );
}
