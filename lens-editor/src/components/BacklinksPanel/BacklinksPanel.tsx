import { useMemo } from 'react';
import { useNavigation } from '../../contexts/NavigationContext';
import { findPathByUuid } from '../../lib/uuid-to-path';
import { backlinkSources } from '../../lib/backlinks';
import { useBacklinksVersion } from '../../hooks/useBacklinksVersion';
import { RELAY_ID } from '../../App';
import { openDocInNewTab, docUuidFromCompoundId } from '../../lib/url-utils';

interface BacklinksPanelProps {
  currentDocId: string;
}

/**
 * Panel displaying documents that link to the current document.
 * Observes the folder docs' backlinks maps for live updates.
 */
export function BacklinksPanel({ currentDocId }: BacklinksPanelProps) {
  const { metadata, folderDocs, onNavigate } = useNavigation();

  const backlinksVersion = useBacklinksVersion(folderDocs);

  const backlinks = useMemo(() => {
    // Trigger re-compute when backlinksVersion changes
    void backlinksVersion;

    if (folderDocs.size === 0) return [];

    // Extract bare doc UUID and relay prefix from compound ID (relay_uuid-doc_uuid)
    const isCompound = currentDocId.length > 36 && currentDocId[36] === '-';
    const docUuid = isCompound ? currentDocId.slice(37) : currentDocId;
    const relayPrefix = isCompound ? currentDocId.slice(0, 37) : '';

    const allSourceUuids = backlinkSources(docUuid, folderDocs.values());

    // Resolve UUIDs to paths, filtering out missing docs
    return allSourceUuids
      .map((uuid: string) => {
        const path = findPathByUuid(uuid, metadata);
        if (!path) return null;

        const segments = path.split('/').filter(Boolean);
        const filename = (segments.pop() || '').replace(/\.md$/i, '');
        const parentPath = segments.join('/');

        // Build compound doc ID for navigation (relay_uuid-doc_uuid)
        const navId = relayPrefix + uuid;

        return { navId, path, filename, parentPath };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
  }, [folderDocs, currentDocId, metadata, backlinksVersion]);

  // Loading state when no folder docs yet
  if (folderDocs.size === 0) {
    return (
      <div className="p-3 text-sm text-gray-400">
        Loading...
      </div>
    );
  }

  if (backlinks.length === 0) {
    return (
      <div className="p-3 text-sm text-gray-500">
        No backlinks
      </div>
    );
  }

  return (
    <div className="p-3">
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
        Backlinks
      </h3>
      <ul className="space-y-1">
        {backlinks.map(({ navId, filename, parentPath }) => (
          <li key={navId}>
            <button
              onClick={(e) => {
                if (e.ctrlKey || e.metaKey) {
                  openDocInNewTab(RELAY_ID, docUuidFromCompoundId(navId), metadata);
                } else {
                  onNavigate(navId);
                }
              }}
              onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  openDocInNewTab(RELAY_ID, docUuidFromCompoundId(navId), metadata);
                }
              }}
              className="w-full text-left px-2 py-1 text-sm hover:bg-gray-100 rounded transition-colors cursor-pointer"
            >
              {parentPath && (
                <span className="text-xs text-gray-400">{parentPath}/</span>
              )}
              <span className="text-gray-700">{filename}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
