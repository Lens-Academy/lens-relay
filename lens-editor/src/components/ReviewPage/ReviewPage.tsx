import { useState, useMemo, type ReactNode } from 'react';
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

interface FolderInfo {
  id: string;
  name: string;
}

interface ReviewPageProps {
  folderIds: string[];
  folders?: FolderInfo[];
  relayId?: string;
  onAction?: (docId: string, suggestion: SuggestionItem, action: 'accept' | 'reject') => Promise<void>;
  onAcceptAllFile?: (file: FileSuggestions) => Promise<void>;
  onRejectAllFile?: (file: FileSuggestions) => Promise<void>;
  onAcceptAll?: () => Promise<void>;
  onRejectAll?: () => Promise<void>;
}

const TIME_PRESETS = [
  { value: 'all', label: 'All' },
  { value: 'hour', label: '1h' },
  { value: '24h', label: '24h' },
  { value: 'week', label: '7d' },
  { value: 'custom', label: 'Custom' },
] as const;

const TIME_THRESHOLDS: Record<string, number> = {
  hour: 3600_000,
  '24h': 86400_000,
  week: 604800_000,
  all: 0,
};

interface LocationEntry {
  key: string;        // folderId or folderId:/prefix
  label: string;      // display name
  isSubfolder: boolean;
  folderId: string;
}

