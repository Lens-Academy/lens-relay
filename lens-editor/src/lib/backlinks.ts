import type * as Y from 'yjs';

/** Name of the folder-doc map the relay's link indexer writes: target uuid → source uuids. */
export const BACKLINKS_MAP = 'backlinks_v0';

/** Documents that link to `uuid`, deduplicated across all folder docs. */
export function backlinkSources(uuid: string, folderDocs: Iterable<Y.Doc>): string[] {
  const seen = new Set<string>();
  const sources: string[] = [];
  for (const doc of folderDocs) {
    for (const source of doc.getMap<string[]>(BACKLINKS_MAP).get(uuid) ?? []) {
      if (seen.has(source)) continue;
      seen.add(source);
      sources.push(source);
    }
  }
  return sources;
}
