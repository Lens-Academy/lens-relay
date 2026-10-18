import { useEffect, useMemo, useState } from 'react';
import { useNavigation } from '../../contexts/NavigationContext';
import { useBacklinksVersion } from '../../hooks/useBacklinksVersion';
import { backlinkSources } from '../../lib/backlinks';
import { uuidToPathIndex } from '../../lib/uuid-to-path';
import { cachedSnapshot, onSnapshot, readSnapshot } from '../../lib/embed-docs';
import { collectRows, rowsFolder, type CollectedRows, type ConceptRowRule } from '../../lib/concept-rows';
import { RELAY_ID } from '../../App';

/** A row just added here: the backlinks index learns of it a moment later. */
export interface AddedSource {
  target: string;
  source: string;
}

/**
 * Text of each document in `ids` (bare uuids), read as embeds read: once,
 * cached, at most three at a time (lib/embed-docs.ts), and updated whenever
 * an edit made here is closed.
 */
function useSnapshots(ids: readonly string[]): { texts: Map<string, string>; failed: Set<string> } {
  const key = ids.join(',');
  const [texts, setTexts] = useState<Map<string, string>>(() => new Map());
  const [failed, setFailed] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const set = (id: string, text: string) =>
      setTexts((prev) => (prev.get(id) === text ? prev : new Map(prev).set(id, text)));
    const unsubscribe = key.split(',').filter(Boolean).map((id) => {
      const fullId = `${RELAY_ID}-${id}`;
      const cached = cachedSnapshot(fullId);
      if (cached !== undefined) set(id, cached);
      readSnapshot(fullId).then(
        (text) => set(id, text),
        () => setFailed((prev) => new Set(prev).add(id)),
      );
      return onSnapshot(fullId, (text) => set(id, text));
    });
    return () => unsubscribe.forEach((fn) => fn());
  }, [key]);

  return { texts, failed };
}

/**
 * The rows about each of `targets` (bare uuids) in the rule's folder: its
 * backlinkers there, read and searched for row headings that resolve to it.
 */
export function useConceptRows(
  rule: ConceptRowRule,
  targets: readonly string[],
  added: readonly AddedSource[],
): { byTarget: Map<string, CollectedRows>; failed: number } {
  const { metadata, folderDocs } = useNavigation();
  const backlinksVersion = useBacklinksVersion(folderDocs);
  const pathIndex = uuidToPathIndex(metadata);
  const folder = `${rowsFolder(rule)}/`;

  const sourcesByTarget = useMemo(() => {
    void backlinksVersion;
    const out = new Map<string, string[]>();
    for (const target of targets) {
      const sources = backlinkSources(target, folderDocs.values());
      for (const a of added) if (a.target === target && !sources.includes(a.source)) sources.push(a.source);
      out.set(target, sources.filter((id) => pathIndex.get(id)?.startsWith(folder)));
    }
    return out;
  }, [targets, added, folderDocs, backlinksVersion, pathIndex, folder]);

  const ids = useMemo(
    () => [...new Set([...sourcesByTarget.values()].flat())].sort(),
    [sourcesByTarget],
  );
  const { texts, failed } = useSnapshots(ids);

  const byTarget = useMemo(() => {
    const out = new Map<string, CollectedRows>();
    for (const [target, sources] of sourcesByTarget) {
      out.set(target, collectRows(target, sources, texts, metadata, rule, (id) => pathIndex.get(id) ?? null));
    }
    return out;
  }, [sourcesByTarget, texts, metadata, rule, pathIndex]);

  return { byTarget, failed: ids.filter((id) => failed.has(id) && !texts.has(id)).length };
}
