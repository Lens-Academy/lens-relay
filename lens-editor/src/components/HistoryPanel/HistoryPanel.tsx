import { useEffect, useMemo, useRef, useState } from 'react';
import { diffVersions, fetchSessions, fetchVersion, type HistorySession } from '../../lib/history-api';

/**
 * A Lens Edu file's history, over the editor: editing sessions on the left (newest first), the
 * chosen session's last version on the right with what it changed marked. Versions come from
 * the git copy of lens-edu-staging (server/history), so the newest may lag the live text by a
 * minute. Read-only: "Copy text" instead of restore.
 */

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const who = (s: HistorySession) =>
  [...s.authors, ...(s.unknown ? ['unknown'] : [])].join(', ') || 'unknown';

// Move to the next change mark (ins/del) in `box`, wrapping; `at` remembers the last one.
function stepChange(box: HTMLElement | null, at: { current: number }) {
  const marks = box ? [...box.querySelectorAll('ins, del')] : [];
  if (!marks.length) return;
  at.current = (at.current + 1) % marks.length;
  // Scroll only the panel body (scrollIntoView would also move every scrollable ancestor).
  const mark = marks[at.current] as HTMLElement;
  box!.scrollTop += mark.getBoundingClientRect().top - box!.getBoundingClientRect().top - box!.clientHeight / 2;
}

export function HistoryPanel({ path, onClose }: { path: string; onClose: () => void }) {
  // Each result carries the request it answers, so a stale one reads as "loading".
  const [log, setLog] = useState<{ path: string; sessions?: HistorySession[]; error?: string } | null>(null);
  const [pick, setPick] = useState<{ path: string; i: number }>({ path, i: 0 });
  const [version, setVersion] = useState<{ head: string; text?: string | null; base?: string | null; error?: string } | null>(null);
  const [showChanges, setShowChanges] = useState(true);

  useEffect(() => {
    let live = true;
    fetchSessions(path).then(
      sessions => live && setLog({ path, sessions }),
      e => live && setLog({ path, error: String(e.message ?? e) }));
    return () => { live = false; };
  }, [path]);

  const sessions = log?.path === path ? log.sessions ?? null : null;
  const picked = pick.path === path ? pick.i : 0;
  const session = sessions?.[picked];
  useEffect(() => {
    if (!session) return;
    let live = true;
    Promise.all([fetchVersion(path, session.head), session.base ? fetchVersion(path, session.base) : null]).then(
      ([text, base]) => live && setVersion({ head: session.head, text, base }),
      e => live && setVersion({ head: session.head, error: String(e.message ?? e) }));
    return () => { live = false; };
  }, [path, session]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const current = version && session && version.head === session.head ? version : null;
  const texts = current && current.error === undefined ? { text: current.text ?? null, base: current.base ?? null } : null;
  const error = (log?.path === path ? log.error : undefined) ?? current?.error ?? null;
  const setPicked = (i: number) => setPick({ path, i });
  const diff = useMemo(
    () => (current?.text == null || current.error !== undefined ? null : diffVersions(current.base ?? null, current.text)),
    [current],
  );

  // Jump to the first change when a version opens; "Next change" steps through the rest.
  const body = useRef<HTMLDivElement>(null);
  const at = useRef(-1);
  const step = () => stepChange(body.current, at);
  useEffect(() => { at.current = -1; if (showChanges) stepChange(body.current, at); }, [diff, showChanges]);

  return (
    <div className="absolute inset-0 z-30 flex bg-white" role="dialog" aria-label="File history">
      <nav className="w-72 shrink-0 overflow-y-auto border-r border-gray-200 bg-gray-50" aria-label="Versions">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-800">History</h2>
          <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-800" title="Close (Esc)">Close</button>
        </div>
        {!sessions && !error && <p className="p-4 text-sm text-gray-500">Loading…</p>}
        {sessions?.length === 0 && <p className="p-4 text-sm text-gray-500">No saved versions of this file yet.</p>}
        {sessions?.map((s, i) => (
          <div key={s.head}>
            {(i === 0 || day(s.end) !== day(sessions[i - 1].end)) && (
              <div className="px-4 pt-3 pb-1 text-xs font-medium uppercase tracking-wide text-gray-400">{day(s.end)}</div>
            )}
            <button
              onClick={() => setPicked(i)}
              aria-current={i === picked}
              className={`block w-full px-4 py-2 text-left text-sm ${i === picked ? 'bg-blue-50 text-blue-900' : 'text-gray-700 hover:bg-gray-100'}`}
            >
              <div>{time(s.start) === time(s.end) ? time(s.end) : `${time(s.start)} – ${time(s.end)}`}</div>
              <div className="text-xs text-gray-500 truncate" title={who(s)}>{who(s)}</div>
            </button>
          </div>
        ))}
      </nav>
      <section className="flex-1 min-w-0 flex flex-col">
        {error && <p className="m-4 rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        {session && (
          <header className="flex flex-wrap items-center gap-x-4 gap-y-1 px-6 py-3 border-b border-gray-200 text-sm">
            <span className="font-medium text-gray-800">{day(session.end)}, {time(session.end)}</span>
            <span className="text-gray-500">{who(session)}</span>
            {diff && <span className="text-gray-500"><span className="text-green-700">+{diff.added}</span> <span className="text-red-700">−{diff.removed}</span> words</span>}
            <label className="ml-auto flex items-center gap-1 text-gray-600">
              <input type="checkbox" checked={showChanges} onChange={e => setShowChanges(e.target.checked)} /> Show changes
            </label>
            {diff && showChanges && diff.added + diff.removed > 0 && (
              <button className="text-blue-700 hover:underline" onClick={step}>Next change</button>
            )}
            {texts?.text != null && (
              <button className="text-blue-700 hover:underline" onClick={() => navigator.clipboard.writeText(texts.text!)}>Copy text</button>
            )}
          </header>
        )}
        <div ref={body} className="flex-1 overflow-y-auto px-6 py-4">
          {session && !texts && !error && <p className="text-sm text-gray-500">Loading version…</p>}
          {texts && texts.text === null && <p className="text-sm text-gray-500">The file was deleted or moved in this session.</p>}
          {diff && (
            <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-gray-800 max-w-[80ch]">
              {showChanges
                ? diff.parts.map((p, i) =>
                    p.kind === 'same' ? <span key={i}>{p.text}</span>
                    : p.kind === 'added' ? <ins key={i} className="bg-green-100 text-green-900 no-underline">{p.text}</ins>
                    : <del key={i} className="bg-red-100 text-red-800">{p.text}</del>)
                : texts!.text}
            </pre>
          )}
        </div>
      </section>
    </div>
  );
}

/** Header button that opens the panel; shown only for files history covers. */
export function HistoryButton({ open, onClick, iconOnly = false }: { open: boolean; onClick: () => void; iconOnly?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Version history"
      aria-label="Version history"
      aria-pressed={open}
      className={`flex items-center gap-1.5 px-2 py-1 rounded-md border ${open ? 'border-blue-300 bg-blue-50 text-blue-800' : 'border-gray-300 bg-white hover:bg-gray-50 text-gray-600'}`}
    >
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4" aria-hidden="true">
        <path d="M3.5 10a6.5 6.5 0 1 0 1.9-4.6M3.5 3.5v3h3" />
        <path d="M10 6.5V10l2.5 1.5" />
      </svg>
      {!iconOnly && <span className="text-xs">History</span>}
    </button>
  );
}
