import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { EditorView } from '@codemirror/view';
import { useKeyboardInset } from '../../hooks/useKeyboardInset';
import {
  toggleInlineMark,
  toggleLinePrefix,
  cycleHeading,
  insertWikilink,
  undoCommand,
  redoCommand,
} from '../../lib/editor-commands';

interface MobileEditToolbarProps {
  view: EditorView;
  /** Opens the add-comment flow (comments sheet) at the current cursor. */
  onAddComment?: () => void;
}

const TOOLBAR_HEIGHT = 44;

function Btn({ label, onAction, children }: { label: string; onAction: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className="flex-shrink-0 flex items-center justify-center w-11 h-11 text-gray-600 active:bg-gray-200 rounded"
      // preventDefault on mousedown keeps focus in the editor; the action runs
      // on click so a horizontal scroll of the strip never triggers a command
      // (the browser suppresses click when the touch becomes a scroll).
      onMouseDown={(e) => e.preventDefault()}
      onClick={onAction}
    >
      {children}
    </button>
  );
}

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

/**
 * Obsidian-style editing toolbar: a horizontally scrollable strip of
 * formatting buttons docked above the on-screen keyboard (tracked via
 * visualViewport). Shown while the editor has focus; buttons use
 * pointerdown-preventDefault so tapping them doesn't dismiss the keyboard.
 */
