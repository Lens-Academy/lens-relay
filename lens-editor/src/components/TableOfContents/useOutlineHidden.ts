import { useCallback, useMemo, useState } from 'react';

const storageKey = (docId: string) => `lens-outline-hidden:${docId}`;

function readHidden(docId: string): string[] {
  if (!docId) return [];
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(storageKey(docId)) ?? '[]');
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Each heading's key: its text and which of the page's headings with that
 * text it is, so a weekly meeting's second "Luc" is not its first
 */
export function headingKeys(headings: { text: string }[]): string[] {
  const seen = new Map<string, number>();
  return headings.map(({ text }) => {
    const n = seen.get(text) ?? 0;
    seen.set(text, n + 1);
    return `${n}:${text}`;
  });
}

/**
 * Headings taken out of a page's outline, as Google Docs' "Remove from
 * outline": the page itself is untouched. Kept in this browser, by page.
 */
export function useOutlineHidden(docId: string) {
  const [changed, setChanged] = useState<Record<string, string[]>>({});
  const list = useMemo(() => changed[docId] ?? readHidden(docId), [changed, docId]);
  const hidden = useMemo(() => new Set(list), [list]);

  const save = useCallback((next: string[]) => {
    setChanged((all) => ({ ...all, [docId]: next }));
    if (!docId) return;
    try {
      if (next.length > 0) window.localStorage.setItem(storageKey(docId), JSON.stringify(next));
      else window.localStorage.removeItem(storageKey(docId));
    } catch {
      // Private windows and blocked storage: hidden until the page is left
    }
  }, [docId]);

  const hide = useCallback((key: string) => save([...list, key]), [list, save]);
  const showAll = useCallback(() => save([]), [save]);
  return { hidden, hide, showAll };
}
