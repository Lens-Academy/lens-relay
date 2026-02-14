import type { FolderMetadata } from '../hooks/useFolderMetadata';

export interface ResolvedDocument {
  docId: string;
  path: string;
}

/**
 * Resolve a pageName relative to the directory containing currentFilePath.
 * Returns an absolute path with .md extension.
 */
export function resolveRelative(currentFilePath: string, pageName: string): string {
  const lastSlash = currentFilePath.lastIndexOf('/');
  const dir = currentFilePath.substring(0, lastSlash);
  const segments = dir.split('/').filter(s => s !== '');

  for (const part of pageName.split('/')) {
    if (part === '..') {
      if (segments.length > 0) segments.pop();
    } else if (part !== '.' && part !== '') {
      segments.push(part);
    }
  }

  return '/' + segments.join('/') + '.md';
}

/**
 * Compute the relative path from one file to another (for autocomplete display).
 * Inverse of resolveRelative.
 */
export function computeRelativePath(fromFilePath: string, toFilePath: string): string {
  const fromParts = fromFilePath.split('/');
  const toParts = toFilePath.split('/');

  fromParts.pop(); // remove filename → directory segments
  const toFileName = toParts.pop()!;
  const toName = toFileName.replace(/\.md$/i, '');

  let common = 0;
  while (common < fromParts.length && common < toParts.length
         && fromParts[common] === toParts[common]) {
    common++;
  }

  const ups = fromParts.length - common;
  const parts: string[] = [];
  for (let i = 0; i < ups; i++) parts.push('..');
  for (let i = common; i < toParts.length; i++) parts.push(toParts[i]);
  parts.push(toName);

  return parts.join('/');
}

/**
 * Resolve a page name to a document ID using filesystem path semantics.
 *
 * Resolution order:
 * 1. Relative — resolve pageName from currentFilePath's directory
 * 2. Absolute — treat pageName as path from root: /{pageName}.md
 * 3. Fail — return null
 *
 * All matching is case-insensitive.
 */
export function resolvePageName(
  pageName: string,
  metadata: FolderMetadata,
  currentFilePath?: string
): ResolvedDocument | null {
  const relativePath = currentFilePath ? resolveRelative(currentFilePath, pageName) : null;
  const absolutePath = '/' + pageName + '.md';

  const lowerRelative = relativePath?.toLowerCase() ?? null;
  const lowerAbsolute = absolutePath.toLowerCase();

  let absoluteMatch: ResolvedDocument | null = null;

  for (const [path, meta] of Object.entries(metadata)) {
    if (meta.type !== 'markdown') continue;
    const lowerPath = path.toLowerCase();

    // Priority 1: relative match — return immediately
    if (lowerRelative && lowerPath === lowerRelative) {
      return { docId: meta.id, path };
    }

    // Priority 2: absolute match — save as fallback
    if (!absoluteMatch && lowerPath === lowerAbsolute) {
      absoluteMatch = { docId: meta.id, path };
    }
  }

  return absoluteMatch;
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
