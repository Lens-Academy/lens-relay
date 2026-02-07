import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { WikilinkExtension } from '../components/Editor/extensions/wikilinkParser';
import { livePreview } from '../components/Editor/extensions/livePreview';
import type { WikilinkContext } from '../components/Editor/extensions/livePreview';
import { criticMarkupExtension } from '../components/Editor/extensions/criticmarkup';

/**
 * Create an EditorView with live preview extension for testing.
 * Returns the view and a cleanup function.
 */
export function createTestEditor(
  content: string,
  cursorPos: number,
  wikilinkContext?: WikilinkContext
): { view: EditorView; cleanup: () => void } {
  const state = EditorState.create({
    doc: content,
    selection: { anchor: cursorPos },
    extensions: [
      markdown({ extensions: [WikilinkExtension] }),
      livePreview(wikilinkContext),
    ],
  });

  const view = new EditorView({
    state,
    parent: document.body,
  });

  return {
    view,
    cleanup: () => {
      view.destroy();
    },
  };
}

/**
 * Check if a CSS class exists in the editor's content DOM.
 */
export function hasClass(view: EditorView, className: string): boolean {
  return view.contentDOM.querySelector(`.${className}`) !== null;
}

/**
 * Count elements with a specific class in the editor.
 */
export function countClass(view: EditorView, className: string): number {
  return view.contentDOM.querySelectorAll(`.${className}`).length;
}

/**
 * Get text content of elements with a specific class.
 */
export function getTextWithClass(view: EditorView, className: string): string[] {
  const elements = view.contentDOM.querySelectorAll(`.${className}`);
  return Array.from(elements).map((el) => el.textContent || '');
}

/**
 * Check if wikilink widget exists with specific text.
 */
export function hasWikilinkWidget(view: EditorView, pageName: string): boolean {
  const widgets = view.contentDOM.querySelectorAll('.cm-wikilink-widget');
  return Array.from(widgets).some((w) => w.textContent === pageName);
}

/**
 * Check if link widget exists with specific text.
 */
export function hasLinkWidget(view: EditorView, linkText: string): boolean {
  const widgets = view.contentDOM.querySelectorAll('.cm-link-widget');
  return Array.from(widgets).some((w) => w.textContent?.includes(linkText));
}

/**
 * Move cursor to a position and trigger decoration update.
 */
export function moveCursor(view: EditorView, pos: number): void {
  view.dispatch({
    selection: { anchor: pos },
  });
}

/**
 * Get the line number where the cursor is.
 */
export function getCursorLine(view: EditorView): number {
  return view.state.doc.lineAt(view.state.selection.main.head).number;
}

/**
 * Create an EditorView with CriticMarkup extension for testing.
 */
export function createCriticMarkupEditor(
  content: string,
  cursorPos: number
): { view: EditorView; cleanup: () => void } {
  const state = EditorState.create({
    doc: content,
    selection: { anchor: cursorPos },
    extensions: [
      markdown(),
      criticMarkupExtension(),
    ],
  });

  const view = new EditorView({
    state,
    parent: document.body,
  });

  return {
    view,
    cleanup: () => {
      view.destroy();
    },
  };
}

/**
 * Create an EditorView with both CriticMarkup and livePreview extensions.
 * This enables testing source mode toggling with CriticMarkup.
 */
export function createCriticMarkupEditorWithSourceMode(
  content: string,
  cursorPos: number
): { view: EditorView; cleanup: () => void } {
  const state = EditorState.create({
    doc: content,
    selection: { anchor: cursorPos },
    extensions: [
      markdown(),
      livePreview(),
      criticMarkupExtension(),
    ],
  });

  const view = new EditorView({
    state,
    parent: document.body,
  });

  return {
    view,
    cleanup: () => {
      view.destroy();
    },
  };
}
