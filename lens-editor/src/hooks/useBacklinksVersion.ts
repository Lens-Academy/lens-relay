import { useEffect, useState } from 'react';
import type * as Y from 'yjs';
import { BACKLINKS_MAP } from '../lib/backlinks';

/**
 * A counter that increments whenever any folder doc's backlinks map changes,
 * for memos that read backlinks and need to recompute on live updates.
 */
export function useBacklinksVersion(folderDocs: Map<string, Y.Doc>): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion(v => v + 1);
    const cleanups: (() => void)[] = [];
    for (const doc of folderDocs.values()) {
      const map = doc.getMap<string[]>(BACKLINKS_MAP);
      map.observe(bump);
      cleanups.push(() => map.unobserve(bump));
    }
    return () => cleanups.forEach(fn => fn());
  }, [folderDocs]);
  return version;
}
