import { useCallback, useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { useDocConnection, teardownProvider } from './useDocConnection';
import { RELAY_ID } from '../lib/constants';

export interface DocTextState {
  status: 'loading' | 'ready' | 'error';
  text: string;
}

/** How long to wait after the last remote change before re-publishing a doc's text. */
const SETTLE_MS = 150;

/**
 * Live `contents` text of a growing set of documents.
 *
 * `request(uuids)` connects every uuid not seen before (one relay connection
 * each, as the Edu editor does for outcome docs) and keeps it connected,
 * observing its text, until the component unmounts. Text updates are
 * coalesced so a collaborator typing does not re-render per keystroke.
 */
export function useDocTexts(): { docs: Record<string, DocTextState>; request: (uuids: string[]) => void } {
  const { getOrConnect, disconnectAll } = useDocConnection();
  const [docs, setDocs] = useState<Record<string, DocTextState>>({});
  const requested = useRef(new Set<string>());
  const observers = useRef(new Map<string, { ytext: Y.Text; handler: () => void }>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // Bumped on unmount: a connection that resolves for an older generation
  // belongs to a torn-down instance (StrictMode remount, or the real thing).
  const generation = useRef(0);
  const disconnectAllRef = useRef(disconnectAll);
  useEffect(() => {
    disconnectAllRef.current = disconnectAll;
  }, [disconnectAll]);

  const request = useCallback((uuids: string[]) => {
    const fresh = uuids.filter(uuid => !requested.current.has(uuid));
    if (fresh.length === 0) return;
    for (const uuid of fresh) requested.current.add(uuid);
    setDocs(prev => {
      const next = { ...prev };
      for (const uuid of fresh) next[uuid] = { status: 'loading', text: '' };
      return next;
    });

    const gen = generation.current;
    for (const uuid of fresh) {
      getOrConnect(`${RELAY_ID}-${uuid}`).then(({ doc, provider }) => {
        if (gen !== generation.current) {
          // Resolved after the teardown that disconnected everything else:
          // left alone it would reconnect forever.
          teardownProvider(provider);
          doc.destroy();
          return;
        }
        const ytext = doc.getText('contents');
        const publish = () => {
          timers.current.delete(uuid);
          setDocs(prev => ({ ...prev, [uuid]: { status: 'ready', text: ytext.toString() } }));
        };
        const handler = () => {
          clearTimeout(timers.current.get(uuid));
          timers.current.set(uuid, setTimeout(publish, SETTLE_MS));
        };
        publish();
        ytext.observe(handler);
        observers.current.set(uuid, { ytext, handler });
      }).catch((err: unknown) => {
        if (gen !== generation.current) return;
        console.error(`[useDocTexts] failed to load ${uuid}:`, err);
        setDocs(prev => ({ ...prev, [uuid]: { status: 'error', text: '' } }));
      });
    }
  }, [getOrConnect]);

  useEffect(() => {
    const active = observers.current;
    const pending = timers.current;
    const asked = requested.current;
    return () => {
      generation.current += 1;
      for (const { ytext, handler } of active.values()) ytext.unobserve(handler);
      active.clear();
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      // A StrictMode remount must be able to ask again.
      asked.clear();
      disconnectAllRef.current();
    };
  }, []);

  return { docs, request };
}
