import type { FolderMetadata } from '../hooks/useFolderMetadata';

/** Length of the short UUID prefix used in URLs. */
export const SHORT_UUID_LENGTH = 8;

/**
 * Extract the doc UUID (last 36 chars) from a compound doc ID.
 * Compound ID format: {RELAY_ID (36)}-{DOC_UUID (36)}
 */
export function docUuidFromCompoundId(compoundId: string): string {
  return compoundId.slice(37);
}

/**
 * Build a compound doc ID from relay ID + doc UUID.
 */
export function compoundIdFromDocUuid(relayId: string, docUuid: string): string {
  return `${relayId}-${docUuid}`;
}

/**
 * Return the first 8 characters of a UUID for use in URLs.
 */
export function shortUuid(uuid: string): string {
  return uuid.slice(0, SHORT_UUID_LENGTH);
}

/**
 * Build a URL path for a document using a short UUID.
 * Format: /{shortUuid}/{folder}/{path}
 * The path after the UUID is decorative (for human readability in shared links).
 * Falls back to just /{shortUuid} if no metadata match found.
 */
export function urlForDoc(compoundDocId: string, metadata: FolderMetadata): string {
  const docUuid = docUuidFromCompoundId(compoundDocId);
  const short = shortUuid(docUuid);

  // Find the file path in metadata by matching the doc UUID
  for (const [path, meta] of Object.entries(metadata)) {
    if (meta.id === docUuid) {
      // Replace spaces with dashes for readability
      // (the path is decorative — the UUID is the canonical identifier)
      const encodedPath = path
        .split('/')
        .map((segment) => segment.replace(/ /g, '-'))
        .join('/');
      return `/${short}${encodedPath}`;
    }
  }

  return `/${short}`;
}

/**
 * Build a compound doc ID from a URL param doc UUID.
 * This is a pure string operation — no metadata lookup needed.
 * Works with both full UUIDs and short prefixes.
 */
export function docIdFromUrlParam(docUuid: string, relayId: string): string {
  return compoundIdFromDocUuid(relayId, docUuid);
}
