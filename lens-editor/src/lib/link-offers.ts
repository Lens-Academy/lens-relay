import type * as Y from 'yjs';

/**
 * Who has said no to the import-and-link offer on a page. The content doc's
 * `link_offers_v0` Y.Map holds url → { at, by }: a URL in the map is not offered
 * again on this page, to anyone. Right-clicking the link can still import it,
 * which takes it back out. Only a dismissal is recorded here: what became of a
 * source is the server's job list.
 */
export const LINK_OFFERS_MAP = 'link_offers_v0';

export interface LinkOfferDismissal {
  /** When it was dismissed, unix ms */
  at: number;
  /** The name of whoever dismissed it */
  by: string;
}

function offersMap(doc: Y.Doc): Y.Map<LinkOfferDismissal> {
  return doc.getMap<LinkOfferDismissal>(LINK_OFFERS_MAP);
}

export function readLinkOffers(doc: Y.Doc): Map<string, LinkOfferDismissal> {
  return new Map(offersMap(doc).entries());
}

/** Calls `listener` when anyone's dismissal arrives. Returns the unsubscribe. */
export function observeLinkOffers(doc: Y.Doc, listener: () => void): () => void {
  const map = offersMap(doc);
  map.observe(listener);
  return () => map.unobserve(listener);
}

/** Dismisses `urls` in one transaction. The first dismissal of a URL stands. */
export function dismissLinkOffers(doc: Y.Doc, urls: string[], by: string, at: number = Date.now()): void {
  const map = offersMap(doc);
  const fresh = [...new Set(urls)].filter((url) => !map.has(url));
  if (fresh.length === 0) return;
  doc.transact(() => {
    for (const url of fresh) map.set(url, { at, by });
  });
}

/** Takes one URL's dismissal back. */
export function undoLinkOfferDismissal(doc: Y.Doc, url: string): void {
  const map = offersMap(doc);
  if (map.has(url)) map.delete(url);
}

// ── What this browser has already been offered ──────────────────────────

const SEEN_KEY = 'lens-editor:seen-link-offers:';
const SEEN_MAX = 500;

/**
 * The URLs of a page this browser has been offered, oldest first. Unlike a
 * dismissal, this is one person's: an offer they let pass is not asked again on
 * their next visit, and everyone else still gets it.
 */
export function readSeenLinkOffers(docId: string): Set<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(SEEN_KEY + docId) ?? '[]');
    return new Set(Array.isArray(stored) ? stored.filter((url) => typeof url === 'string') : []);
  } catch {
    return new Set();
  }
}

export function markLinkOffersSeen(docId: string, urls: string[]): void {
  try {
    const seen = [...new Set([...readSeenLinkOffers(docId), ...urls])];
    localStorage.setItem(SEEN_KEY + docId, JSON.stringify(seen.slice(-SEEN_MAX)));
  } catch {
    // Storage may be unavailable: the offer then simply comes back next visit
  }
}
