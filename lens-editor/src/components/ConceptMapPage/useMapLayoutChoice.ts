import { useCallback, useMemo, useState } from 'react';
import type { IdeaGraph } from '../../lib/idea-map';
import { parseChoice, resolveChoice, type MapLayoutChoice, type StoredChoice } from '../../lib/idea-map-layouts';

/**
 * Where the browser keeps how the map was last drawn. (Not the key of the
 * first version, `concept-map-layout`: what that one stored would pin the
 * grouping to the computed clusters where the author's topics are now the
 * default.)
 */
export const LAYOUT_STORE = 'concept-map-drawing';

function stored(): StoredChoice {
  try {
    return parseChoice(localStorage.getItem(LAYOUT_STORE));
  } catch {
    return {};
  }
}

/**
 * How the map is drawn: what was chosen by hand in this browser, the rest as
 * suits this map (`resolveChoice`), and a way to choose again. Only what was
 * chosen is kept, so a map that gets topics later is grouped by them.
 */
export function useMapLayoutChoice(graph: IdeaGraph): [MapLayoutChoice, (change: StoredChoice) => void] {
  const [chosen, setChosen] = useState(stored);
  const choose = useCallback((change: StoredChoice) => {
    setChosen((now) => {
      const next = { ...now, ...change };
      try {
        localStorage.setItem(LAYOUT_STORE, JSON.stringify(next));
      } catch {
        // No storage (private window): the choice lasts until the page closes
      }
      return next;
    });
  }, []);
  const choice = useMemo(() => resolveChoice(chosen, graph), [chosen, graph]);
  return [choice, choose];
}
