import { useState, useEffect, useMemo, useCallback, memo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useRecentChanges, type FileActivity, type ActivityEvent, type Excerpt } from '../../hooks/useRecentChanges';
import { TIME_QUICK_PRESETS, isFullRange, timeBounds, type TimeRange } from '../ReviewPage/timeFilter';
import { DualRangeSlider } from '../ReviewPage/DualRangeSlider';
import { formatEventAge } from '../../lib/activity';

interface RecentChangesPageProps {
  folderIds: string[];
  folders: { id: string; name: string }[];
}

const DEFAULT_RANGE: TimeRange = { mode: 'range', fromAgo: 86400_000, toAgo: 0, customFrom: '', customTo: '' };
// The server only keeps a week, so "All" here means the full retention window.
const PRESETS = TIME_QUICK_PRESETS.map(p => (p.mode === 'all' ? { ...p, label: '7d (all)' } : p)).filter(p => p.label !== '7d');

function usePageTitle() {
  useEffect(() => {
    const prev = document.title;
    document.title = 'Recent changes — Lens Editor';
    return () => { document.title = prev; };
  }, []);
}

/** `ai:opus-5:luc` → `opus-5 (luc)`; falls back to the display author. */
function displayActor(ev: ActivityEvent): string {
  if (ev.actor.startsWith('ai:')) {
    const [, model, behalf] = ev.actor.split(':');
    const name = model && model !== 'unknown' ? model : 'AI';
    return behalf ? `${name} (${behalf})` : name;
  }
  return ev.author || ev.actor || 'AI';
}

function fileLabel(folderName: string | undefined, path: string) {
  const fullPath = folderName ? `${folderName}${path}` : path;
  const segments = fullPath.split('/').filter(Boolean);
  const filename = (segments.pop() || '').replace(/\.md$/i, '');
  const parentPath = segments.join('/');
  return { filename, parentPath };
}

