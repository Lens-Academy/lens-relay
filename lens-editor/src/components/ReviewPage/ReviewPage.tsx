import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSuggestions, type FileSuggestions, type SuggestionItem } from '../../hooks/useSuggestions';

/** Lightweight inline markdown renderer for context text.
 *  Handles: newlines, headers (as bold), **bold**, *italic*, _italic_ */
function renderMarkdownInline(text: string): ReactNode {
  if (!text) return null;
  return text.split('\n').map((line, lineIdx, lines) => {
    // Strip leading # headers → render as bold
    const headerMatch = line.match(/^(#{1,6})\s+(.*)/);
    const content = headerMatch ? headerMatch[2] : line;
    const isHeader = !!headerMatch;

    // Process inline bold/italic
    const parts: ReactNode[] = [];
    const re = /(\*\*(.+?)\*\*|\*(.+?)\*|_(.+?)_)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let partKey = 0;
    while ((match = re.exec(content)) !== null) {
      if (match.index > lastIndex) {
        parts.push(content.slice(lastIndex, match.index));
      }
      if (match[2]) {
        parts.push(<strong key={partKey++}>{match[2]}</strong>);
      } else {
        parts.push(<em key={partKey++}>{match[3] || match[4]}</em>);
      }
      lastIndex = re.lastIndex;
    }
    if (lastIndex < content.length) {
      parts.push(content.slice(lastIndex));
    }

    const lineContent = isHeader ? <strong key={`h${lineIdx}`}>{parts}</strong> : parts;
    return (
      <span key={lineIdx}>
        {lineContent}
        {lineIdx < lines.length - 1 && <br />}
      </span>
    );
  });
}

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
  const [resolvedMap, setResolvedMap] = useState<Record<number, 'accepted' | 'rejected'>>({});

  const setResolved = (index: number, status: 'accepted' | 'rejected') => {
    setResolvedMap(prev => ({ ...prev, [index]: status }));
  };

  const handleAcceptAll = async () => {
    if (onAcceptAllFile) await onAcceptAllFile(file);
    const all: Record<number, 'accepted' | 'rejected'> = {};
    file.suggestions.forEach((_, i) => { all[i] = 'accepted'; });
    setResolvedMap(prev => ({ ...prev, ...all }));
  };

  const handleRejectAll = async () => {
    if (onRejectAllFile) await onRejectAllFile(file);
    const all: Record<number, 'accepted' | 'rejected'> = {};
    file.suggestions.forEach((_, i) => { all[i] = 'rejected'; });
    setResolvedMap(prev => ({ ...prev, ...all }));
  };

  return (
    <div className="border-2 border-gray-400 rounded-lg overflow-hidden">
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
              <button onClick={handleAcceptAll} title="Accept all in file" className="px-2 py-1 text-xs text-green-700 hover:bg-green-50 rounded">
                Accept All
              </button>
            )}
            {onRejectAllFile && (
              <button onClick={handleRejectAll} title="Reject all in file" className="px-2 py-1 text-xs text-red-700 hover:bg-red-50 rounded">
                Reject All
              </button>
            )}
          </div>
        )}
      </div>
      {expanded && (
        <div className="divide-y divide-gray-300">
          {file.suggestions.map((s, i) => (
            <SuggestionRow
              key={i}
              suggestion={s}
              resolved={resolvedMap[i] ?? null}
              onAccept={onAction ? async () => { await onAction(file.doc_id, s, 'accept'); setResolved(i, 'accepted'); } : undefined}
              onReject={onAction ? async () => { await onAction(file.doc_id, s, 'reject'); setResolved(i, 'rejected'); } : undefined}
              onNavigate={() => onNavigate(file.doc_id, s.from)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SuggestionRow({ suggestion, resolved, onAccept, onReject, onNavigate }: {
  suggestion: SuggestionItem;
  resolved: 'accepted' | 'rejected' | null;
  onAccept?: () => void;
  onReject?: () => void;
  onNavigate: () => void;
}) {
  return (
    <div className={`px-4 py-3 transition-colors duration-300 ${resolved ? 'bg-gray-50' : ''}`}>
      <div className="flex items-center gap-2 mb-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {resolved ? (
            <span className={`text-xs font-medium px-2 py-0.5 rounded ${
              resolved === 'accepted' ? 'text-green-700 bg-green-100' : 'text-red-700 bg-red-100'
            }`}>
              {suggestion.type === 'deletion' ? 'Deletion' : 'Suggestion'} {resolved}
            </span>
          ) : null}
          {suggestion.line > 0 && (
            <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${resolved ? 'text-gray-400 bg-gray-100' : 'text-gray-500 bg-gray-100'}`}>L{suggestion.line}</span>
          )}
          {suggestion.author && (
            <span className={`text-xs px-1.5 py-0.5 rounded ${resolved ? 'text-gray-400 bg-gray-100' : 'text-gray-500 bg-gray-100'}`}>{suggestion.author}</span>
          )}
          {suggestion.timestamp && (
            <span className={`text-xs ${resolved ? 'text-gray-300' : 'text-gray-400'}`}>{new Date(suggestion.timestamp).toLocaleString()}</span>
          )}
        </div>
        <div className="flex gap-1 shrink-0">
          {!resolved && onAccept && (
            <button onClick={onAccept} title="Accept" className="px-2 py-1 text-xs font-medium text-green-700 bg-green-50 hover:bg-green-100 rounded border border-green-200">
              Accept
            </button>
          )}
          {!resolved && onReject && (
            <button onClick={onReject} title="Reject" className="px-2 py-1 text-xs font-medium text-red-700 bg-red-50 hover:bg-red-100 rounded border border-red-200">
              Reject
            </button>
          )}
          <button onClick={onNavigate} title="Open in editor" className="px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 rounded border border-gray-200">
            Open
          </button>
        </div>
      </div>
      <button onClick={onNavigate} className={`w-full text-left hover:bg-gray-50 rounded p-2 -m-1 transition-colors ${resolved ? 'opacity-50' : ''}`} title="Open in editor">
        <div className="text-sm leading-relaxed">
          <span className="text-gray-500">{renderMarkdownInline(suggestion.context_before)}</span>
          {suggestion.type === 'substitution' ? (
            <>
              <span className="bg-red-100 text-red-800 line-through decoration-red-400">{renderMarkdownInline(suggestion.old_content ?? '')}</span>
              <span className="bg-green-100 text-green-800">{renderMarkdownInline(suggestion.new_content ?? '')}</span>
            </>
          ) : suggestion.type === 'deletion' ? (
            <span className="bg-red-100 text-red-800 line-through decoration-red-400">{renderMarkdownInline(suggestion.content)}</span>
          ) : (
            <span className="bg-green-100 text-green-800">{renderMarkdownInline(suggestion.content)}</span>
          )}
          <span className="text-gray-500">{renderMarkdownInline(suggestion.context_after)}</span>
        </div>
      </button>
    </div>
  );
}
