import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { EditorView } from '@codemirror/view';
import {
  authorshipModeField,
  recentWindowField,
  recentEnabledField,
  setAuthorshipMode,
  setRecentWindow,
  setRecentEnabled,
  loadRecentWindow,
  saveRecentWindow,
  loadRecentEnabled,
  saveRecentEnabled,
  RECENT_WINDOW_PRESETS,
  type AuthorshipMode,
} from '../Editor/extensions/authorship';

interface AuthorshipModeToggleProps {
  view: EditorView | null;
}

const MODES: Array<{ value: AuthorshipMode; label: string; description: string }> = [
  { value: 'hidden', label: 'Off', description: 'No authorship display' },
  { value: 'gutter', label: 'Gutter', description: 'Colored strip per line' },
  { value: 'expanded', label: 'Expanded', description: 'Author names in the margin' },
  { value: 'inline', label: 'Inline', description: 'Expanded + per-word tint' },
];

// Outlined document with an edge strip — a miniature of the authorship gutter.
function AuthorshipIcon({ dimmed }: { dimmed: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      className={`w-4 h-4 ${dimmed ? 'opacity-40' : ''}`}
    >
      <rect x="3" y="3" width="14" height="14" rx="2" />
      <line x1="6.5" y1="6.5" x2="6.5" y2="13.5" strokeWidth="2" />
      <line x1="10" y1="7" x2="14" y2="7" />
      <line x1="10" y1="10" x2="14" y2="10" />
      <line x1="10" y1="13" x2="14" y2="13" />
    </svg>
  );
}

/**
 * Dropdown selecting the authorship provenance display mode.
 * Shows the current setting on the button; options: Off / Gutter / Inline.
 */
export function AuthorshipModeToggle({ view }: AuthorshipModeToggleProps) {
  const [mode, setMode] = useState<AuthorshipMode>('gutter');
  const [windowMs, setWindowMs] = useState<number>(() => loadRecentWindow());
  const [recentEnabled, setRecentEnabledState] = useState<boolean>(() => loadRecentEnabled());
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, right: 0 });

  // A recreated EditorView (doc switch) starts back at the field's default
  // while this component keeps its selection — bring the view in line.
  useEffect(() => {
    if (!view) return;
    if (view.state.field(authorshipModeField, false) !== mode) {
      view.dispatch({ effects: setAuthorshipMode.of(mode) });
    }
    if (view.state.field(recentWindowField, false) !== windowMs) {
      view.dispatch({ effects: setRecentWindow.of(windowMs) });
    }
    if (view.state.field(recentEnabledField, false) !== recentEnabled) {
      view.dispatch({ effects: setRecentEnabled.of(recentEnabled) });
    }
  }, [view, mode, windowMs, recentEnabled]);

  const selectWindow = (ms: number) => {
    setWindowMs(ms);
    saveRecentWindow(ms);
    if (view) view.dispatch({ effects: setRecentWindow.of(ms) });
  };

  const toggleRecent = () => {
    const next = !recentEnabled;
    setRecentEnabledState(next);
    saveRecentEnabled(next);
    if (view) view.dispatch({ effects: setRecentEnabled.of(next) });
  };

  const updatePosition = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener('resize', updatePosition);
    return () => window.removeEventListener('resize', updatePosition);
  }, [open, updatePosition]);

  // Close on outside click / Escape
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        buttonRef.current && !buttonRef.current.contains(target) &&
        dropdownRef.current && !dropdownRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const select = (next: AuthorshipMode) => {
    setOpen(false);
    if (!view) return;
    setMode(next);
    view.dispatch({ effects: setAuthorshipMode.of(next) });
  };

  const current = MODES.find((m) => m.value === mode) ?? MODES[1];
  const windowLabel = RECENT_WINDOW_PRESETS.find((p) => p.ms === windowMs)?.label ?? `${Math.round(windowMs / 60_000)}m`;
  const buttonLabel = recentEnabled ? `${current.label} · Recent ${windowLabel}` : current.label;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(!open)}
        disabled={!view}
        title="Authorship display"
        aria-label={`Authorship display: ${current.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-gray-300 bg-white hover:bg-gray-50 text-gray-600 disabled:opacity-40"
      >
        <AuthorshipIcon dimmed={mode === 'hidden' && !recentEnabled} />
        <span className="text-xs">{buttonLabel}</span>
        <svg className="w-3 h-3 text-gray-400" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {open && createPortal(
        <div
          ref={dropdownRef}
          role="menu"
          className="fixed bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50 min-w-44"
          style={{ top: pos.top, right: pos.right }}
        >
          <div className="px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-gray-400">
            Authorship
          </div>
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="menuitemradio"
              aria-checked={m.value === mode}
              onClick={() => select(m.value)}
              className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm hover:bg-gray-50 ${
                m.value === mode ? 'text-gray-900' : 'text-gray-600'
              }`}
            >
              <span>
                <span className="block">{m.label}</span>
                <span className="block text-xs text-gray-400">{m.description}</span>
              </span>
              {m.value === mode && (
                <svg className="w-4 h-4 text-blue-500" viewBox="0 0 20 20" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z"
                    clipRule="evenodd"
                  />
                </svg>
              )}
            </button>
          ))}
          <div className="border-t border-gray-100 mt-1 pt-1">
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={recentEnabled}
              onClick={toggleRecent}
              className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm hover:bg-gray-50 text-gray-900"
            >
              <span>
                <span className="block">Highlight recent changes</span>
                <span className="block text-xs text-gray-400">Direct AI edits within a time window</span>
              </span>
              <span
                aria-hidden="true"
                className={`relative inline-flex h-4 w-7 shrink-0 rounded-full transition-colors ${recentEnabled ? 'bg-purple-500' : 'bg-gray-300'}`}
              >
                <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${recentEnabled ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
              </span>
            </button>
            {recentEnabled && (
              <div className="flex gap-1 px-3 pb-1.5 pt-0.5" role="group" aria-label="Recent changes window">
                {RECENT_WINDOW_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    role="menuitemradio"
                    aria-checked={p.ms === windowMs}
                    onClick={() => selectWindow(p.ms)}
                    className={`px-2 py-0.5 rounded-full text-xs transition-colors ${
                      p.ms === windowMs
                        ? 'bg-purple-100 text-purple-700'
                        : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
