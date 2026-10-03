import type { FileMetadata, FolderMetadata } from '../hooks/useFolderMetadata';

export interface ResolvedDocument {
  docId: string;
  path: string;
}

/**
 * Whether a wiki link can point at this file: a Markdown document, or an HTML
 * page (widgets are `widgets/<name>.html`). Keep in step with the relay's
 * `is_link_target` in link_indexer.rs.
 */
export function isLinkTarget(path: string, meta: Pick<FileMetadata, 'type'>): boolean {
  if (/\.html$/i.test(path)) return true;
  return meta.type === 'markdown';
}

/**
 * Resolve a pageName relative to the directory containing currentFilePath.
 * Returns an absolute path with .md extension, or with .html when the link
 * names an .html file.
 */
export function resolveRelative(currentFilePath: string, pageName: string): string {
  const isHtml = /\.html$/i.test(pageName);
  const canonicalPageName = pageName.replace(/\.(md|html)$/i, '');
  const lastSlash = currentFilePath.lastIndexOf('/');
  const dir = currentFilePath.substring(0, lastSlash);
  const segments = dir.split('/').filter(s => s !== '');

  for (const part of canonicalPageName.split('/')) {
    if (part === '..') {
      if (segments.length > 0) segments.pop();
    } else if (part !== '.' && part !== '') {
      segments.push(part);
    }
  }

  return '/' + segments.join('/') + (isHtml ? '.html' : '.md');
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
  // Links leave out the extension, for HTML pages too: [[x]] finds x.md, then x.html
  const toName = toFileName.replace(/\.(md|html)$/i, '');

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
 * At each step a link without an extension finds {name}.md, and failing that
 * {name}.html (widgets are HTML pages); [[name.md]] and [[name.html]] find only that file.
 * A #heading anchor and surrounding whitespace are ignored (as in link-extractor),
 * so [[Page#Heading]] resolves to Page and [[#Heading]] resolves to nothing.
 * All matching is case-insensitive.
 */
export function resolvePageName(
  pageName: string,
  metadata: FolderMetadata,
  currentFilePath?: string
): ResolvedDocument | null {
  const anchorIndex = pageName.indexOf('#');
  const page = (anchorIndex === -1 ? pageName : pageName.substring(0, anchorIndex)).trim();
  if (!page) return null;
  // [[x.md]] names the Markdown file: no .html fallback, as in the content processor
  const namesMarkdown = /\.md$/i.test(page);
  const canonicalPageName = page.replace(/\.md$/i, '');
  const relativePath = currentFilePath ? resolveRelative(currentFilePath, canonicalPageName) : null;
  const absolutePath = /\.html$/i.test(canonicalPageName)
    ? '/' + canonicalPageName
    : '/' + canonicalPageName + '.md';

  // Candidates in priority order: each .md path is followed by its .html twin.
  const candidates: string[] = [];
  for (const path of [relativePath, absolutePath]) {
    if (!path) continue;
    candidates.push(path.toLowerCase());
    if (!namesMarkdown && path.endsWith('.md')) candidates.push(path.slice(0, -3).toLowerCase() + '.html');
  }

  let best: ResolvedDocument | null = null;
  let bestRank = candidates.length;
  for (const [path, meta] of Object.entries(metadata)) {
    if (!isLinkTarget(path, meta)) continue;
    const rank = candidates.indexOf(path.toLowerCase());
    if (rank !== -1 && rank < bestRank) {
      best = { docId: meta.id, path };
      bestRank = rank;
      if (rank === 0) break;
    }
  }

  return best;
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
