/**
 * Extract per-character authorship runs from a Y.Text.
 *
 * Every Y.Text item permanently carries the clientID of the Y.Doc instance
 * that created it — that is the provenance substrate (see docs/plans/
 * 2026-07-18-provenance-design.md). This walks the item chain and returns
 * contiguous same-client runs whose offsets align 1:1 with the visible text.
 *
 * Uses yjs internals (`ytext._start`, item linked list). These fields are
 * underscore-private but have been stable across yjs 13.x for years; the
 * round-trip test in authorship-runs.test.ts guards against breakage.
 */
import type * as Y from 'yjs';

export interface AuthorshipRun {
  from: number;
  to: number;
  client: number;
  /** Start clock of the run's first item. Runs only merge when clocks are
   *  contiguous, so `[clock, clock + (to - from))` is the exact clock range
   *  of the characters — what the recent-changes overlay matches activity
   *  events against. (Y.Text item lengths and CM positions are both UTF-16.) */
  clock: number;
}

interface YItemLike {
  deleted: boolean;
  countable: boolean;
  length: number;
  id: { client: number; clock: number };
  right: YItemLike | null;
}

export function getAuthorshipRuns(ytext: Y.Text): AuthorshipRun[] {
  const runs: AuthorshipRun[] = [];
  let item = (ytext as unknown as { _start: YItemLike | null })._start;
  let pos = 0;

  while (item) {
    if (!item.deleted && item.countable && item.length > 0) {
      const { client, clock } = item.id;
      const last = runs[runs.length - 1];
      if (
        last &&
        last.to === pos &&
        last.client === client &&
        last.clock + (last.to - last.from) === clock
      ) {
        last.to = pos + item.length;
      } else {
        runs.push({ from: pos, to: pos + item.length, client, clock });
      }
      pos += item.length;
    }
    item = item.right;
  }

  return runs;
}
