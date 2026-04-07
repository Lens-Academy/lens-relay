const PLATFORM_BASE = 'https://staging.lensacademy.org';

/** Content type mappings: folder name → URL path prefix (case-sensitive). */
const CONTENT_TYPE_MAP: Record<string, string> = {
  'articles': 'article',
  'Lenses': 'lens',
  'modules': 'module',
};

/**
 * Convert a filename to a URL slug.
 * Replicates lens-platform content_processor/src/utils/slug.ts fileNameToSlug().
 */
function fileNameToSlug(fileName: string): string {
  const base = fileName.split('/').pop() ?? fileName;
  const slug = base
    .replace(/\.md$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'untitled';
}

/**
 * Derive the Lens Platform URL for a relay document path.
 * @param originalPath - The path within the relay folder (e.g., "/articles/My Article.md")
 * @returns Platform URL or null if the path doesn't map to a known content type
 */
export function getPlatformUrl(originalPath: string): string | null {
  // Path format: /folder/rest... — extract the first segment
  const segments = originalPath.split('/').filter(Boolean);
  if (segments.length < 2) return null;

  const folder = segments[0];
  const urlPrefix = CONTENT_TYPE_MAP[folder];
  if (!urlPrefix) return null;

  const slug = fileNameToSlug(segments[segments.length - 1]);
  return `${PLATFORM_BASE}/${urlPrefix}/${slug}`;
}
