const PLATFORM_BASE = 'https://staging.lensacademy.org';

/** Content type mappings: folder name → URL path prefix (case-sensitive). */
const CONTENT_TYPE_MAP: Record<string, string> = {
  'articles': 'article',
  'Lenses': 'lens',
  'modules': 'module',
  'courses': 'course',
};

/** Content types whose platform URL comes from the frontmatter slug, not the filename. */
const FRONTMATTER_SLUG_FOLDERS = new Set(['modules', 'courses']);

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
 * Convert a section title to the platform's URL hash anchor.
 * Replicates lens-platform web_frontend/src/utils/extractHeadings.ts generateHeadingId().
 */
export function headingAnchor(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50);
}

/**
 * Platform URL for a module, optionally scoped to a course and anchored to a lens.
 * Course-scoped links keep the platform inside the course (sidebar, progress,
 * next-module navigation) instead of dropping the user on the standalone
 * /module/... page.
 */
export function getModulePlatformUrl(
  moduleSlug: string,
  opts: { courseSlug?: string; lensTitle?: string } = {},
): string {
  const base = opts.courseSlug
    ? `${PLATFORM_BASE}/course/${opts.courseSlug}/module/${moduleSlug}`
    : `${PLATFORM_BASE}/module/${moduleSlug}`;
  const anchor = opts.lensTitle ? headingAnchor(opts.lensTitle) : '';
  return anchor ? `${base}#${anchor}` : base;
}

/**
 * Derive the Lens Platform URL for a relay document path.
 * Articles and lenses derive slugs from filenames.
 * Modules and courses require an explicit frontmatter slug — returns null without one.
 *
 * @param originalPath - The path within the relay folder (e.g., "/articles/My Article.md")
 * @param frontmatterSlug - Optional slug from the document's YAML frontmatter (used for modules and courses)
 * @returns Platform URL or null if the path doesn't map to a known content type
 */
export function getPlatformUrl(originalPath: string, frontmatterSlug?: string): string | null {
  const segments = originalPath.split('/').filter(Boolean);
  if (segments.length < 2) return null;

  const folder = segments[0];
  const urlPrefix = CONTENT_TYPE_MAP[folder];
  if (!urlPrefix) return null;

  if (FRONTMATTER_SLUG_FOLDERS.has(folder)) {
    if (!frontmatterSlug) return null;
    return `${PLATFORM_BASE}/${urlPrefix}/${frontmatterSlug}`;
  }

  const slug = fileNameToSlug(segments[segments.length - 1]);
  return `${PLATFORM_BASE}/${urlPrefix}/${slug}`;
}
