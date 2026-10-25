import { useEffect, useState } from 'react';
import type * as Y from 'yjs';
import type { FolderMetadata } from '../hooks/useFolderMetadata';

/**
 * Page icons for the sidebar. A page's icon is its frontmatter `icon:`
 * (DocumentTitle sets it), but the sidebar can't read every page's text, so
 * each shared folder's metadata Y.Doc also keeps a map from doc id to icon.
 * DocumentTitle writes it when the icon is set, and again whenever an open
 * page's frontmatter says something else (an icon set elsewhere, e.g. in
 * Obsidian or by the MCP).
 */
const ICONS_MAP = 'lens_page_icons';

function iconsMap(folderDoc: Y.Doc): Y.Map<string> {
  return folderDoc.getMap<string>(ICONS_MAP);
}

/** Record a page's icon (null removes it) in its folder's icon map. */
export function recordPageIcon(folderDoc: Y.Doc, docId: string, icon: string | null): void {
  const map = iconsMap(folderDoc);
  if (icon === null) {
    if (map.has(docId)) map.delete(docId);
  } else if (map.get(docId) !== icon) {
    map.set(docId, icon);
  }
}

function sameEntries(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

/** Every page icon in these folders, by doc id, kept current. */
export function usePageIcons(folderDocs: Map<string, Y.Doc>): Map<string, string> {
  const [icons, setIcons] = useState<Map<string, string>>(() => new Map());

  useEffect(() => {
    const maps = [...folderDocs.values()].map(iconsMap);
    const read = () => {
      const all = new Map<string, string>();
      for (const map of maps) for (const [docId, icon] of map) all.set(docId, icon);
      // Keep the same map when nothing changed: a caller that passes a new
      // Map of the same docs on every render would otherwise render forever
      setIcons((prev) => (sameEntries(prev, all) ? prev : all));
    };
    read();
    for (const map of maps) map.observe(read);
    return () => {
      for (const map of maps) map.unobserve(read);
    };
  }, [folderDocs]);

  return icons;
}

/**
 * Icons for a page's breadcrumb, folder by folder and then the page: a
 * folder's is its "00 - Start Here" page's icon, the page's its own.
 */
export function breadcrumbIcons(path: string, metadata: FolderMetadata, icons: Map<string, string>): (string | undefined)[] {
  const segments = path.replace(/^\//, '').split('/').filter(Boolean);
  return segments.map((_, i) => {
    const id = i === segments.length - 1
      ? metadata[path]?.id
      : metadata[`/${segments.slice(0, i + 1).join('/')}/00 - Start Here.md`]?.id;
    return id ? icons.get(id) : undefined;
  });
}