export function RecentChangesPage({ folderIds, folders }: RecentChangesPageProps) {
  usePageTitle();
  const navigate = useNavigate();
  // The server defaults `since_ms` to its retention window (seven days).
  // `fetchedAt` is the "now" for the time filter (sampled when data arrives,
  // so filtering stays pure).
  const { data, fetchedAt: now, loading, error, refresh } = useRecentChanges(folderIds);

  const [timeRange, setTimeRange] = useState<TimeRange>(DEFAULT_RANGE);
  const [authorFilter, setAuthorFilter] = useState<Set<string>>(new Set());
  const [folderFilter, setFolderFilter] = useState<Set<string>>(new Set());
  // null = untouched: the first file is expanded by default.
  const [expandedOverride, setExpandedFiles] = useState<Set<string> | null>(null);

  const folderName = useMemo(() => new Map(folders.map(f => [f.id, f.name])), [folders]);

  const authors = useMemo(() => {
    const set = new Set<string>();
    for (const f of data) for (const e of f.events) set.add(displayActor(e));
    return [...set].sort();
  }, [data]);

  const filtered = useMemo(() => {
    const [from, to] = timeBounds(timeRange, now);
    return data
      .filter(f => folderFilter.size === 0 || folderFilter.has(f.folder_id))
      .map(f => {
        const events = f.events
          .filter(e => e.ts >= from && e.ts <= to)
          .filter(e => authorFilter.size === 0 || authorFilter.has(displayActor(e)))
          .slice()
          .sort((a, b) => b.ts - a.ts);
        const visible = new Set(events.map(e => e.id));
        // Excerpts are precomputed over all retained events; keep those that
        // still contain a visible change, with filtered-out inserts rendered
        // as plain text and filtered-out removals dropped.
        const excerpts = f.excerpts
          .map(x => ({
            ...x,
            segments: x.segments
              .map(seg => (seg.event_id && !visible.has(seg.event_id) ? (seg.kind === 'delete' ? null : { ...seg, kind: 'text' as const }) : seg))
              .filter((seg): seg is NonNullable<typeof seg> => seg !== null),
          }))
          .filter(x => x.segments.some(seg => seg.kind !== 'text'));
        return { ...f, events, excerpts };
      })
      .filter(f => f.events.length > 0)
      .sort((a, b) => b.events[0].ts - a.events[0].ts);
  }, [data, timeRange, authorFilter, folderFilter, now]);

  const expandedFiles = useMemo(
    () => expandedOverride ?? new Set(filtered.length > 0 ? [filtered[0].doc_id] : []),
    [expandedOverride, filtered],
  );

  const totalEvents = filtered.reduce((n, f) => n + f.events.length, 0);
  const isActive = authorFilter.size > 0 || folderFilter.size > 0 || timeRange.mode !== 'all';

  const toggleSet = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  };

  const toggleFile = useCallback((docId: string) => {
    setExpandedFiles(toggleSet(expandedFiles, docId));
  }, [expandedFiles]);

  const navigateTo = useCallback((docId: string, pos: number, e?: React.MouseEvent) => {
    const shortUuid = docId.slice(-36).slice(0, 8);
    const path = `/${shortUuid}?pos=${pos}`;
    if (e && (e.ctrlKey || e.metaKey)) {
      window.open(`${window.location.origin}${path}`, '_blank');
    } else {
      navigate(path);
    }
  }, [navigate]);

  const chip = (active: boolean) =>
    `px-2 py-0.5 rounded-full transition-colors ${active ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-4 py-6">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
          <h1 className="text-xl font-semibold text-gray-800">Recent changes</h1>
          <div className="flex items-center gap-3 text-xs">
            <Link to="/review" className="text-blue-600 hover:text-blue-800">Pending suggestions →</Link>
            <button onClick={refresh} disabled={loading} className="px-2 py-1 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50">
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </div>
        <p className="text-xs text-gray-500 mb-4">
          Direct AI edits that were applied without review, kept for seven days. Edits that would have replaced human-written text are on the suggestions page instead.
        </p>

        <div className="flex flex-col gap-2 mb-4 text-xs">
          {folders.length >= 2 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-gray-500 font-semibold uppercase tracking-wider mr-0.5">Location</span>
              <button onClick={() => setFolderFilter(new Set())} className={chip(folderFilter.size === 0)}>All</button>
              {folders.map(f => (
                <button key={f.id} onClick={() => setFolderFilter(prev => toggleSet(prev, f.id))} className={chip(folderFilter.has(f.id))}>{f.name}</button>
              ))}
            </div>
          )}
          {authors.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-gray-500 font-semibold uppercase tracking-wider mr-0.5">Author</span>
              <button onClick={() => setAuthorFilter(new Set())} className={chip(authorFilter.size === 0)}>All</button>
              {authors.map(a => (
                <button key={a} onClick={() => setAuthorFilter(prev => toggleSet(prev, a))} className={chip(authorFilter.has(a))}>{a}</button>
              ))}
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-gray-500 font-semibold uppercase tracking-wider mr-0.5">Time</span>
              <button
                onClick={() => setTimeRange({ mode: 'range', fromAgo: 5 * 60_000, toAgo: 0, customFrom: '', customTo: '' })}
                className={chip(timeRange.mode === 'range' && timeRange.fromAgo === 5 * 60_000 && timeRange.toAgo === 0)}
              >
                5m
              </button>
              {PRESETS.map(p => (
                <button
                  key={p.label}
                  onClick={() => setTimeRange({ mode: p.mode, fromAgo: p.fromAgo, toAgo: p.toAgo, customFrom: '', customTo: '' })}
                  className={chip(timeRange.mode === p.mode && (p.mode === 'all' || (timeRange.fromAgo === p.fromAgo && timeRange.toAgo === p.toAgo)))}
                >
                  {p.label}
                </button>
              ))}
              {isActive && (
                <button
                  onClick={() => { setAuthorFilter(new Set()); setFolderFilter(new Set()); setTimeRange({ mode: 'all', fromAgo: Infinity, toAgo: 0, customFrom: '', customTo: '' }); }}
                  className="text-blue-600 hover:text-blue-800 ml-2"
                >
                  Clear All Filters
                </button>
              )}
            </div>
            <DualRangeSlider
              fromAgo={timeRange.fromAgo}
              toAgo={timeRange.toAgo}
              onChange={(fromAgo, toAgo) => setTimeRange({ ...timeRange, mode: isFullRange(fromAgo, toAgo) ? 'all' : 'range', fromAgo, toAgo })}
            />
          </div>
        </div>

        {error && <div className="text-sm text-red-600 mb-3">{error}</div>}

        <div className="flex items-center justify-between text-xs text-gray-500 mb-2">
          <span>{totalEvents} change{totalEvents !== 1 ? 's' : ''} in {filtered.length} file{filtered.length !== 1 ? 's' : ''}</span>
          {filtered.length > 1 && (
            <span className="flex gap-2">
              <button onClick={() => setExpandedFiles(new Set(filtered.map(f => f.doc_id)))} className="hover:text-gray-700">Expand all</button>
              <button onClick={() => setExpandedFiles(new Set())} className="hover:text-gray-700">Collapse all</button>
            </span>
          )}
        </div>

        {!loading && filtered.length === 0 && (
          <div className="text-sm text-gray-500 py-8 text-center">No direct AI edits in this window.</div>
        )}

        <div className="flex flex-col gap-3">
          {filtered.map(file => (
            <FileSection
              key={file.doc_id}
              file={file}
              folderName={folderName.get(file.folder_id)}
              expanded={expandedFiles.has(file.doc_id)}
              onToggle={toggleFile}
              onNavigate={navigateTo}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

const FileSection = memo(function FileSection({ file, folderName, expanded, onToggle, onNavigate }: {
  file: FileActivity;
  folderName?: string;
  expanded: boolean;
  onToggle: (docId: string) => void;
  onNavigate: (docId: string, pos: number, e?: React.MouseEvent) => void;
}) {
  const { filename, parentPath } = fileLabel(folderName, file.path);
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm">
      <div className="flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors">
        <button onClick={() => onToggle(file.doc_id)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
          <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
          <span className="font-medium truncate">
            {parentPath && <span className="text-gray-400 font-normal">{parentPath}/</span>}
            <span className="text-gray-800">{filename}</span>
          </span>
          <span className="text-xs text-gray-400 shrink-0">{file.events.length} change{file.events.length !== 1 ? 's' : ''} · {formatEventAge(file.events[0].ts)}</span>
        </button>
        <button onClick={e => onNavigate(file.doc_id, file.events[0].pos, e)} className="px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 rounded border border-gray-200 shrink-0">Open</button>
      </div>
      {expanded && (
        <div className="divide-y divide-gray-100">
          {file.excerpts.length > 0
            ? file.excerpts.map((x, i) => (
                <ExcerptBlock key={`${x.pos}-${i}`} docId={file.doc_id} excerpt={x} events={file.events} onNavigate={onNavigate} />
              ))
            : file.events.map(ev => (
                <EventRow key={ev.id} docId={file.doc_id} event={ev} onNavigate={onNavigate} />
              ))}
        </div>
      )}
    </div>
  );
});

function formatSkipped(chars: number): string {
  if (chars < 1000) return `${chars} characters`;
  return `${(chars / 1000).toFixed(1)}k characters`;
}

/** One excerpt of the current text with its changes marked in place. */
const ExcerptBlock = memo(function ExcerptBlock({ docId, excerpt, events, onNavigate }: {
  docId: string;
  excerpt: Excerpt;
  events: ActivityEvent[];
  onNavigate: (docId: string, pos: number, e?: React.MouseEvent) => void;
}) {
  const byId = useMemo(() => new Map(events.map(e => [e.id, e])), [events]);
  const changed = excerpt.segments.filter(s => s.event_id).map(s => byId.get(s.event_id!)).filter((e): e is ActivityEvent => !!e);
  const newest = changed.reduce<ActivityEvent | null>((a, e) => (!a || e.ts > a.ts ? e : a), null);
  const actors = [...new Set(changed.map(displayActor))];
  const handleNavigate = (e: React.MouseEvent) => onNavigate(docId, excerpt.pos, e);
  const title = (seg: { event_id?: string }) => {
    const ev = seg.event_id ? byId.get(seg.event_id) : undefined;
    return ev ? `${displayActor(ev)} · ${formatEventAge(ev.ts)}` : undefined;
  };
  return (
    <div className="px-4 py-3">
      {excerpt.skipped_before > 0 && (
        <div className="text-[11px] text-gray-400 mb-2">⋯ {formatSkipped(excerpt.skipped_before)} unchanged</div>
      )}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className="text-xs font-mono px-1.5 py-0.5 rounded text-gray-500 bg-gray-100">L{excerpt.line}</span>
        {actors.map(a => (
          <span key={a} className="text-xs px-1.5 py-0.5 rounded text-gray-500 bg-gray-100">{a}</span>
        ))}
        {newest && <span className="text-xs text-gray-400" title={new Date(newest.ts).toLocaleString()}>{formatEventAge(newest.ts)}</span>}
        <span className="flex-1" />
        <button onClick={handleNavigate} title="Open in editor" className="px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 rounded border border-gray-200">Open</button>
      </div>
      <button onClick={handleNavigate} className="w-full text-left hover:bg-gray-50 rounded p-2 -m-1 transition-colors" title="Open in editor">
        <div className="text-sm leading-relaxed whitespace-pre-wrap break-words">
          {excerpt.segments.map((seg, i) =>
            seg.kind === 'insert' ? (
              <span key={i} className="bg-purple-100 text-purple-900 rounded-sm" title={title(seg)}>{seg.text}</span>
            ) : seg.kind === 'delete' ? (
              <span key={i} className="bg-purple-50 text-purple-700 line-through decoration-purple-400 rounded-sm" title={title(seg)}>{seg.text}</span>
            ) : (
              <span key={i} className="text-gray-600">{seg.text}</span>
            )
          )}
        </div>
      </button>
      {excerpt.skipped_after > 0 && (
        <div className="text-[11px] text-gray-400 mt-2">⋯ {formatSkipped(excerpt.skipped_after)} unchanged</div>
      )}
    </div>
  );
});

const EventRow = memo(function EventRow({ docId, event, onNavigate }: {
  docId: string;
  event: ActivityEvent;
  onNavigate: (docId: string, pos: number, e?: React.MouseEvent) => void;
}) {
  const handleNavigate = (e: React.MouseEvent) => onNavigate(docId, event.pos, e);
  const kindLabel = event.kind === 'insert' ? 'Added' : event.kind === 'delete' ? 'Removed' : 'Replaced';
  const kindClass = 'text-purple-700 bg-purple-100';
  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className={`text-xs font-medium px-2 py-0.5 rounded ${kindClass}`}>{kindLabel}</span>
        <span className="text-xs px-1.5 py-0.5 rounded text-gray-500 bg-gray-100">{displayActor(event)}</span>
        <span className="text-xs text-gray-400" title={new Date(event.ts).toLocaleString()}>{formatEventAge(event.ts)}</span>
        <span className="flex-1" />
        <button onClick={handleNavigate} title="Open in editor" className="px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 rounded border border-gray-200">Open</button>
      </div>
      <button onClick={handleNavigate} className="w-full text-left hover:bg-gray-50 rounded p-2 -m-1 transition-colors" title="Open in editor">
        <div className="text-sm leading-relaxed whitespace-pre-wrap break-words">
          <span className="text-gray-500">{event.ctx_before}</span>
          {event.old && (
            <span className="bg-purple-100 text-purple-800 line-through decoration-purple-400">{event.old}{event.old_truncated ? '…' : ''}</span>
          )}
          {event.new && (
            <span className="bg-purple-100 text-purple-800">{event.new}{event.new_truncated ? '…' : ''}</span>
          )}
          <span className="text-gray-500">{event.ctx_after}</span>
        </div>
      </button>
    </div>
  );
});
