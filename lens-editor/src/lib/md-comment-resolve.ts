/**
 * Resolve state for Markdown (CriticMarkup) comment threads, stored out of band
 * in the content doc so it never touches the document text:
 *
 *   doc.getMap('md_comments_resolve_v0'): threadRootId → { by, at }
 *
 * Why a map and not the comment's inline metadata: resolving in the metadata
 * means a delete+insert at one offset, which is not conflict-free — two people
 * resolving the same thread before their edits sync corrupt the comment body in
 * the document (and in the git-synced file). A Y.Map entry is last-writer-wins
 * per key, so concurrent resolve/reopen converge without ever touching the
 * prose. This mirrors the HTML editor, whose thread status also lives in an
 * out-of-band Y.Map (`comments_v0`), not in the page markup.
 *
 * `threadRootId` is the stable identity of the thread's first comment
 * (`"<author>|<timestamp>"`, see criticmarkupAdapter.messageIdFor); it survives
 * offset shifts as the document is edited. Legacy comments with no author/
 * timestamp fall back to a `pos:<offset>:<content>` key, which is best-effort:
 * it drifts (resolve state is lost) when text above them shifts their offset,
 * and two identical-content comments that end up at the same offset would share
 * an entry. Accepted edge cases for pre-metadata (e.g. Obsidian-authored)
 * comments; comments created in this editor always carry author+timestamp.
 *
 * Resolve state lives only in the collaborative doc, not in the markdown file,
 * exactly like the HTML editor's thread status.
 */
import * as Y from 'yjs';

export const MD_RESOLVE_MAP = 'md_comments_resolve_v0';

export interface MdResolveInfo {
  by: string;
  at: number;
}

export function mdResolveMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(MD_RESOLVE_MAP);
}

export function readMdResolve(doc: Y.Doc, threadRootId: string): MdResolveInfo | null {
  const value = mdResolveMap(doc).get(threadRootId);
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  return {
    by: typeof v.by === 'string' ? v.by : 'someone',
    at: typeof v.at === 'number' ? v.at : 0,
  };
}

/** Mark a thread resolved (reversible) or reopen it. Anyone with edit access
 *  may call this — the gate lives at the call site, as in the HTML editor. */
export function setMdResolved(doc: Y.Doc, threadRootId: string, resolved: boolean, by: string): void {
  const map = mdResolveMap(doc);
  doc.transact(() => {
    if (resolved) map.set(threadRootId, { by, at: Date.now() });
    else map.delete(threadRootId);
  });
}
