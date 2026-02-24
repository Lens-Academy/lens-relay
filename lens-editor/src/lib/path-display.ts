/**
 * Utilities for converting metadata paths to display strings.
 *
 * Metadata paths look like "/Lens Edu/Modules/Module_x/Getting Started.md".
 * These functions strip the leading slash and .md extension to produce
 * human-readable segments and display strings.
 */

/**
 * Split a metadata path into display segments (no leading slash, no .md extension).
 * "/Lens Edu/Modules/Module_x/Getting Started.md" → ["Lens Edu", "Modules", "Module_x", "Getting Started"]
 */
export function pathToSegments(path: string | undefined): string[] {
  if (!path) return [];
  // Strip leading slash, split on /
  const raw = path.startsWith('/') ? path.slice(1) : path;
  const segments = raw.split('/').filter(Boolean);
  if (segments.length === 0) return [];
  // Strip .md from last segment
  const last = segments[segments.length - 1];
  segments[segments.length - 1] = last.replace(/\.md$/i, '');
  return segments;
}

/**
 * Like pathToSegments but excludes the filename (last segment).
 * "/Lens Edu/Modules/Module_x/Getting Started.md" → ["Lens Edu", "Modules", "Module_x"]
 */
export function pathToParentSegments(path: string | undefined): string[] {
  const segments = pathToSegments(path);
  return segments.slice(0, -1);
}

/**
 * Full display string with segments joined by "/".
 * "/Lens Edu/Modules/Module_x/Getting Started.md" → "Lens Edu/Modules/Module_x/Getting Started"
 */
export function pathToDisplayString(path: string | undefined): string {
  return pathToSegments(path).join('/');
}
