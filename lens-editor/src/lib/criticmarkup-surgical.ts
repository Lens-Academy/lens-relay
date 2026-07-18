/**
 * Surgical CriticMarkup accept/reject: compute the delete-ranges that remove
 * markers, metadata, and discarded content while leaving the kept payload
 * characters untouched in the Y.Text.
 *
 * Why: every Y.Text character permanently carries its author's clientID
 * (provenance — docs/plans/2026-07-18-provenance-design.md). The old
 * "delete whole span, insert replacement" approach re-minted the kept text
 * under whoever clicked accept, silently re-authoring AI text as human (and
 * vice versa for rejected deletions). Deleting only the markup characters
 * preserves the payload items and therefore their authorship.
 *
 * Returns null when the markup string doesn't match the expected structure —
 * callers fall back to the legacy full-rewrite, which is always correct
 * content-wise (it just loses attribution).
 */

export interface DeletionRange {
  from: number;
  to: number;
}

type MarkupType = 'addition' | 'deletion' | 'substitution' | 'highlight' | 'comment';

const CLOSERS: Record<MarkupType, string> = {
  addition: '++}',
  deletion: '--}',
  substitution: '~~}',
  highlight: '==}',
  comment: '<<}',
};

const OPENERS: Record<MarkupType, string> = {
  addition: '{++',
  deletion: '{--',
  substitution: '{~~',
  highlight: '{==',
  comment: '{>>',
};

export function surgicalDeletions(opts: {
  markup: string;
  /** Absolute offset of the markup in the document. */
  start: number;
  type: MarkupType;
  action: 'accept' | 'reject';
  /** Payload for non-substitution types. */
  content: string;
  oldContent?: string | null;
  newContent?: string | null;
}): DeletionRange[] | null {
  const { markup, start, type, action } = opts;
  const open = OPENERS[type];
  const close = CLOSERS[type];
  if (!markup.startsWith(open) || !markup.endsWith(close)) return null;
  const end = start + markup.length;
  const inner = markup.slice(open.length, -close.length);

  const wholeSpan: DeletionRange[] = [{ from: start, to: end }];

  // Cases where nothing survives: the whole span goes.
  if (type === 'comment') return wholeSpan;
  if (type === 'addition' && action === 'reject') return wholeSpan;
  if (type === 'deletion' && action === 'accept') return wholeSpan;

  if (type === 'substitution') {
    const oldContent = opts.oldContent ?? '';
    const newContent = opts.newContent ?? '';
    // inner = <meta?> old ~> new  — locate from the end, metadata is a prefix.
    const sepIdx = inner.length - newContent.length - 2;
    const oldStart = sepIdx - oldContent.length;
    if (oldStart < 0) return null;
    if (inner.slice(sepIdx, sepIdx + 2) !== '~>') return null;
    if (inner.slice(oldStart, sepIdx) !== oldContent) return null;
    if (inner.slice(sepIdx + 2) !== newContent) return null;

    const absOldStart = start + open.length + oldStart;
    const absNewStart = start + open.length + sepIdx + 2;
    if (action === 'accept') {
      // Remove open+meta+old+sep, keep new, remove close.
      return [
        { from: start, to: absNewStart },
        { from: absNewStart + newContent.length, to: end },
      ];
    }
    // Reject: remove open+meta, keep old, remove sep+new+close.
    return [
      { from: start, to: absOldStart },
      { from: absOldStart + oldContent.length, to: end },
    ];
  }

  // addition-accept, deletion-reject, highlight-either: keep `content`,
  // which is the suffix of `inner` (metadata, when present, is the prefix).
  const content = opts.content;
  const contentStart = inner.length - content.length;
  if (contentStart < 0) return null;
  if (inner.slice(contentStart) !== content) return null;

  const absContentStart = start + open.length + contentStart;
  return [
    { from: start, to: absContentStart },
    { from: absContentStart + content.length, to: end },
  ];
}
