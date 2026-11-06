import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';
import { pageOffersSourceLinks } from '../../../shared/external-links';
import { humanActor } from '../../lib/provenance';
import { HIDDEN_BAR, type BarModel } from './bar-model';
import type { LibraryHit } from './localSwap';
import { SourceLinksSession } from './source-links-session';

export interface UseSourceLinksOptions {
  doc: Y.Doc;
  docId: string;
  /** The open file's editor path ("/Lens/Notes/a.md"). */
  path: string | undefined;
  displayName: string | null;
  /** `workflowAccess(...).addSource`. */
  canImport: boolean;
  /** The page is in Suggesting mode. */
  suggesting?: boolean;
  /** Swaps links in the open editor and says which it swapped. */
  swapInPage?: (hits: LibraryHit[]) => string[];
}

export interface SourceLinks {
  model: BarModel;
  /** Null when this page or person gets no offer. */
  session: SourceLinksSession | null;
}

const subscribeToNothing = () => () => {};
const hiddenBar = () => HIDDEN_BAR;

/** The relay's name for an editor path, which has no leading slash. */
function relayPath(path: string | undefined): string {
  return path?.replace(/^\/+/, '') ?? '';
}

/**
 * The open page's sources. Does nothing, with no scanning and no requests, unless
 * this person can import and the page's path can get the offer (its frontmatter
 * is checked with each scan).
 */
export function useSourceLinks({
  doc,
  docId,
  path,
  displayName,
  canImport,
  suggesting = false,
  swapInPage,
}: UseSourceLinksOptions): SourceLinks {
  const relay = relayPath(path);
  const eligible = canImport && relay !== '' && pageOffersSourceLinks(relay, '');

  // One session belongs to one document: nothing is carried to the next
  const page = useMemo(() => ({ doc, docId }), [doc, docId]);
  const session = useMemo(
    () => (eligible ? new SourceLinksSession(page.doc, page.docId) : null),
    [page, eligible],
  );

  // Before the store's subscribe below, which starts the session
  const actor = humanActor(displayName ?? '');
  useEffect(
    () => session?.setContext({ path: relay, actor, suggesting, swapInPage }),
    [session, relay, actor, suggesting, swapInPage],
  );

  const model = useSyncExternalStore(session?.subscribe ?? subscribeToNothing, session?.getModel ?? hiddenBar);
  return { model, session };
}
