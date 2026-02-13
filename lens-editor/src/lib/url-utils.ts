import type { FolderMetadata } from '../hooks/useFolderMetadata';

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
 * Build a URL path for a document.
 * Format: /{docUuid}/{folder}/{path}
 * The path after the UUID is decorative (for human readability in shared links).
 * Falls back to just /{docUuid} if no metadata match found.
 */
export function urlForDoc(compoundDocId: string, metadata: FolderMetadata): string {
  const docUuid = docUuidFromCompoundId(compoundDocId);

  // Find the file path in metadata by matching the doc UUID
  for (const [path, meta] of Object.entries(metadata)) {
    if (meta.id === docUuid) {
      // Encode each path segment, replacing spaces with dashes for readability
      // (the path is decorative — the UUID is the canonical identifier)
      const encodedPath = path
        .split('/')
        .map((segment) => segment.replace(/ /g, '-'))
        .join('/');
      return `/${docUuid}${encodedPath}`;
    }
  }

  return `/${docUuid}`;
}

/**
 * Build a compound doc ID from a URL param doc UUID.
 * This is a pure string operation -- no metadata lookup needed.
 */
export function docIdFromUrlParam(docUuid: string, relayId: string): string {
  return compoundIdFromDocUuid(relayId, docUuid);
}
