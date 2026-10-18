import { useCallback, useEffect, useMemo, useState } from 'react';
import type * as Y from 'yjs';
import { useNavigation } from '../../contexts/NavigationContext';
import { useBacklinksVersion } from '../../hooks/useBacklinksVersion';
import { backlinkSources } from '../../lib/backlinks';
import { uuidToPathIndex } from '../../lib/uuid-to-path';
import { basenameOf } from '../../lib/course-tree';
import type { FolderMetadata } from '../../hooks/useFolderMetadata';
import {
  buildAncestors,
  isConceptPath,
  resolveParents,
  sameParents,
  walkBelow,
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
  /** Everything below, within the caps (children of each concept reached). */
  below: Below;
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

  const ancestors = useMemo(() => buildAncestors(self, parentsOf), [self, parentsOf]);
  const below = useMemo(() => walkBelow(self, candidatesOf, parentsOf, nameOf), [self, candidatesOf, parentsOf, nameOf]);

  const wanted = useMemo(() => {
    const set = new Set<string>(ancestors.nodes);
    for (const id of below.kids.keys()) for (const c of candidatesOf(id)) set.add(c);
    set.delete(self);
    return [...set].sort();
  }, [ancestors, below, candidatesOf, self]);
  // Adjusted during render (React's "storing information from previous
  // renders"), so no extra effect pass per level.
  if (ids.join(',') !== wanted.join(',')) setIds(wanted);

  return {
    own,
    ancestors,
    below,
    failed: ids.filter((id) => failed.has(id) && !texts.has(id)).length,
    parentsOf,
    nameOf,
    pathOf: (id) => pathIndex.get(id),
  };
}
