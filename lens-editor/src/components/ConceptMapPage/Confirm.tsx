import { useEffect, useState, type ReactNode } from 'react';
import { BUTTON, DANGER_BUTTON } from './ideaLook';

/**
 * The step before something is deleted: what goes, and the two buttons. The
 * focus goes to the button that does it, so Enter confirms and Escape
 * cancels; an Enter that is still held down from the step before does nothing.
 * When it closes, the focus goes back to the button that opened it (if that
 * is still there).
 */
export function Confirm({ label, action, busyLabel = 'Deleting…', busy, error, onCancel, onConfirm, children }: {
  label: string;
  action: string;
  busyLabel?: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  children: ReactNode;
}) {
  // What had the focus before the button below took it
  const [opener] = useState(() => (typeof document === 'undefined' ? null : document.activeElement));
  useEffect(() => () => {
    // Only when the focus went nowhere else: it was on a button of this step
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (lost && opener instanceof HTMLElement && opener.isConnected) opener.focus();
  }, [opener]);
  return (
    <div
      className="mt-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-gray-800"
      role="group"
      aria-label={label}
      data-testid="idea-confirm"
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || busy) return;
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }}
    >
      {children}
      {error && <p className="mt-2 text-xs text-red-700" role="alert">{error}</p>}
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" className={`${BUTTON} bg-white`} onClick={onCancel} disabled={busy}>Cancel</button>
        <button
          type="button"
          className={DANGER_BUTTON}
          autoFocus
          onKeyDown={(e) => { if (e.repeat) e.preventDefault(); }}
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? busyLabel : action}
        </button>
      </div>
    </div>
  );
}
