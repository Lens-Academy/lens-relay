import { useYDoc } from '../../lib/ydoc-provider';
import { syncSourceLabel } from '../../../shared/source-sync';
import { useSyncMarker } from './useSyncMarker';

/** Warns that the open file is a synced copy, so edits made here will not last. */
export function SyncedFileBanner() {
  const marker = useSyncMarker(useYDoc());
  if (!marker) return null;
  const source = syncSourceLabel(marker.source);
  return (
    <div className="mx-auto max-w-[700px] w-full px-6">
      <div role="note" className="px-4 py-2.5 bg-amber-50 border border-amber-200 rounded-md text-sm text-amber-800">
        This file is synced from {source}. Any changes you make here will be overwritten the next
        time it syncs.{' '}
        <a href={marker.url} target="_blank" rel="noopener noreferrer" className="underline font-medium">
          Edit it in {source}
        </a>{' '}
        instead.
      </div>
    </div>
  );
}
