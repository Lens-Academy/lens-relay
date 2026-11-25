import { useEffect, useMemo, useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import {
  authorLabel, diffVersions, fetchSessions, fetchVersion, previewText, versionPair, type HistorySession,
} from '../../lib/history-api';
import { HistoryDoc } from './HistoryDoc';
import { changeOffsets, scrollToOffset } from '../../lib/history-doc';

/**
 * A Lens Edu file's history, over the editor. Left: editing sessions, newest first, each with how
 * many places it changed and a preview of the first; a session opens into its separate saves, as
 * in Google Docs. Right: the chosen version rendered as the editor renders it, with what changed
 * marked. Versions come from the git copy of lens-edu-staging (server/history), so the newest may
 * lag the live text by a minute. Read-only: "Copy text" instead of restore.
 */

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
// Authors git-sync recorded; commits with none show no author line rather than "unknown".
const who = (authors: string[]) => authors.map(authorLabel).join(', ');

function Preview({ s }: { s: HistorySession }) {
  if (!s.summary) return <div className="text-xs text-[var(--lens-text-secondary)]">File deleted or moved</div>;
  if (!s.summary.first) return <div className="text-xs text-[var(--lens-text-tertiary)]">Spacing only</div>;
  const n = s.summary.changes;
  return (
    <div className="text-xs text-[var(--lens-text-secondary)] truncate" title={previewText(s.summary.first)}>
      <span className="text-[var(--lens-text-secondary)]">{n} {n === 1 ? 'change' : 'changes'}</span> · {previewText(s.summary.first)}
    </div>
  );
}

export function HistoryPanel({ path, onClose }: { path: string; onClose: () => void }) {
  // Each result carries the request it answers, so a stale one reads as "loading".
  const [log, setLog] = useState<{ path: string; sessions?: HistorySession[]; asOf?: number; error?: string } | null>(null);
  // j: a save inside session i, or null for the whole session.
  const [pick, setPick] = useState<{ path: string; i: number; j: number | null }>({ path, i: 0, j: null });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [version, setVersion] = useState<{ key: string; text?: string | null; base?: string | null; error?: string } | null>(null);
  const [showChanges, setShowChanges] = useState(true);

  useEffect(() => {
    let live = true;
    fetchSessions(path).then(
      r => live && setLog({ path, sessions: r.sessions, asOf: r.asOf }),
      e => live && setLog({ path, error: String(e.message ?? e) }));
    return () => { live = false; };
  }, [path]);

  const sessions = log?.path === path ? log.sessions ?? null : null;
  const asOf = log?.path === path ? log.asOf : undefined;
  const { i: picked, j: pickedSave } = pick.path === path ? pick : { i: 0, j: null };
  const session = sessions?.[picked];
  const pair = session ? versionPair(session, pickedSave) : null;
  const pairKey = pair ? `${pair.base}..${pair.head}` : '';
  useEffect(() => {
    if (!pair) return;
    let live = true;
    Promise.all([fetchVersion(path, pair.head), pair.base ? fetchVersion(path, pair.base) : null]).then(
      ([text, base]) => live && setVersion({ key: pairKey, text, base }),
      e => live && setVersion({ key: pairKey, error: String(e.message ?? e) }));
    return () => { live = false; };
    // pairKey names the pair; the object itself is rebuilt every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, pairKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const current = version && version.key === pairKey ? version : null;
  const text = current && current.error === undefined ? current.text ?? null : undefined;
  const error = (log?.path === path ? log.error : undefined) ?? current?.error ?? null;
  const diff = useMemo(
    () => (current?.text == null || current.error !== undefined ? null : diffVersions(current.base ?? null, current.text)),
    [current],
  );
  const offsets = useMemo(() => (diff ? changeOffsets(diff.parts) : []), [diff]);

  // Open at the first change; "Next change" steps through the rest. CodeMirror draws only what is
  // on screen, so steps go by text offset, not by searching the page for marks.
  const view = useRef<EditorView | null>(null);
  const at = useRef(0);
  const step = () => {
    if (!offsets.length) return;
    at.current = (at.current + 1) % offsets.length;
    scrollToOffset(view.current, offsets[at.current]);
  };
  useEffect(() => {
    at.current = 0;
    if (!showChanges || !offsets.length) return;
    const id = requestAnimationFrame(() => scrollToOffset(view.current, offsets[0]));
    return () => cancelAnimationFrame(id);
  }, [offsets, showChanges]);

  const choose = (i: number, j: number | null) => setPick({ path, i, j });
  const toggle = (head: string) => setOpen(o => {
    const n = new Set(o);
    if (n.has(head)) n.delete(head); else n.add(head);
    return n;
  });

  return (
    <div className="absolute inset-0 z-30 flex bg-[var(--lens-page-bg)]" role="dialog" aria-label="File history">
      <nav className="w-80 shrink-0 overflow-y-auto border-r border-[var(--lens-border)] bg-[var(--lens-fm-bg)]" aria-label="Versions">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--lens-border)]">
          <h2 className="text-sm font-semibold text-[var(--lens-text)]">History</h2>
          <button onClick={onClose} className="text-sm text-[var(--lens-text-secondary)] hover:text-[var(--lens-text)]" title="Close (Esc)">Close</button>
        </div>
        {asOf !== undefined && (
          <p className="px-4 pt-2 text-xs text-[var(--lens-text-tertiary)]" title="Versions come from the git copy of Lens Edu, saved about every 30 seconds">
            Saved versions up to {day(asOf)}, {time(asOf)}
          </p>
        )}
        {!sessions && !error && <p className="p-4 text-sm text-[var(--lens-text-secondary)]">Loading…</p>}
        {sessions?.length === 0 && <p className="p-4 text-sm text-[var(--lens-text-secondary)]">No saved versions of this file yet.</p>}
        {sessions?.map((s, i) => {
          const many = s.versions.length > 1;
          const expanded = many && open.has(s.head);
          const active = i === picked && pickedSave === null;
          return (
            <div key={s.head}>
              {(i === 0 || day(s.end) !== day(sessions[i - 1].end)) && (
                <div className="px-4 pt-3 pb-1 text-xs font-medium uppercase tracking-wide text-[var(--lens-text-tertiary)]">{day(s.end)}</div>
              )}
              <div className={`flex items-start ${active ? 'bg-[var(--lens-bg-blue)]' : 'hover:bg-[var(--lens-fm-hover)]'}`}>
                <button
                  onClick={() => many && toggle(s.head)}
                  aria-label={expanded ? 'Hide separate saves' : 'Show separate saves'}
                  aria-expanded={many ? expanded : undefined}
                  disabled={!many}
                  className="w-6 shrink-0 pt-2.5 pl-2 text-[var(--lens-text-tertiary)] hover:text-[var(--lens-text)] disabled:invisible"
                >
                  <svg viewBox="0 0 20 20" fill="currentColor" className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`} aria-hidden="true">
                    <path d="M7 4l7 6-7 6z" />
                  </svg>
                </button>
                <button
                  onClick={() => choose(i, null)}
                  aria-current={active}
                  className={`min-w-0 flex-1 py-2 pr-4 text-left text-sm ${active ? 'text-[var(--lens-text)]' : 'text-[var(--lens-text)]'}`}
                >
                  <div>{time(s.start) === time(s.end) ? time(s.end) : `${time(s.start)} – ${time(s.end)}`}</div>
                  <Preview s={s} />
                  {who(s.authors) && <div className="text-xs text-[var(--lens-text-secondary)] truncate" title={who(s.authors)}>{who(s.authors)}</div>}
                </button>
              </div>
              {expanded && s.versions.map((v, j) => {
                const on = i === picked && pickedSave === j;
                return (
                  <button
                    key={v.sha}
                    onClick={() => choose(i, j)}
                    aria-current={on}
                    className={`block w-full py-1 pl-10 pr-4 text-left text-xs ${on ? 'bg-[var(--lens-bg-blue)] text-[var(--lens-text)]' : 'text-[var(--lens-text-secondary)] hover:bg-[var(--lens-fm-hover)]'}`}
                  >
                    {new Date(v.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    {v.author && <span className="text-[var(--lens-text-secondary)]"> · {authorLabel(v.author)}</span>}
                  </button>
                );
              })}
            </div>
          );
        })}
      </nav>
      <section className="flex-1 min-w-0 flex flex-col">
        {error && <p className="m-4 rounded bg-[var(--lens-bg-red)] p-3 text-sm text-[var(--lens-deletion-text)]">{error}</p>}
        {pair && (
          <header className="flex flex-wrap items-center gap-x-4 gap-y-1 px-6 py-3 border-b border-[var(--lens-border)] text-sm">
            <span className="font-medium text-[var(--lens-text)]">{day(pair.ts)}, {time(pair.ts)}</span>
            {who(pair.authors) && <span className="text-[var(--lens-text-secondary)]">{who(pair.authors)}</span>}
            {diff && <span className="text-[var(--lens-text-secondary)]"><span className="text-[var(--lens-addition-text)]">+{diff.added}</span> <span className="text-[var(--lens-deletion-text)]">−{diff.removed}</span> words</span>}
            <label className="ml-auto flex items-center gap-1 text-[var(--lens-text-secondary)]">
              <input type="checkbox" checked={showChanges} onChange={e => setShowChanges(e.target.checked)} /> Show changes
            </label>
            {showChanges && offsets.length > 1 && (
              <button className="text-[var(--lens-blue)] hover:underline" onClick={step}>Next change</button>
            )}
            {typeof text === 'string' && (
              <button className="text-[var(--lens-blue)] hover:underline" onClick={() => navigator.clipboard.writeText(text)}>Copy text</button>
            )}
          </header>
        )}
        <div className="flex-1 min-h-0">
          {pair && current === null && !error && <p className="px-6 py-4 text-sm text-[var(--lens-text-secondary)]">Loading version…</p>}
          {text === null && <p className="px-6 py-4 text-sm text-[var(--lens-text-secondary)]">The file was deleted or moved here.</p>}
          {diff && typeof text === 'string' && <HistoryDoc text={text} parts={showChanges ? diff.parts : null} viewRef={view} />}
        </div>
      </section>
    </div>
  );
}

/** "Version history" in the page menu (•••), as in Notion; shown only for files history covers. */
export function HistoryMenuItem({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" role="menuitem" onClick={onOpen} className="lens-menu-item">
      <span className="lens-menu-item-icon">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4" aria-hidden="true">
          <path d="M3.5 10a6.5 6.5 0 1 0 1.9-4.6M3.5 3.5v3h3" />
          <path d="M10 6.5V10l2.5 1.5" />
        </svg>
      </span>
      <span className="min-w-0">
        <span className="lens-menu-item-label block text-sm leading-5">Version history</span>
        <span className="lens-menu-item-description">Earlier versions of this page and what changed</span>
      </span>
    </button>
  );
}
