import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

/** "⌘ Enter" on a Mac, "Ctrl+Enter" elsewhere: the keys that save a form. */
export function saveKeys(): string {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ Enter' : 'Ctrl+Enter';
}

/** What the form says once Escape was pressed on changes that are not saved. */
export const LEAVE_NOTE = 'Not saved yet. Press Escape again to discard the changes.';

/**
 * The keys the forms of the concept map share:
 * - Ctrl+Enter (Cmd+Enter) saves from any field, a textarea included.
 * - A plain Enter in a one-line field never saves a half-filled form: it
 *   moves on to the next field. (A field that uses Enter itself, like a pick
 *   list, keeps it.)
 * - Escape closes the form, wherever the focus is on the page. With changes
 *   that are not saved the first Escape only says so (`leaving`); the second
 *   one discards them. Something that is open inside the form (a list, a
 *   menu, a confirm step) takes the Escape before.
 */
export function useFormKeys({ dirty, busy, onCancel }: {
  /** Something in the form differs from what it opened with. */
  dirty: boolean;
  busy: boolean;
  onCancel: () => void;
}) {
  /** Escape was pressed once on a form with changes: the next one discards them. */
  const [leaving, setLeaving] = useState(false);
  const now = useRef({ dirty, busy, leaving, onCancel });
  useEffect(() => {
    now.current = { dirty, busy, leaving, onCancel };
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') {
        // Going on with the form takes the warning back
        if (now.current.leaving && !['Shift', 'Control', 'Meta', 'Alt'].includes(e.key)) setLeaving(false);
        return;
      }
      const { dirty: changed, busy: saving, leaving: warned, onCancel: close } = now.current;
      if (e.defaultPrevented || saving) return;
      e.preventDefault();
      if (!changed || warned) close();
      else setLeaving(true);
    };
    const onPress = () => {
      if (now.current.leaving) setLeaving(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPress);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPress);
    };
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLFormElement>) => {
    if (e.key !== 'Enter' || e.defaultPrevented || e.nativeEvent.isComposing) return;
    const form = e.currentTarget;
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return;
    }
    const field = e.target;
    if (!(field instanceof HTMLInputElement) || field.type === 'submit' || field.type === 'button') return;
    // The browser would send the form
    e.preventDefault();
    if (field.type === 'checkbox' || field.type === 'radio') return;
    const fields = [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select')]
      .filter((other) => !other.disabled && other.type !== 'checkbox' && other.type !== 'radio');
    fields[fields.indexOf(field) + 1]?.focus();
  };

  return { onKeyDown, leaving };
}
