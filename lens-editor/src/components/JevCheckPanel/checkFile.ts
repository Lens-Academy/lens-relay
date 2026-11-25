// The check file's live text (changes are written back with lib/ytext.ts's writeText).
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
