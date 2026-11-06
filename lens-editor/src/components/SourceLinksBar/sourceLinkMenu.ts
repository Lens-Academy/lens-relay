import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { scanExternalLinks } from '../../../shared/external-links';
import type { ContextMenuItem } from '../Editor/extensions/criticmarkup-context-menu';

/** The page's sources, as the main editor reaches them. */
export interface SourceLinkMenuTarget {
  canImport(url: string): boolean;
  importSource(url: string): void;
  /** The caret moved or the text changed. */
  editorChanged?(view: EditorView): void;
  /** How far down the page the editor should keep the caret, clear of the bar. */
  scrollMargin?(): number;
}

const LINK_NODES = new Set(['Link', 'Autolink', 'URL']);

/** The link node at `pos`. A click on a rendered link lands on either edge of
 *  it, so both sides of the position count. */
function linkNodeAt(state: EditorState, pos: number): { from: number; to: number } | null {
  const tree = syntaxTree(state);
  for (const side of [1, -1] as const) {
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (LINK_NODES.has(node.name)) return node;
    }
  }
  return null;
}

/**
 * The URL of the external link at `pos`, or null. The syntax tree finds what was
 * clicked; the scanner then has the last word, so this is the spelling the bar
 * and the server's swap use, and the places the scanner skips (images, reference
 * definitions, CriticMarkup, frontmatter) are skipped here too.
 */
export function externalLinkAt(state: EditorState, pos: number): string | null {
  const node = linkNodeAt(state, pos);
  if (!node) return null;
  const links = scanExternalLinks(state.doc.toString());
  return links.find((link) => link.swappable && link.start < node.to && link.end > node.from)?.url ?? null;
}

/** "Import and link this source", if the click is on a link that can have it. */
export function sourceLinkMenuItem(
  view: EditorView,
  pos: number,
  target: SourceLinkMenuTarget | null,
): ContextMenuItem | null {
  if (!target) return null;
  const url = externalLinkAt(view.state, pos);
  if (!url || !target.canImport(url)) return null;
  return {
    label: 'Import and link this source',
    action: () => {
      target.importSource(url);
      view.focus();
    },
  };
}
