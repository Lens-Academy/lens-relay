import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { frontmatterField } from './frontmatter';

/**
 * Whether the editor treats `heading`, an ATXHeading or SetextHeading node, as a
 * heading: live preview and source mode size it (livePreview.ts) and the table
 * of contents lists it (useHeadings.ts).
 *
 * Not inside the frontmatter, which is YAML: Lezer reads the lines above its
 * closing --- as a setext heading, and a # comment as a heading.
 *
 * Not text over a single -: that is how a list typed straight under a line of
 * text starts (`-`, `- `, `- item`), and the line would flash up as an H2 until
 * the item's first letter. A setext H2 takes at least --, as in CodeMirror 5's
 * markdown mode, which Obsidian's editor builds on.
 */
export function countsAsHeading(state: EditorState, heading: SyntaxNode): boolean {
  const frontmatter = state.field(frontmatterField, false)?.range;
  if (frontmatter && heading.from >= frontmatter.from && heading.from <= frontmatter.to) return false;
  if (heading.name === 'SetextHeading2') {
    const underline = heading.getChild('HeaderMark');
    if (underline && underline.to - underline.from < 2) return false;
  }
  return true;
}
