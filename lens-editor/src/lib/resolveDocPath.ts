/**
 * Parse a wikilink string into its components.
 * Handles [[path]], [[path|display]], ![[path]], ![[path|display]] and
 * drops a `#heading` anchor from the path, as the relay's link indexer does.
 * Browser-compatible — no Node dependencies.
 */
export function parseWikilink(text: string): { path: string; display?: string; isEmbed?: boolean } | null {
  const match = text.match(/^(!?)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/);
  if (!match) return null;
  return {
    path: match[2].split('#')[0].trim(),
    display: match[3]?.trim(),
    isEmbed: match[1] === '!',
  };
}

/**
 * Derive a human-readable title from a wikilink path.
 * [[../modules/feedback-loops]] → "Feedback Loops"
 * [[../modules/Cognitive Superpowers]] → "Cognitive Superpowers"
 */
export function titleFromWikilink(wikilinkText: string): string {
  const match = wikilinkText.match(/\[\[([^\]|]+)/);
  const path = match ? match[1].trim() : wikilinkText;
  const filename = path.split('/').pop() ?? path;
  const base = filename.replace(/\.md$/, '');
  return base.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

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
  metadata: Record<string, { id: string }>
): string | null {
  const parsed = parseWikilink(wikilinkText.trim());
  if (!parsed || !parsed.path) return null;
  return resolvePathToUuid(parsed.path, sourceFile, metadata);
}

/** Resolve an already-parsed wikilink path (relative to the source file) to a doc UUID. */
export function resolvePathToUuid(
  linkPath: string,
  sourceFile: string,
  metadata: Record<string, { id: string }>
): string | null {
  const canonicalPath = linkPath.replace(/\.md$/i, '');
  const resolved = resolveRelativePath(canonicalPath, sourceFile);

  // Try all combinations: with/without leading /, with/without .md extension
  const candidates = [
    resolved,
    resolved + '.md',
    '/' + resolved,
    '/' + resolved + '.md',
    resolved.replace(/^\//, ''),
    resolved.replace(/^\//, '') + '.md',
  ];

  for (const candidate of candidates) {
    if (metadata[candidate]) return metadata[candidate].id;
  }

  return null;
}
