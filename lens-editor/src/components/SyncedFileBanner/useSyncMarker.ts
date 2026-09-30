import { useMemo, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';
import { extractFrontmatter } from '../../lib/frontmatter';
import { readSyncMarker, type SyncMarker } from '../../../shared/source-sync';

function markerOf(doc: Y.Doc | null): SyncMarker | null {
  return doc ? readSyncMarker(extractFrontmatter(doc.getText('contents').toString())) : null;
}

/** An external store over a doc's sync marker, re-read whenever the text changes. */
function createMarkerStore(doc: Y.Doc | null) {
  let snapshot = markerOf(doc);
  return {
    get: () => snapshot,
    subscribe(onChange: () => void) {
      if (!doc) return () => {};
      const text = doc.getText('contents');
      const update = () => {
        const next = markerOf(doc);
        // Keep the same object while nothing changed, so typing does not re-render.
        if (next?.source === snapshot?.source && next?.url === snapshot?.url) return;
        snapshot = next;
        onChange();
      };
      text.observe(update);
      // Text that arrived between the first render and now (the doc syncing in) counts too.
      update();
      return () => text.unobserve(update);
    },
  };
}

/** The open document's sync marker (frontmatter `synced_from`), kept current as it is edited. */
export function useSyncMarker(doc: Y.Doc | null): SyncMarker | null {
  const store = useMemo(() => createMarkerStore(doc), [doc]);
  return useSyncExternalStore(store.subscribe, store.get);
}
