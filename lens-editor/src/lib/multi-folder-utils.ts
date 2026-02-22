// src/lib/multi-folder-utils.ts
import type { FolderMetadata } from '../hooks/useFolderMetadata';
import type * as Y from 'yjs';

export interface FolderInput {
  name: string;
  metadata: FolderMetadata;
}

/**
 * Merge metadata from multiple folders, prefixing paths with folder names.
 * Example: { "/doc.md": {...} } from "Lens" becomes { "/Lens/doc.md": {...} }
 */
export function mergeMetadata(folders: FolderInput[]): FolderMetadata {
  const merged: FolderMetadata = {};

  for (const folder of folders) {
    for (const [path, meta] of Object.entries(folder.metadata)) {
      const prefixedPath = `/${folder.name}${path}`;
      merged[prefixedPath] = meta;
    }
  }

  return merged;
}

/**
 * Extract folder name from a prefixed path.
 * Uses exact matching with trailing slash to avoid prefix confusion.
 * Example: "/Lens Edu/notes.md" with folders ["Lens", "Lens Edu"] returns "Lens Edu"
 */
export function getFolderNameFromPath(path: string, folderNames: string[]): string | null {
  // Sort by length descending to match longer names first
  // This ensures "Lens Edu" matches before "Lens"
  const sorted = [...folderNames].sort((a, b) => b.length - a.length);

  for (const name of sorted) {
    if (path.startsWith(`/${name}/`) || path === `/${name}`) {
      return name;
    }
  }

  return null;
}

/**
 * Strip the folder prefix from a path to get the original Y.Doc path.
 * Example: "/Lens Edu/notes.md" with folder "Lens Edu" returns "/notes.md"
 */
export function getOriginalPath(prefixedPath: string, folderName: string): string {
  const prefix = `/${folderName}`;
  if (prefixedPath.startsWith(prefix)) {
    return prefixedPath.slice(prefix.length);
  }
  return prefixedPath;
}

/**
 * Get the Y.Doc for a given prefixed path by extracting the folder name.
 */
export function getFolderDocForPath(
  prefixedPath: string,
  folderDocs: Map<string, Y.Doc>,
  folderNames: string[]
): Y.Doc | null {
  const folderName = getFolderNameFromPath(prefixedPath, folderNames);
  if (!folderName) return null;
  return folderDocs.get(folderName) ?? null;
}

/**
 * Generate a unique "Untitled.md" / "Untitled N.md" name for a folder.
 * Checks merged metadata (prefixed paths) for collisions.
 * @param folderPath - The prefixed folder path, e.g. "/Lens" or "/Lens/Notes"
 * @param metadata - The merged folder metadata with prefixed paths
 */
export function generateUntitledName(
  folderPath: string,
  metadata: FolderMetadata
): string {
  const prefix = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;
  const existing = new Set(
    Object.keys(metadata)
      .filter((p) => p.startsWith(prefix))
      .map((p) => p.slice(prefix.length).split('/')[0]) // Only direct children
  );

  if (!existing.has('Untitled.md')) return 'Untitled.md';

  for (let i = 1; ; i++) {
    const candidate = `Untitled ${i}.md`;
    if (!existing.has(candidate)) return candidate;
  }
}
