import type { FolderMetadata } from '../hooks/useFolderMetadata';

/**
 * Find the file path for a given document UUID.
 * This is a linear scan - acceptable for <1000 docs.
 */
export function findPathByUuid(uuid: string, metadata: FolderMetadata): string | null {
  for (const [path, meta] of Object.entries(metadata)) {
    if (meta.id === uuid) {
      return path;
    }
  }
  return null;
}
