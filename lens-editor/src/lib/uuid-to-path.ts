import type { FolderMetadata } from '../hooks/useFolderMetadata';

// One reverse index per metadata object. Metadata is rebuilt on every
// filemeta update, so the WeakMap lets the index follow it without a
// signature change for callers.
const indexes = new WeakMap<FolderMetadata, Map<string, string>>();

/** uuid → path for every entry in the metadata, built once per metadata object. */
export function uuidToPathIndex(metadata: FolderMetadata): Map<string, string> {
  let index = indexes.get(metadata);
  if (!index) {
    index = new Map();
    for (const [path, meta] of Object.entries(metadata)) index.set(meta.id, path);
    indexes.set(metadata, index);
  }
  return index;
}

/** Find the file path for a given document UUID. */
export function findPathByUuid(uuid: string, metadata: FolderMetadata): string | null {
  return uuidToPathIndex(metadata).get(uuid) ?? null;
}
