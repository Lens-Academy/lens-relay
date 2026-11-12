import { useCallback, useState } from 'react';
import { parseChoice, type MapLayoutChoice } from '../../lib/idea-map-layouts';

/** Where the browser keeps how the map was last drawn. */
export const LAYOUT_STORE = 'concept-map-layout';

function stored(): MapLayoutChoice {
  try {
    return parseChoice(localStorage.getItem(LAYOUT_STORE));
  } catch {
    return parseChoice(null);
  }
}

/** How the map is drawn: what was chosen last in this browser, and a way to choose again. */
export function useMapLayoutChoice(): [MapLayoutChoice, (next: MapLayoutChoice) => void] {
  const [choice, setChoice] = useState(stored);
  const choose = useCallback((next: MapLayoutChoice) => {
    setChoice(next);
    try {
      localStorage.setItem(LAYOUT_STORE, JSON.stringify(next));
    } catch {
      // No storage (private window): the choice lasts until the page closes
    }
  }, []);
  return [choice, choose];
}
