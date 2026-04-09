import { parseWikilink } from 'lens-content-processor/dist/parser/wikilink.js';

/**
 * Resolve a relative path against a source file's directory.
 * Browser-compatible — no Node path module needed.
 */
export function resolveRelativePath(relativePath: string, sourceFile: string): string {
  const lastSlash = sourceFile.lastIndexOf('/');
  const sourceDir = lastSlash !== -1 ? sourceFile.slice(0, lastSlash) : '';

  const baseParts = sourceDir ? sourceDir.split('/') : [];
  const relParts = relativePath.split('/');

  const result = [...baseParts];
  for (const part of relParts) {
    if (part === '..') {
      result.pop();
    } else if (part !== '.' && part !== '') {
      result.push(part);
    }
  }

  return result.join('/');
}

/**
 * Resolve a wikilink string to a relay doc UUID using folder metadata.
 */
export function resolveWikilinkToUuid(
  wikilinkText: string,
  sourceFile: string,
  metadata: Record<string, { id: string; [key: string]: unknown }>
): string | null {
  const parsed = parseWikilink(wikilinkText.trim());
  if (!parsed || parsed.error || !parsed.path) return null;

  const resolved = resolveRelativePath(parsed.path, sourceFile);

  if (metadata[resolved]) return metadata[resolved].id;

  const withMd = resolved + '.md';
  if (metadata[withMd]) return metadata[withMd].id;

  return null;
}
