import type { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { criticMarkupField } from '../Editor/extensions/criticmarkup';
import { frontmatterField } from '../Editor/extensions/frontmatter';

/** Blocks a highlight's {== and ==} would show in raw, or break */
const NO_HIGHLIGHT_NODES = new Set(['FencedCode', 'CodeBlock', 'HTMLBlock', 'HTMLTag', 'CommentBlock', 'Table']);
/** Inline nodes a highlight may cover whole, but not start or end inside */
const WHOLE_ONLY_NODES = new Set(['Link', 'Image', 'Wikilink', 'Autolink', 'URL', 'InlineCode']);

/** A line's block markers (heading, quote, list, task), which stay outside a highlight */
const BLOCK_PREFIX = /^(?:\s*(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d{1,9}[.)]\s+(?:\[[ xX]\]\s+)?))*/;

/**
 * What a new comment is on: the selected text, which it highlights as Notion
 * does ({==text==}{>>comment<<}), or a point at the cursor when the selection
 * can't take a highlight: none, more than one line, in code, a table, the
 * frontmatter or other suggestion markup, or cutting through a link.
 */
export function commentTarget(state: EditorState): { from: number; to: number } {
  const { from, to, head } = state.selection.main;
  const point = { from: head, to: head };
  if (from === to) return point;

  const line = state.doc.lineAt(from);
  if (state.doc.lineAt(to).number !== line.number) return point;
  // Leave out the line's block markers and white space at either end
  let start = Math.max(from, line.from + (BLOCK_PREFIX.exec(line.text)?.[0].length ?? 0));
  let end = to;
  while (start < end && /\s/.test(state.sliceDoc(start, start + 1))) start++;
  while (end > start && /\s/.test(state.sliceDoc(end - 1, end))) end--;
  if (start >= end) return point;

  const fm = state.field(frontmatterField, false)?.range;
  if (fm && start <= fm.to && end >= fm.from) return point;
  if (state.field(criticMarkupField, false)?.some((r) => r.from < end && r.to > start)) return point;

  const tree = syntaxTree(state);
  for (const [pos, side] of [[start, 1], [end, -1]] as const) {
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (NO_HIGHLIGHT_NODES.has(node.name)) return point;
      if (WHOLE_ONLY_NODES.has(node.name) && (node.from < start || node.to > end)) return point;
    }
  }
  let inside = false;
  tree.iterate({
    from: start,
    to: end,
    enter: (node) => {
      if (NO_HIGHLIGHT_NODES.has(node.name)) inside = true;
    },
  });
  return inside ? point : { from: start, to: end };
}
