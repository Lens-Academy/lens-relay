import { useSyncExternalStore } from 'react';
import type { ReadAloudEngine } from '../../lib/read-aloud/engine';

/** The engine's state, re-rendering on change (null without an engine). */
export function useReadAloudSnapshot(engine: ReadAloudEngine | null) {
  return useSyncExternalStore(
    engine?.subscribe ?? noopSubscribe,
    engine?.getSnapshot ?? nullSnapshot,
  );
}
const noopSubscribe = () => () => {};
const nullSnapshot = () => null;
