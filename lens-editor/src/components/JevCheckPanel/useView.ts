// A view setting kept in the check file's `view:` block, so everyone who opens the file sees
// the same sample and the same results (Lauren, 2026-10-22). A change shows at once here and
// is written to the file after a pause, so typing a number does not write each keystroke.
import { useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { readView, setView, type View } from '../../lib/jev-check';
import { writeText } from '../../lib/ytext';

const PAUSE_MS = 800;

export function useView<K extends keyof View>(ytext: Y.Text, text: string, key: K, fallback: NonNullable<View[K]>): [NonNullable<View[K]>, (v: NonNullable<View[K]>) => void] {
  const inFile = readView(text)[key] as View[K];
  const [mine, setMine] = useState<{ v: NonNullable<View[K]> } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  // Once the file holds what was set here, follow the file again (another viewer's change);
  // React's "adjust state while rendering" pattern, as Field.tsx follows its value.
  if (mine && JSON.stringify(inFile) === JSON.stringify(mine.v)) setMine(null);
  // A change still waiting when the panel closes is written then, not lost.
  const pending = useRef<(() => void) | null>(null);
  useEffect(() => () => { window.clearTimeout(timer.current); pending.current?.(); }, []);
  const set = (v: NonNullable<View[K]>) => {
    setMine({ v });
    window.clearTimeout(timer.current);
    pending.current = () => { pending.current = null; writeText(ytext, (t) => setView(t, key, v)); };
    timer.current = window.setTimeout(() => pending.current?.(), PAUSE_MS);
  };
  return [mine ? mine.v : (inFile ?? fallback) as NonNullable<View[K]>, set];
}
