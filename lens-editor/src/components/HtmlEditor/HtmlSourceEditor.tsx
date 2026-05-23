import { useEffect, useRef } from 'react';
import { EditorView } from 'codemirror';
import {
  Decoration,
  type DecorationSet,
  keymap,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
} from '@codemirror/view';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
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

interface HighlightRange {
  from: number;
  to: number;
}

interface HtmlSourceEditorProps {
  ytext: Y.Text;
  awareness: Awareness;
  readOnly?: boolean;
  highlightRanges?: HighlightRange[];
  onClickAtPosition?: (position: number, point: { x: number; y: number }) => void;
}

const setHighlights = StateEffect.define<HighlightRange[]>();

const highlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setHighlights)) {
        const docLength = transaction.state.doc.length;
        next = Decoration.set(
          effect.value
            .map(range => ({
              from: Math.max(0, Math.min(range.from, docLength)),
              to: Math.max(0, Math.min(range.to, docLength)),
            }))
            .filter(range => range.to > range.from)
            .sort((a, b) => a.from - b.from || a.to - b.to)
            .map(range => Decoration.mark({ class: 'cm-lens-candidate' }).range(range.from, range.to)),
        );
      }
    }
    return next;
  },
  provide: field => EditorView.decorations.from(field),
});

export function HtmlSourceEditor({
  ytext,
  awareness,
  readOnly = false,
  highlightRanges,
  onClickAtPosition,
}: HtmlSourceEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onClickAtPositionRef = useRef(onClickAtPosition);

  useEffect(() => {
    onClickAtPositionRef.current = onClickAtPosition;
  }, [onClickAtPosition]);

  useEffect(() => {
    if (!containerRef.current) return;

    viewRef.current?.destroy();

    const undoManager = new Y.UndoManager(ytext, {
      captureTimeout: 500,
      trackedOrigins: new Set([]),
    });

    const state = EditorState.create({
      doc: ytext.toString(),
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
        highlightField,
        EditorView.domEventHandlers({
          mouseup(event, view) {
            const handler = onClickAtPositionRef.current;
            if (!handler) return false;
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos !== null) handler(pos, { x: event.clientX, y: event.clientY });
            return false;
          },
        }),
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
          '.cm-lens-candidate': {
            backgroundColor: 'rgba(251, 191, 36, 0.25)',
            borderBottom: '2px solid rgb(251, 191, 36)',
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

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: setHighlights.of(highlightRanges ?? []),
    });
  }, [highlightRanges]);

  return <div ref={containerRef} className="h-full w-full" />;
}
