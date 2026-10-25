/**
 * Wikilinks drawn as clickable internal links, shared by live preview and the
 * table widget (whose cells are rendered outside CodeMirror's decorations).
 */

import { Facet } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/**
 * WikilinkContext for navigation callbacks
 * Set via livePreview() function parameter
 */
export interface WikilinkContext {
  /** `create`: an unresolved link may create its file (not in embed cards,
   *  whose links are relative to a file the context does not know) */
  onClick: (pageName: string, create?: boolean) => void;
  onOpenNewTab?: (pageName: string, create?: boolean) => void;
  isResolved: (pageName: string) => boolean;
}

// Module-scoped context (set by livePreview factory)
let wikilinkContext: WikilinkContext | null = null;

export function getWikilinkContext(): WikilinkContext | null {
  return wikilinkContext;
}

export function setWikilinkContext(context: WikilinkContext | null) {
  wikilinkContext = context;
}

/** True in an embed card's editor, whose links must not create files. */
export const inEmbedCard = Facet.define<boolean, boolean>({ combine: (values) => values.some(Boolean) });

export function linksCreate(view: EditorView): boolean {
  return !view.state.facet(inEmbedCard);
}

/**
 * The target and alias of a wikilink's content (between `[[` and `]]`).
 * In a table, Obsidian writes the alias pipe escaped (`[[note\|alias]]`), so a
 * backslash before the first `|` belongs to the pipe, not to the target.
 */
export function splitWikilink(raw: string): { target: string; alias: string } {
  const pipe = raw.indexOf('|');
  if (pipe === -1) return { target: raw, alias: '' };
  const targetEnd = raw[pipe - 1] === '\\' ? pipe - 1 : pipe;
  return { target: raw.substring(0, targetEnd), alias: raw.substring(pipe + 1) };
}

/**
 * A clickable internal link; `create` lets an unresolved link create its file
 * (a function: asked on the click, for links drawn before they are in an editor).
 */
export function createWikilinkElement(
  pageName: string, displayText: string, resolved: boolean, create: boolean | (() => boolean),
): HTMLElement {
  const mayCreate = () => (typeof create === 'function' ? create() : create);
  const span = document.createElement('span');
  span.className = 'cm-wikilink-widget';

  // Add unresolved class if document doesn't exist
  if (!resolved) {
    span.classList.add('unresolved');
  }

  span.textContent = displayText;
  span.style.cursor = 'pointer';
  span.onclick = (e) => {
    e.preventDefault();
    if (!wikilinkContext) return;
    if (e.ctrlKey || e.metaKey) {
      wikilinkContext.onOpenNewTab?.(pageName, mayCreate());
    } else {
      wikilinkContext.onClick(pageName, mayCreate());
    }
  };
  span.onmousedown = (e) => { if (e.button === 1) e.preventDefault(); };
  span.onauxclick = (e) => {
    if (e.button === 1) {
      e.preventDefault();
      wikilinkContext?.onOpenNewTab?.(pageName, mayCreate());
    }
  };
  return span;
}
