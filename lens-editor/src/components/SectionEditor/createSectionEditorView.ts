/**
 * Shared CodeMirror editor creation for section editing.
 * Used by both SectionEditor (single-doc) and MultiDocSectionEditor (multi-doc).
 */

import { EditorView } from 'codemirror';
import { keymap, drawSelection } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap } from '@codemirror/commands';
import { indentUnit, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { ySectionSync, ySectionUndoManagerKeymap } from './y-section-sync';
import { remoteCursorTheme } from '../Editor/remoteCursorTheme';

/**
 * Trim trailing newlines from section range so CM doesn't show an empty
 * editable line that would allow typing at the start of the next section.
 */
export function trimSectionEnd(fullText: string, from: number, to: number): number {
  let editTo = to;
  while (editTo > from && fullText[editTo - 1] === '\n') {
    editTo--;
  }
  return editTo;
}

/**
 * Create a CodeMirror EditorView for editing a section of a Y.Text.
 */
export function createSectionEditorView(opts: {
  ytext: Y.Text;
  sectionFrom: number;
  sectionTo: number;
  awareness?: Awareness;
  parent: HTMLElement;
}): EditorView {
  const { ytext, sectionFrom, sectionTo, awareness, parent } = opts;

  const fullText = ytext.toString();
  const editTo = trimSectionEnd(fullText, sectionFrom, sectionTo);
  const sectionText = fullText.slice(sectionFrom, editTo);

  return new EditorView({
    state: EditorState.create({
      doc: sectionText,
      extensions: [
        indentUnit.of('\t'),
        EditorState.tabSize.of(4),
        drawSelection(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        ySectionUndoManagerKeymap,
        keymap.of(defaultKeymap),
        markdown({ base: markdownLanguage, addKeymap: false }),
        ySectionSync(ytext, sectionFrom, editTo, { awareness }),
        remoteCursorTheme,
        EditorView.lineWrapping,
        EditorView.theme({
          '&': { fontSize: '14px', outline: 'none' },
          '&.cm-focused': { outline: 'none' },
          '.cm-scroller': {
            fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          },
          '.cm-content': { padding: '12px 16px' },
          '.cm-gutters': { display: 'none' },
        }),
      ],
    }),
    parent,
  });
}