function FilterBar({ authors, locations, authorFilter, timeFilter, customFrom, customTo, locationFilter, onAuthorToggle, onTimeFilter, onCustomFrom, onCustomTo, onLocationToggle, onClear }: {
  authors: string[];
  locations: LocationEntry[];
  authorFilter: Set<string>;
  timeFilter: string;
  customFrom: string;
  customTo: string;
  locationFilter: Set<string>;
  onAuthorToggle: (author: string) => void;
  onTimeFilter: (value: string) => void;
  onCustomFrom: (value: string) => void;
  onCustomTo: (value: string) => void;
  onLocationToggle: (key: string) => void;
  onClear: () => void;
}) {
  const isActive = authorFilter.size > 0 || timeFilter !== 'all' || locationFilter.size > 0;

  return (
    <div className="flex flex-wrap items-center gap-3 mb-4 text-xs">
      {locations.length >= 2 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-gray-400 uppercase tracking-wide mr-0.5">Location</span>
          {locations.map(loc => (
            <button
              key={loc.key}
              onClick={() => onLocationToggle(loc.key)}
              className={`px-2 py-0.5 rounded-full transition-colors ${
                locationFilter.has(loc.key)
                  ? 'bg-blue-100 text-blue-700'
                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
              } ${loc.isSubfolder ? 'ml-1' : ''}`}
            >
              {loc.label}
            </button>
          ))}
        </div>
      )}
      {authors.length > 0 && (
        <div className="flex items-center gap-1.5">
          <span className="text-gray-400 uppercase tracking-wide mr-0.5">Author</span>
          {authors.map(a => (
            <button
              key={a}
              onClick={() => onAuthorToggle(a)}
              className={`px-2 py-0.5 rounded-full transition-colors ${
                authorFilter.has(a)
                  ? 'bg-blue-100 text-blue-700'
                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
              }`}
            >
              {a}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-gray-400 uppercase tracking-wide mr-0.5">Time</span>
        {TIME_PRESETS.map(p => (
          <button
            key={p.value}
            onClick={() => onTimeFilter(p.value)}
            className={`px-2 py-0.5 rounded-full transition-colors ${
              timeFilter === p.value
                ? 'bg-blue-100 text-blue-700'
                : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
            }`}
          >
            {p.label}
          </button>
        ))}
        {timeFilter === 'custom' && (
          <div className="flex items-center gap-1">
            <input
              type="datetime-local"
              value={customFrom}
              onChange={e => onCustomFrom(e.target.value)}
              className="px-1.5 py-0.5 border border-gray-300 rounded text-xs bg-white text-gray-700"
              placeholder="From"
            />
            <span className="text-gray-400">&mdash;</span>
            <input
              type="datetime-local"
              value={customTo}
              onChange={e => onCustomTo(e.target.value)}
              className="px-1.5 py-0.5 border border-gray-300 rounded text-xs bg-white text-gray-700"
              placeholder="To"
            />
          </div>
        )}
      </div>
      {isActive && (
        <button onClick={onClear} className="text-blue-600 hover:text-blue-800 ml-1">
          Clear filters
        </button>
      )}
    </div>
  );
}

export function ReviewPage({ folderIds, folders, onAction, onAcceptAllFile, onRejectAllFile, onAcceptAll, onRejectAll }: ReviewPageProps) {
  const { data, loading, error, refresh } = useSuggestions(folderIds);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const navigate = useNavigate();

  // Filter state
  const [authorFilter, setAuthorFilter] = useState<Set<string>>(new Set());
  const [timeFilter, setTimeFilter] = useState('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [locationFilter, setLocationFilter] = useState<Set<string>>(new Set());

  const toggleSet = (prev: Set<string>, value: string) => {
    const next = new Set(prev);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  // Map folder_id -> folder name for display
  const folderNameMap = useMemo(() => {
    const map = new Map<string, string>();
    if (folders) {
      for (const f of folders) map.set(f.id, f.name);
    }
    return map;
  }, [folders]);

  // Derive unique authors from data
  const uniqueAuthors = useMemo(() => {
    const authors = new Set<string>();
    for (const file of data) {
      for (const s of file.suggestions) {
        if (s.author) authors.add(s.author);
      }
    }
    return Array.from(authors).sort();
  }, [data]);

  // Derive location entries from data + folders
  const locations = useMemo<LocationEntry[]>(() => {
    if (!folders || folders.length < 2) return [];
    const folderMap = new Map(folders.map(f => [f.id, f.name]));

    // Collect prefixes per folder
    const prefixesByFolder = new Map<string, Set<string>>();
    for (const file of data) {
      const folderId = file.folder_id;
      if (!folderMap.has(folderId)) continue;
      if (!prefixesByFolder.has(folderId)) prefixesByFolder.set(folderId, new Set());
      const lastSlash = file.path.lastIndexOf('/');
      if (lastSlash > 0) {
        prefixesByFolder.get(folderId)!.add(file.path.slice(0, lastSlash));
      }
    }

    const entries: LocationEntry[] = [];
    for (const folder of folders) {
      entries.push({
        key: folder.id,
        label: folder.name,
        isSubfolder: false,
        folderId: folder.id,
      });
      const prefixes = prefixesByFolder.get(folder.id);
      if (prefixes && prefixes.size > 0) {
        const sorted = Array.from(prefixes).sort();
        for (const prefix of sorted) {
          entries.push({
            key: `${folder.id}:${prefix}`,
            label: `${folder.name} / ${prefix.replace(/^\//, '')}`,
            isSubfolder: true,
            folderId: folder.id,
          });
        }
      }
    }
    return entries;
  }, [data, folders]);

  // Filtering pipeline
  const filteredData = useMemo(() => {
    const now = Date.now();
    const hasTimeFilter = timeFilter !== 'all';

    let getTimeRange: () => [number, number];
    if (timeFilter === 'custom') {
      getTimeRange = () => [
        customFrom ? new Date(customFrom).getTime() : 0,
        customTo ? new Date(customTo).getTime() : Infinity,
      ];
    } else {
      const threshold = now - (TIME_THRESHOLDS[timeFilter] ?? 0);
      getTimeRange = () => [threshold, Infinity];
    }

    return data
      .filter(file => {
        if (locationFilter.size === 0) return true;
        // Check if any selected location matches this file
        if (locationFilter.has(file.folder_id)) return true;
        // Check subfolder matches
        for (const key of locationFilter) {
          const colonIdx = key.indexOf(':');
          if (colonIdx === -1) continue;
          const folderId = key.slice(0, colonIdx);
          const prefix = key.slice(colonIdx + 1);
          if (file.folder_id === folderId && file.path.startsWith(prefix + '/')) return true;
          // Also match files directly in the prefix directory
          if (file.folder_id === folderId) {
            const lastSlash = file.path.lastIndexOf('/');
            const fileDir = lastSlash > 0 ? file.path.slice(0, lastSlash) : '';
            if (fileDir === prefix) return true;
          }
        }
        return false;
      })
      .map(file => {
        if (authorFilter.size === 0 && !hasTimeFilter) return file;
        const [fromTime, toTime] = getTimeRange();
        const filtered = file.suggestions.filter(s => {
          if (authorFilter.size > 0 && (!s.author || !authorFilter.has(s.author))) return false;
          if (hasTimeFilter && (!s.timestamp || s.timestamp < fromTime || s.timestamp > toTime)) return false;
          return true;
        });
        return { ...file, suggestions: filtered };
      })
      .filter(file => file.suggestions.length > 0);
  }, [data, authorFilter, timeFilter, customFrom, customTo, locationFilter]);

  const isFiltered = authorFilter.size > 0 || timeFilter !== 'all' || locationFilter.size > 0;
  const totalFiltered = filteredData.reduce((sum, f) => sum + f.suggestions.length, 0);
  const totalAll = data.reduce((sum, f) => sum + f.suggestions.length, 0);

  const clearFilters = () => {
    setAuthorFilter(new Set());
    setTimeFilter('all');
    setCustomFrom('');
    setCustomTo('');
    setLocationFilter(new Set());
  };

  const toggleFile = (docId: string) => {
    setExpandedFiles(prev => {
      const next = new Set(prev);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return next;
    });
  };

  const expandAll = () => {
    setExpandedFiles(new Set(filteredData.map(f => f.doc_id)));
  };

  const collapseAll = () => {
    setExpandedFiles(new Set());
  };

  const navigateToSuggestion = (docId: string, from: number) => {
    const uuid = docId.slice(-36);
    const shortUuid = uuid.slice(0, 8);
    navigate(`/${shortUuid}?pos=${from}`);
  };

  // Global accept/reject operate on filtered data
  const handleAcceptAllFiltered = onAcceptAllFile ? async () => {
    for (const file of filteredData) {
      await onAcceptAllFile(file);
    }
  } : onAcceptAll;

  const handleRejectAllFiltered = onRejectAllFile ? async () => {
    for (const file of filteredData) {
      await onRejectAllFile(file);
    }
  } : onRejectAll;

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
              {isFiltered
                ? `${totalFiltered} of ${totalAll} suggestion${totalAll !== 1 ? 's' : ''} across ${filteredData.length} of ${data.length} file${data.length !== 1 ? 's' : ''}`
                : `${totalAll} suggestion${totalAll !== 1 ? 's' : ''} across ${data.length} file${data.length !== 1 ? 's' : ''}`
              }
            </p>
          </div>
          <div className="flex gap-2">
            {handleAcceptAllFiltered && (
              <button onClick={handleAcceptAllFiltered} className="px-3 py-1.5 text-sm bg-green-600 text-white rounded hover:bg-green-700">
                Accept All
              </button>
            )}
            {handleRejectAllFiltered && (
              <button onClick={handleRejectAllFiltered} className="px-3 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700">
                Reject All
              </button>
            )}
            <button onClick={expandAll} className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50">
              Expand All
            </button>
            <button onClick={collapseAll} className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50">
              Collapse All
            </button>
            <button onClick={refresh} className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50">
              Refresh
            </button>
          </div>
        </div>

        <FilterBar
          authors={uniqueAuthors}
          locations={locations}
          authorFilter={authorFilter}
          timeFilter={timeFilter}
          customFrom={customFrom}
          customTo={customTo}
          locationFilter={locationFilter}
          onAuthorToggle={a => setAuthorFilter(prev => toggleSet(prev, a))}
          onTimeFilter={setTimeFilter}
          onCustomFrom={setCustomFrom}
          onCustomTo={setCustomTo}
          onLocationToggle={key => setLocationFilter(prev => toggleSet(prev, key))}
          onClear={clearFilters}
        />

        {filteredData.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <p className="text-sm">No suggestions match the current filters.</p>
            <button onClick={clearFilters} className="text-sm text-blue-600 hover:text-blue-800 mt-2">Clear filters</button>
          </div>
        ) : (
          <div className="space-y-2">
            {filteredData.map(file => (
              <FileSection
                key={file.doc_id}
                file={file}
                folderName={folderNameMap.get(file.folder_id)}
                expanded={expandedFiles.has(file.doc_id)}
                onToggle={() => toggleFile(file.doc_id)}
                onAction={onAction}
                onAcceptAllFile={onAcceptAllFile}
                onRejectAllFile={onRejectAllFile}
                onNavigate={navigateToSuggestion}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FileSection({ file, folderName, expanded, onToggle, onAction, onAcceptAllFile, onRejectAllFile, onNavigate }: {
  file: FileSuggestions;
  folderName?: string;
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
          <span className="font-medium">
            {(() => {
              const fullPath = folderName ? `${folderName}${file.path}` : file.path;
              const segments = fullPath.split('/').filter(Boolean);
              const filename = (segments.pop() || '').replace(/\.md$/i, '');
              const parentPath = segments.join('/');
              return (
                <>
                  {parentPath && <span className="text-gray-400 font-normal">{parentPath}/</span>}
                  <span className="text-gray-800">{filename}</span>
                </>
              );
            })()}
          </span>
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
