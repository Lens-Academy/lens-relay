import { useCallback, useState } from 'react';
import { isWalkOrder, parseSeen, type WalkOrder } from '../../lib/idea-map-walk';

/** Where the browser keeps which concepts were seen in the walk: one entry per set of concepts (`:<set>` follows). */
export const SEEN_STORE = 'concept-map-walk-seen';
/** Where it keeps the order last chosen. */
export const ORDER_STORE = 'concept-map-walk-order';

function read(name: string): string | null {
  try {
    return localStorage.getItem(name);
  } catch {
    return null;
  }
}

function write(name: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(name);
    else localStorage.setItem(name, value);
  } catch {
    // No storage (private window): it lasts until the page closes
  }
}

/**
 * The concepts seen in the walk (by `seenId`), kept in this browser per set
 * of concepts (`set`: a profile or a folder). The view is mounted again for
 * another set, so the set is read once.
 */
export function useWalkSeen(set: string): { seen: ReadonlySet<string>; mark: (id: string) => void; clear: () => void } {
  const name = `${SEEN_STORE}:${set}`;
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set(parseSeen(read(name))));
  const mark = useCallback((id: string) => setSeen((now) => {
    if (now.has(id)) return now;
    const next = new Set(now).add(id);
    write(name, JSON.stringify([...next]));
    return next;
  }), [name]);
  const clear = useCallback(() => {
    write(name, null);
    setSeen(new Set());
  }, [name]);
  return { seen, mark, clear };
}

/** The order of the walk, as chosen last in this browser. */
export function useWalkOrder(): [WalkOrder, (order: WalkOrder) => void] {
  const [order, setOrder] = useState<WalkOrder>(() => {
    const kept = read(ORDER_STORE);
    return isWalkOrder(kept) ? kept : 'foundations';
  });
  const choose = useCallback((next: WalkOrder) => {
    write(ORDER_STORE, next);
    setOrder(next);
  }, []);
  return [order, choose];
}
