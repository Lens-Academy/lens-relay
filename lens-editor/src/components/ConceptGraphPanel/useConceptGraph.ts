import { useCallback, useEffect, useMemo, useState } from 'react';
import type * as Y from 'yjs';
import { useNavigation } from '../../contexts/NavigationContext';
import { useBacklinksVersion } from '../../hooks/useBacklinksVersion';
import { backlinkSources } from '../../lib/backlinks';
import { uuidToPathIndex } from '../../lib/uuid-to-path';
import { basenameOf } from '../../lib/course-tree';
import {
  CONCEPTS_FOLDER,
  buildAncestors,
  buildDescendants,
  childrenOf,
  isConceptPath,
  resolveParents,
  type Ancestors,
  type Children,
  type Descendants,
  type ParentsOf,
  type ResolvedParents,
  type TreeNode,
} from '../../lib/concept-graph';
import { useSnapshots } from '../ConceptRowsPanel/useConceptRows';

export interface ConceptGraph {
  /** The opened file's own parents (live from its text). */
  own: ResolvedParents;
  ancestors: Ancestors;
  children: Children;
  /** Only while `withDescendants`. */
  descendants: Descendants | null;
  /** Concept files that could not be read (counted as having no parents). */
  failed: number;
  nameOf: (id: string) => string;
  pathOf: (id: string) => string | undefined;
}

/** The opened file's text, kept live. */
function useLiveText(ytext: Y.Text): string {
  const [text, setText] = useState(() => ytext.toString());
  useEffect(() => {
    const update = () => setText(ytext.toString());
    update();
    ytext.observe(update);
    return () => ytext.unobserve(update);
  }, [ytext]);
  return text;
}

function treeIds(nodes: readonly TreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.repeat) continue;
    out.push(n.id);
    treeIds(n.children, out);
  }
  return out;
}

/**
 * The concept graph around the opened concept file `self` (bare uuid) at
 * `path`: its parents from its own (live) text; ancestors, children and, on
 * request, descendants from the other concept files, read as the relationships
 * panel reads them (cached snapshots, lib/embed-docs.ts). Children are the
 * file's backlinkers in the concepts folder whose `parent:` resolves to it.
 * Files are read as the walks reach them, so the result fills in over a few
 * renders; every walk is capped (lib/concept-graph.ts).
 */
export function useConceptGraph(
  self: string,
  path: string,
  ytext: Y.Text,
  /** The panel is open: keep the files fresh. */
  refreshing: boolean,
  withDescendants: boolean,
): ConceptGraph {
  const { metadata, folderDocs } = useNavigation();
  const backlinksVersion = useBacklinksVersion(folderDocs);
  const pathIndex = uuidToPathIndex(metadata);
  const ownText = useLiveText(ytext);
  const own = useMemo(() => resolveParents(ownText, path, metadata), [ownText, path, metadata]);

  // Concept backlinkers of every concept file, computed once per change.
  const candidatesById = useMemo(() => {
    void backlinksVersion;
    const concepts = Object.entries(metadata).filter(([p]) => isConceptPath(p)).map(([, m]) => m.id);
    const isConcept = (id: string) => {
      const p = pathIndex.get(id);
      return !!p && p.startsWith(CONCEPTS_FOLDER) && isConceptPath(p);
    };
    return new Map(concepts.map((id) => [id, backlinkSources(id, folderDocs.values()).filter(isConcept)]));
  }, [metadata, folderDocs, backlinksVersion, pathIndex]);
  const candidatesOf = useCallback((id: string) => candidatesById.get(id) ?? [], [candidatesById]);

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

  const nameOf = useMemo(() => (id: string) => {
    const p = pathIndex.get(id);
    return p ? basenameOf(p) : id;
  }, [pathIndex]);

  const ancestors = useMemo(() => buildAncestors(self, parentsOf), [self, parentsOf]);
  const children = useMemo(() => {
    const out = childrenOf(self, candidatesOf(self), parentsOf);
    out.ids.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    return out;
  }, [self, candidatesOf, parentsOf, nameOf]);
  const descendants = useMemo(
    () => (withDescendants ? buildDescendants(self, candidatesOf, parentsOf, nameOf) : null),
    [withDescendants, self, candidatesOf, parentsOf, nameOf],
  );

  const wanted = useMemo(() => {
    const set = new Set<string>([...ancestors.nodes, ...candidatesOf(self)]);
    if (descendants) {
      for (const id of treeIds(descendants.tree)) {
        set.add(id);
        for (const c of candidatesOf(id)) set.add(c);
      }
    }
    set.delete(self);
    return [...set].sort();
  }, [ancestors, descendants, candidatesOf, self]);
  // Adjusted during render (React's "storing information from previous
  // renders"), so no extra effect pass per level.
  if (ids.join(',') !== wanted.join(',')) setIds(wanted);

  return {
    own,
    ancestors,
    children,
    descendants,
    failed: ids.filter((id) => failed.has(id) && !texts.has(id)).length,
    nameOf,
    pathOf: (id) => pathIndex.get(id),
  };
}
