import { useCallback, useEffect, useMemo, useState } from 'react';
import type * as Y from 'yjs';
import { useNavigation } from '../../contexts/NavigationContext';
import { useBacklinksVersion } from '../../hooks/useBacklinksVersion';
import { backlinkSources } from '../../lib/backlinks';
import { uuidToPathIndex } from '../../lib/uuid-to-path';
import { basenameOf } from '../../lib/course-tree';
import type { FolderMetadata } from '../../hooks/useFolderMetadata';
import {
  MAX_FILES,
  belowTwoLevels,
  buildAncestors,
  isConceptPath,
  resolveParents,
  sameParents,
  type Ancestors,
  type Below,
  type ParentsOf,
  type ResolvedParents,
} from '../../lib/concept-graph';
import { useSnapshots } from '../ConceptRowsPanel/useConceptRows';

export interface ConceptGraph {
  /** The opened file's own parents (live from its text). */
  own: ResolvedParents;
  ancestors: Ancestors;
  /** Children and their counts; empty while the panel is collapsed. */
  below: Below;
  /** More files were wanted than MAX_FILES. */
  filesCut: boolean;
  /** Concept files that could not be read (counted as having no parents). */
  failed: number;
  parentsOf: ParentsOf;
  nameOf: (id: string) => string;
  pathOf: (id: string) => string | undefined;
}

/**
 * The opened file's parents, from its live text, as state that changes only
 * when the resolved or unresolved lists change, so typing elsewhere in the
 * file does not recompute the graph.
 */
function useOwnParents(ytext: Y.Text, path: string, metadata: FolderMetadata): ResolvedParents {
  const [own, setOwn] = useState<ResolvedParents>(() => resolveParents(ytext.toString(), path, metadata));
  useEffect(() => {
    const update = () => {
      const next = resolveParents(ytext.toString(), path, metadata);
      setOwn((prev) => (sameParents(prev, next) ? prev : next));
    };
    update();
    ytext.observe(update);
    return () => ytext.unobserve(update);
  }, [ytext, path, metadata]);
  return own;
}

/**
 * The concept graph around the opened concept file `self` (bare uuid) at
 * `path`: its parents from its own (live) text; ancestors and everything
 * below from the other concept files, read as the relationships panel reads
 * them (cached snapshots, lib/embed-docs.ts). Children are the backlinkers in
 * the concepts folder whose parents include the file, looked up as the walk
 * reaches each concept. Files are read as the walks reach them, so the result
 * fills in over a few renders; every walk is capped (lib/concept-graph.ts).
 */
export function useConceptGraph(
  self: string,
  path: string,
  ytext: Y.Text,
  /** The panel is open: keep the files fresh. */
  refreshing: boolean,
): ConceptGraph {
  const { metadata, folderDocs } = useNavigation();
  const backlinksVersion = useBacklinksVersion(folderDocs);
  const pathIndex = uuidToPathIndex(metadata);
  const own = useOwnParents(ytext, path, metadata);

  const candidatesOf = useMemo(() => {
    void backlinksVersion;
    return (id: string) => backlinkSources(id, folderDocs.values()).filter((s) => isConceptPath(pathIndex.get(s)));
  }, [folderDocs, backlinksVersion, pathIndex]);

  // Which files to read grows as the walks reach further (texts → ids → texts).
  const [ids, setIds] = useState<string[]>([]);
  const { texts, failed } = useSnapshots(ids, refreshing);

  const parentsById = useMemo(() => {
    const out = new Map<string, ResolvedParents>();
    for (const [id, text] of texts) {
      const p = pathIndex.get(id);
      if (p) out.set(id, resolveParents(text, p, metadata));
    }
    return out;
  }, [texts, pathIndex, metadata]);
  const parentsOf = useCallback<ParentsOf>((id) => {
    if (id === self) return own;
    const known = parentsById.get(id);
    if (known) return known;
    // Unreadable, or gone from the tree: no parents, so the walks finish.
    if (failed.has(id) || !pathIndex.has(id)) return { parents: [], unresolved: [] };
    return undefined;
  }, [self, own, parentsById, failed, pathIndex]);

  const nameOf = useCallback((id: string) => {
    const p = pathIndex.get(id);
    return p ? basenameOf(p) : id;
  }, [pathIndex]);
  const pathOf = useCallback((id: string) => pathIndex.get(id), [pathIndex]);

  const ancestors = useMemo(() => buildAncestors(self, parentsOf), [self, parentsOf]);
  // Collapsed, the header shows only the main path: nothing below is read.
  const below = useMemo(
    () => (refreshing ? belowTwoLevels(self, candidatesOf, parentsOf, nameOf) : EMPTY_BELOW),
    [refreshing, self, candidatesOf, parentsOf, nameOf],
  );

  // Ancestors first, then children, then the counts' files, at most MAX_FILES.
  const { wanted, filesCut } = useMemo(() => {
    const list = [...new Set([...ancestors.nodes, ...below.reads])].filter((id) => id !== self);
    return { wanted: list.slice(0, MAX_FILES).sort(), filesCut: list.length > MAX_FILES };
  }, [ancestors, below, self]);
  // Adjusted during render (React's "storing information from previous
  // renders"), so no extra effect pass per level.
  if (ids.join(',') !== wanted.join(',')) setIds(wanted);

  const failedCount = ids.filter((id) => failed.has(id) && !texts.has(id)).length;
  return useMemo(
    () => ({ own, ancestors, below, filesCut, failed: failedCount, parentsOf, nameOf, pathOf }),
    [own, ancestors, below, filesCut, failedCount, parentsOf, nameOf, pathOf],
  );
}

const EMPTY_BELOW: Below = {
  children: [],
  counts: new Map(),
  candidatesCut: 0,
  cycle: false,
  reads: [],
  pendingChildren: 0,
  pendingCounts: 0,
};