export function MobileEditToolbar({ view, onAddComment }: MobileEditToolbarProps) {
  const bottomOffset = useKeyboardInset();

  // Scroll the cursor above the keyboard + toolbar. The editor's scroll
  // container may extend behind the keyboard (iOS / resizes-visual mode), so
  // CM's own scrollIntoView considers the cursor "visible" — compute against
  // the visual viewport instead.
  const keepCursorVisible = () => {
    const coords = view.coordsAtPos(view.state.selection.main.head);
    if (!coords) return;
    const vv = window.visualViewport;
    const viewportBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
    const visibleBottom = viewportBottom - TOOLBAR_HEIGHT - 12;
    if (coords.bottom > visibleBottom) {
      view.scrollDOM.scrollTop += coords.bottom - visibleBottom + 24;
    }
  };

  // Track keyboard open/close via visualViewport height changes — works in
  // both resizes-content (layout shrinks too) and resizes-visual modes.
  useEffect(() => {
    const vv = window.visualViewport;
    // Keyboard is opening as this toolbar mounts — wait out its animation.
    const mountTimer = window.setTimeout(keepCursorVisible, 350);
    if (!vv) return () => window.clearTimeout(mountTimer);

    let prevHeight = vv.height;
    const onResize = () => {
      const delta = vv.height - prevHeight;
      prevHeight = vv.height;
      if (delta > 100 && view.hasFocus) {
        // Viewport grew ⇒ keyboard closed (system back / hide) — done editing,
        // hide this toolbar and bring the nav bar back.
        view.contentDOM.blur();
      } else if (delta < -100) {
        // Viewport shrank ⇒ keyboard opened — keep the cursor in view.
        keepCursorVisible();
      }
    };
    vv.addEventListener('resize', onResize);
    return () => {
      window.clearTimeout(mountTimer);
      vv.removeEventListener('resize', onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keepCursorVisible reads live view state
  }, [view]);

  const run = (cmd: (v: EditorView) => boolean) => () => {
    cmd(view);
  };

  return createPortal(
    <div
      id="mobile-edit-toolbar"
      className="fixed inset-x-0 z-30 flex items-center overflow-x-auto bg-[#f6f6f6] border-t border-gray-200 px-1"
      style={{ bottom: bottomOffset }}
    >
      {onAddComment && (
        <Btn label="Add comment" onAction={onAddComment}>
          <svg className="w-5 h-5" viewBox="0 0 24 24" {...stroke}>
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            <line x1="12" y1="7.5" x2="12" y2="12.5" /><line x1="9.5" y1="10" x2="14.5" y2="10" />
          </svg>
        </Btn>
      )}
      <Btn label="Cycle heading" onAction={run(cycleHeading)}>
        <span className="text-base font-bold">H</span>
      </Btn>
      <Btn label="Bold" onAction={run(v => toggleInlineMark(v, '**'))}>
        <span className="text-base font-extrabold">B</span>
      </Btn>
      <Btn label="Italic" onAction={run(v => toggleInlineMark(v, '*'))}>
        <span className="text-base italic font-semibold">I</span>
      </Btn>
      <Btn label="Undo" onAction={run(undoCommand)}>
        <svg className="w-5 h-5" viewBox="0 0 24 24" {...stroke}><polyline points="9 14 4 9 9 4" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></svg>
      </Btn>
      <Btn label="Redo" onAction={run(redoCommand)}>
        <svg className="w-5 h-5" viewBox="0 0 24 24" {...stroke}><polyline points="15 14 20 9 15 4" /><path d="M20 9H10a6 6 0 0 0 0 12h3" /></svg>
      </Btn>
      <Btn label="Strikethrough" onAction={run(v => toggleInlineMark(v, '~~'))}>
        <span className="text-base line-through">S</span>
      </Btn>
      <Btn label="Highlight" onAction={run(v => toggleInlineMark(v, '=='))}>
        <span className="text-base bg-yellow-200 px-0.5 rounded-sm">H</span>
      </Btn>
      <Btn label="Inline code" onAction={run(v => toggleInlineMark(v, '`'))}>
        <svg className="w-5 h-5" viewBox="0 0 24 24" {...stroke}><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>
      </Btn>
      <Btn label="Bullet list" onAction={run(v => toggleLinePrefix(v, 'bullet'))}>
        <svg className="w-5 h-5" viewBox="0 0 24 24" {...stroke}><line x1="9" y1="6" x2="20" y2="6" /><line x1="9" y1="12" x2="20" y2="12" /><line x1="9" y1="18" x2="20" y2="18" /><circle cx="4.5" cy="6" r="1" /><circle cx="4.5" cy="12" r="1" /><circle cx="4.5" cy="18" r="1" /></svg>
      </Btn>
      <Btn label="Numbered list" onAction={run(v => toggleLinePrefix(v, 'ordered'))}>
        <svg className="w-5 h-5" viewBox="0 0 24 24" {...stroke}><line x1="10" y1="6" x2="21" y2="6" /><line x1="10" y1="12" x2="21" y2="12" /><line x1="10" y1="18" x2="21" y2="18" /><path d="M4 6h1v4" /><path d="M4 10h2" /><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" /></svg>
      </Btn>
      <Btn label="Task" onAction={run(v => toggleLinePrefix(v, 'task'))}>
        <svg className="w-5 h-5" viewBox="0 0 24 24" {...stroke}><rect x="3" y="5" width="14" height="14" rx="2" /><polyline points="7 12 9.5 14.5 14 9.5" /></svg>
      </Btn>
      <Btn label="Quote" onAction={run(v => toggleLinePrefix(v, 'quote'))}>
        <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M6 17h3l2-4V7H5v6h3zm8 0h3l2-4V7h-6v6h3z" /></svg>
      </Btn>
      <Btn label="Wikilink" onAction={run(insertWikilink)}>
        <span className="text-sm font-semibold">[[ ]]</span>
      </Btn>
      <button
        type="button"
        title="Hide keyboard"
        aria-label="Hide keyboard"
        className="flex-shrink-0 flex items-center justify-center w-11 h-11 ml-auto text-gray-600 active:bg-gray-200 rounded"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => view.contentDOM.blur()}
      >
        <svg className="w-5 h-5" viewBox="0 0 24 24" {...stroke}><rect x="2" y="3" width="20" height="12" rx="2" /><path d="M6 7h.01M10 7h.01M14 7h.01M18 7h.01M8 11h8" /><polyline points="9 19 12 22 15 19" /></svg>
      </button>
    </div>,
    document.body,
  );
}
