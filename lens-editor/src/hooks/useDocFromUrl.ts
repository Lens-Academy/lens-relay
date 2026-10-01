import { RELAY_ID } from '../lib/constants';
import type { FolderMetadata } from './useFolderMetadata';
import { useResolvedDocId } from './useResolvedDocId';
import { useOpenByPath } from './useOpenByPath';

export interface DocFromUrl {
  /** Full compound doc ID when the first segment resolved as a doc prefix. */
  docId: string | null;
  /** True when the URL is being treated as a vault path instead. */
  asPath: boolean;
  /** Canonical prefixed pathname to redirect to (vault path resolved). */
  redirectTo: string | null;
  /** Neither a doc prefix nor a vault path. */
  notFound: boolean;
  /** The vault path lookup failed (relay down, token rejected). */
  failed: boolean;
}

/**
 * What an editor URL `/:docUuid/*` points at. The first segment is tried as a
 * doc prefix first; if it is not hex, or no doc has that prefix, the whole
 * (encoded) pathname is a vault path, e.g. `/Lens/Some%20Doc.md`, and resolves
 * to the canonical `/{prefix}/{path}` URL.
 */
export function useDocFromUrl(
  docUuid: string | undefined,
  pathname: string,
  metadata: FolderMetadata,
): DocFromUrl {
  const isPrefix = !!docUuid && /^[0-9a-f-]+$/i.test(docUuid);
  const { docId, notFound: noSuchPrefix } = useResolvedDocId(
    isPrefix ? `${RELAY_ID}-${docUuid}` : '',
    metadata,
  );
  const asPath = !!docUuid && (!isPrefix || noSuchPrefix);
  const open = useOpenByPath(asPath ? pathname : null);
  return {
    docId: asPath ? null : docId,
    asPath,
    redirectTo: open.target,
    notFound: open.notFound,
    failed: open.failed,
  };
}
