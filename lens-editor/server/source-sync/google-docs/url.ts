/** A Google Doc as a share link names it: the document, and optionally one tab. */
export interface GoogleDocRef {
  documentId: string;
  tabId: string | null;
}

// /document/d/<id>/…, and the account (/u/<n>/) and Workspace-domain (/a/<domain>/) forms.
const DOC_PATH_RE = /^(?:\/a\/[^/]+)?\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{20,})(?:\/|$)/;

/**
 * Parse a Google Docs link ("…/document/d/<id>/edit?tab=t.0#heading=…").
 * Returns null for anything else, including "Publish to web" links
 * (/document/d/e/<pub-id>/pub), whose id the Docs API does not accept.
 */
export function parseGoogleDocUrl(url: string): GoogleDocRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.hostname !== "docs.google.com") return null;
  const match = DOC_PATH_RE.exec(parsed.pathname);
  if (!match) return null;
  return { documentId: match[1], tabId: parsed.searchParams.get("tab") || null };
}

/** The link a person opens to edit the doc (and tab). */
export function googleDocEditUrl(ref: GoogleDocRef): string {
  const base = `https://docs.google.com/document/d/${ref.documentId}/edit`;
  return ref.tabId ? `${base}?tab=${encodeURIComponent(ref.tabId)}` : base;
}
