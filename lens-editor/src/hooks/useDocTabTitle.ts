import { useEffect } from 'react';
import { useNavigation } from '../contexts/NavigationContext';
import { findPathByUuid } from '../lib/uuid-to-path';
import { RELAY_ID } from '../App';

/** The name a document goes by: its file name without the .md or .html extension. */
export function docDisplayName(path: string | null | undefined): string {
  return path ? path.split('/').pop()?.replace(/\.(md|html)$/i, '') ?? '' : '';
}

/** Shows the open document's name in the browser tab, as "<name> - Editor". */
export function useDocTabTitle(currentDocId: string) {
  const { metadata } = useNavigation();
  const uuid = currentDocId.slice(RELAY_ID.length + 1);
  const displayName = docDisplayName(findPathByUuid(uuid, metadata));

  useEffect(() => {
    document.title = displayName ? `${displayName} - Editor` : 'Editor';
    return () => { document.title = 'Editor'; };
  }, [displayName]);
}
