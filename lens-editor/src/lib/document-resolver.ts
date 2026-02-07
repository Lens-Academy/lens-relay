import type { FolderMetadata } from '../hooks/useFolderMetadata';

export interface ResolvedDocument {
  docId: string;
  path: string;
}

/**
 * Resolve a page name to a document ID.
 * Matches by:
 * 1. Exact filename match (without .md extension) - preferred
 * 2. Case-insensitive filename match - fallback
 * Returns null if no match found.
 */
export function resolvePageName(
  pageName: string,
  metadata: FolderMetadata
): ResolvedDocument | null {
  const lowerName = pageName.toLowerCase();
  let caseInsensitiveMatch: ResolvedDocument | null = null;

  for (const [path, meta] of Object.entries(metadata)) {
    if (meta.type !== 'markdown') continue;

    // Extract filename without extension
    const filename = path.split('/').pop() || '';
    const nameWithoutExt = filename.replace(/\.md$/i, '');

    // Exact match - return immediately (highest priority)
    if (nameWithoutExt === pageName) {
      return { docId: meta.id, path };
    }

    // Case-insensitive match - save as fallback (only keep first)
    if (!caseInsensitiveMatch && nameWithoutExt.toLowerCase() === lowerName) {
      caseInsensitiveMatch = { docId: meta.id, path };
    }
  }

  // Return case-insensitive match if no exact match found
  return caseInsensitiveMatch;
}

/**
 * Generate a path for a new document from a page name.
 * Sanitizes filename and adds .md extension.
 */
export function generateNewDocPath(pageName: string): string {
  // Sanitize: remove characters not allowed in filenames
  const safeName = pageName.replace(/[/\\?%*:|"<>]/g, '-');
  return `${safeName}.md`;
}
