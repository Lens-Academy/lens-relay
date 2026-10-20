// The check file's live text, and writing frontmatter fields back into it.
import { useEffect, useState } from 'react';
import type * as Y from 'yjs';
import { setCheckFields } from '../../lib/jev-check';

export function useLiveText(ytext: Y.Text) {
  const [text, setText] = useState(() => ytext.toString());
  useEffect(() => {
    const f = () => setText(ytext.toString());
    ytext.observe(f);
    return () => ytext.unobserve(f);
  }, [ytext]);
  return text;
}

/** Replace only the changed span, so collaborators' cursors in the body are untouched. */
export function writeFields(ytext: Y.Text, edits: { path: string[]; value: string | number }[]) {
  const before = ytext.toString();
  const after = setCheckFields(before, edits);
  if (after === before) return;
  let a = 0;
  while (a < before.length && before[a] === after[a]) a++;
  let b = 0;
  while (b < before.length - a && before[before.length - 1 - b] === after[after.length - 1 - b]) b++;
  ytext.doc!.transact(() => {
    ytext.delete(a, before.length - a - b);
    ytext.insert(a, after.slice(a, after.length - b));
  });
}
