import type * as Y from 'yjs';

/**
 * Who has said no to the import-and-link offer on a page. The content doc's
 * `link_offers_v0` Y.Map holds url → { at, by }: a URL in the map is not offered
 * again on this page, to anyone. Right-clicking the link can still import it,
 * which takes it back out. Only a dismissal is recorded here: what became of a
 * source is the server's job list.
 *
 * The offer itself only ever goes to whoever adds a link, as they add it
 * (source-links-session.ts), so the two per-browser records below are about
 * that person: what they have been asked, and what they accepted.
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
 * dismissal, this is one person's: an offer they let pass, accepted or answered
 * is not made again if they write the same link on the page later.
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

// ── What this browser accepted and hasn't seen the end of ────────────────

const ACCEPTED_KEY = 'lens-editor:accepted-link-offers:';
/** Longer than any import with its retries takes. */
const ACCEPTED_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function readAccepted(docId: string, now: number): Record<string, number> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(ACCEPTED_KEY + docId) ?? '{}');
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
    const kept: Record<string, number> = {};
    for (const [url, at] of Object.entries(stored)) {
      if (typeof at === 'number' && now - at < ACCEPTED_TTL_MS) kept[url] = at;
    }
    return kept;
  } catch {
    return {};
  }
}

function writeAccepted(docId: string, accepted: Record<string, number>): void {
  try {
    const urls = Object.keys(accepted).slice(-SEEN_MAX);
    if (urls.length === 0) {
      localStorage.removeItem(ACCEPTED_KEY + docId);
      return;
    }
    const kept = Object.fromEntries(urls.map((url) => [url, accepted[url]]));
    localStorage.setItem(ACCEPTED_KEY + docId, JSON.stringify(kept));
  } catch {
    // Storage may be unavailable: a failure after the page is closed then goes unsaid
  }
}

/**
 * The URLs of a page this browser sent to be imported and whose end it hasn't
 * shown: an import still running, or one that failed after the page was closed,
 * is shown on the next visit, to this person only.
 */
export function readAcceptedLinkOffers(docId: string, now: number = Date.now()): Set<string> {
  return new Set(Object.keys(readAccepted(docId, now)));
}

export function rememberAcceptedLinkOffers(docId: string, urls: string[], now: number = Date.now()): void {
  if (urls.length === 0) return;
  const accepted = readAccepted(docId, now);
  for (const url of urls) {
    delete accepted[url];
    accepted[url] = now;
  }
  writeAccepted(docId, accepted);
}

/** Its end has been shown, or it was answered another way. */
export function forgetAcceptedLinkOffers(docId: string, urls: string[], now: number = Date.now()): void {
  if (urls.length === 0) return;
  const accepted = readAccepted(docId, now);
  if (!urls.some((url) => url in accepted)) return;
  for (const url of urls) delete accepted[url];
  writeAccepted(docId, accepted);
}
