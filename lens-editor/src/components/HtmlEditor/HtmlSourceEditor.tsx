import { useEffect, useRef } from 'react';
import { EditorView } from 'codemirror';
import {
  keymap,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
} from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap } from '@codemirror/commands';
import {
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
  foldKeymap,
} from '@codemirror/language';
import {
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { html } from '@codemirror/lang-html';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { remoteCursorTheme } from '../Editor/remoteCursorTheme';

interface HtmlSourceEditorProps {
  ytext: Y.Text;
  awareness: Awareness;
  readOnly?: boolean;
}

export function HtmlSourceEditor({
  ytext,
  awareness,
  readOnly = false,
}: HtmlSourceEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    viewRef.current?.destroy();

    const undoManager = new Y.UndoManager(ytext, {
      captureTimeout: 500,
      trackedOrigins: new Set([]),
    });

    const state = EditorState.create({
      extensions: [
        ...(readOnly ? [EditorView.editable.of(false), EditorState.readOnly.of(true)] : []),
        indentUnit.of('\t'),
        EditorState.tabSize.of(4),
        highlightSpecialChars(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        bracketMatching(),
        closeBrackets(),
        rectangularSelection(),
        crosshairCursor(),
        highlightSelectionMatches(),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap.filter(
            (b) =>
              b.key !== 'Alt-ArrowLeft' &&
              b.key !== 'Alt-ArrowRight' &&
              b.key !== 'Shift-Alt-ArrowLeft' &&
              b.key !== 'Shift-Alt-ArrowRight',
          ),
          ...searchKeymap,
          ...yUndoManagerKeymap,
          ...foldKeymap,
          ...completionKeymap,
        ]),
        html(),
        yCollab(ytext, awareness, { undoManager }),
        remoteCursorTheme,
        EditorView.lineWrapping,
        EditorView.theme({
          '&': {
            height: '100%',
            fontSize: '14px',
            lineHeight: '1.5',
            outline: 'none',
          },
          '&.cm-focused': {
            outline: 'none',
          },
          '.cm-scroller': {
            fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
            overflow: 'auto',
            lineHeight: '1.5',
          },
          '.cm-content': {
            padding: '16px 24px',
          },
          '.cm-line': {
            lineHeight: '1.5',
          },
          '.cm-gutters': {
            display: 'none',
          },
        }),
      ],
    });

    viewRef.current = new EditorView({
      state,
      parent: containerRef.current,
    });

    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
      undoManager.destroy();
    };
  }, [awareness, readOnly, ytext]);

  return <div ref={containerRef} className="h-full w-full" />;
}
