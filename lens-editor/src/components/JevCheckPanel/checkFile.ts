// The check file's live text, and writing changes back into it.
import { useEffect, useState } from 'react';
import type * as Y from 'yjs';

export function useLiveText(ytext: Y.Text) {
  const [text, setText] = useState(() => ytext.toString());
  useEffect(() => {
    const f = () => setText(ytext.toString());
    ytext.observe(f);
    return () => ytext.unobserve(f);
  }, [ytext]);
  return text;
}

/** Apply `change` to the file, replacing only the changed span so collaborators' cursors are untouched. */
export function writeText(ytext: Y.Text, change: (text: string) => string) {
  const before = ytext.toString();
  const after = change(before);
  if (after === before) return;
  let a = 0;
  while (a < before.length && before[a] === after[a]) a++;
  // The shared end may not reach into the shared start in either text, or the shorter one
  // keeps a piece of the start twice (T7, 2026-10-27: "  presentation:…" before "  pass_below"
  // left "  p" behind).
  const room = Math.min(before.length, after.length) - a;
  let b = 0;
  while (b < room && before[before.length - 1 - b] === after[after.length - 1 - b]) b++;
  ytext.doc!.transact(() => {
    ytext.delete(a, before.length - a - b);
    ytext.insert(a, after.slice(a, after.length - b));
  });
}
