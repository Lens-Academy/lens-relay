import type { FolderMetadata } from '../hooks/useFolderMetadata';

export interface ResolvedDocument {
  docId: string;
  path: string;
}

/**
 * Resolve a page name to a document ID (case-insensitive, matching Obsidian).
 *
 * Resolution strategy depends on whether pageName contains a path separator:
 *
 * - Basename only ("Ideas"): global search across all folders.
 *   Matches any file whose name (without .md) equals pageName.
 *
 * - Path-based ("Notes/Ideas"): scoped to currentFolder when provided.
 *   Matches paths ending with /pageName.md within the folder.
 *   No cross-folder fallback — returns null if not found in currentFolder.
 *
 * All matching is case-insensitive.
 */
export function resolvePageName(
  pageName: string,
  metadata: FolderMetadata,
  currentFolder?: string
): ResolvedDocument | null {
  const hasPath = pageName.includes('/');
  const lowerName = pageName.toLowerCase();
  const lowerPathSuffix = ('/' + pageName + '.md').toLowerCase();

  // Path-based links: scope to currentFolder only
  // Basename links: search globally (ignore currentFolder)
  const folderPrefix = (hasPath && currentFolder) ? `/${currentFolder}/` : null;
  const lowerFolderPrefix = folderPrefix?.toLowerCase() ?? null;

  let basenameMatch: ResolvedDocument | null = null;

  for (const [path, meta] of Object.entries(metadata)) {
    if (meta.type !== 'markdown') continue;

    const lowerPath = path.toLowerCase();

    // Skip entries outside current folder (only for path-based links)
    if (lowerFolderPrefix && !lowerPath.startsWith(lowerFolderPrefix)) continue;

    // Tier 1: Path suffix match — return immediately
    if (lowerPath.endsWith(lowerPathSuffix)) {
      return { docId: meta.id, path };
    }

    // Tier 2: Basename match — save as fallback (only for non-path links)
    if (!hasPath && !basenameMatch) {
      const filename = path.split('/').pop() || '';
      const nameWithoutExt = filename.replace(/\.md$/i, '');
      if (nameWithoutExt.toLowerCase() === lowerName) {
        basenameMatch = { docId: meta.id, path };
      }
    }
  }

  return basenameMatch;
}

/**
 * Generate a path for a new document from a page name.
 * Sanitizes filename and adds .md extension.
 */
export function generateNewDocPath(pageName: string): string {
  // Sanitize: remove characters not allowed in filenames
  const safeName = pageName.replace(/[/\\?%*:|"<>]/g, '-');
  return `/${safeName}.md`;
}
