import { useEffect, useMemo, useState } from 'react';
import { useNavigation } from '../../contexts/NavigationContext';
import { useBacklinksVersion } from '../../hooks/useBacklinksVersion';
import { backlinkSources } from '../../lib/backlinks';
import { uuidToPathIndex } from '../../lib/uuid-to-path';
import { cachedSnapshot, onSnapshot, readSnapshot, refreshSnapshot } from '../../lib/embed-docs';
import { collectRows, isLensPath, lensesUsing, rowsFolder, type CollectedRows, type ConceptRowRule } from '../../lib/concept-rows';
import { RELAY_ID } from '../../App';

/** A row just added here: the backlinks index learns of it a moment later. */
export interface AddedSource {
  target: string;
  source: string;
}

/** While the panel is open and the page visible, concept files are read
 *  again this often, besides on window focus. Each read is a full connection
 *  to the relay, so not more often. */
export const SNAPSHOT_REFRESH_MS = 5 * 60_000;

/**
 * Text of each document in `ids` (bare uuids), read as embeds read: cached,
 * at most three at a time (lib/embed-docs.ts), and updated whenever an edit
 * made here is closed. While `refreshing` (the panel is open), read again on
 * window focus and when the tab becomes visible (unless read in the last
 * SNAPSHOT_TTL_MS), and every SNAPSHOT_REFRESH_MS, so edits made elsewhere
 * show up.
 */
export function useSnapshots(
  ids: readonly string[],
  refreshing = true,
): { texts: Map<string, string>; failed: Set<string> } {
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

  useEffect(() => {
    if (!refreshing) return;
    const ids = key.split(',').filter(Boolean);
    // Focus and visibility read through the snapshot cache (SNAPSHOT_TTL_MS),
    // so switching windows back and forth costs nothing; only the timer
    // forces a read.
    const onReturn = () => {
      if (document.visibilityState === 'hidden') return;
      for (const id of ids) readSnapshot(`${RELAY_ID}-${id}`).catch(() => {});
    };
    const onTimer = () => {
      if (document.visibilityState === 'hidden') return;
      for (const id of ids) refreshSnapshot(`${RELAY_ID}-${id}`).catch(() => {});
    };
    const timer = setInterval(onTimer, SNAPSHOT_REFRESH_MS);
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [key, refreshing]);

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
  /** The panel is open: keep the files fresh (useSnapshots). */
  refreshing: boolean,
): { byTarget: Map<string, CollectedRows>; failed: number; failedFor: (target: string) => number } {
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
  const { texts, failed } = useSnapshots(ids, refreshing);

  const byTarget = useMemo(() => {
    const out = new Map<string, CollectedRows>();
    for (const [target, sources] of sourcesByTarget) {
      out.set(target, collectRows(target, sources, texts, metadata, rule, (id) => pathIndex.get(id) ?? null));
    }
    return out;
  }, [sourcesByTarget, texts, metadata, rule, pathIndex]);

  const unread = (id: string) => failed.has(id) && !texts.has(id);
  return {
    byTarget,
    failed: ids.filter(unread).length,
    failedFor: (target) => (sourcesByTarget.get(target) ?? []).filter(unread).length,
  };
}

/**
 * The lenses that use the article or video `target` (bare uuid) as a
 * `source::`, for rules with lens context: its backlinkers in the lenses
 * folder, read (cached and refreshed as concept files are, useSnapshots) and
 * kept when one of their `source::` links resolves to it. Every such lens,
 * no cap; `pending` counts lenses not read yet.
 */
export function useLensesUsing(
  rule: ConceptRowRule,
  target: string,
  refreshing: boolean,
): { lenses: Array<{ id: string; path: string }>; pending: number } {
  const enabled = !!rule.lensContext;
  const { metadata, folderDocs } = useNavigation();
  const backlinksVersion = useBacklinksVersion(folderDocs);
  const pathIndex = uuidToPathIndex(metadata);

  const candidates = useMemo(() => {
    void backlinksVersion;
    if (!enabled) return [];
    return backlinkSources(target, folderDocs.values())
      .filter((id) => {
        const path = pathIndex.get(id);
        return !!path && isLensPath(path, rule.sharedFolder);
      })
      .sort();
  }, [enabled, target, folderDocs, backlinksVersion, pathIndex, rule.sharedFolder]);

  const { texts, failed } = useSnapshots(candidates, refreshing);

  return useMemo(() => {
    const out = lensesUsing(target, candidates, texts, metadata, rule.sharedFolder, (id) => pathIndex.get(id) ?? null);
    // A lens that could not be read is not waited for.
    const unread = candidates.filter((id) => failed.has(id) && !texts.has(id)).length;
    return { lenses: out.lenses, pending: Math.max(0, out.pending - unread) };
  }, [target, candidates, texts, failed, metadata, rule.sharedFolder, pathIndex]);
}
