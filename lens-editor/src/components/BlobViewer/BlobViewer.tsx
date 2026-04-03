import { useEffect, useRef } from 'react';
import { EditorView } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { json as jsonLang } from '@codemirror/lang-json';
import {
  highlightSpecialChars,
  drawSelection,
  keymap,
} from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldKeymap, foldGutter } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';

interface BlobViewerProps {
  content: string;
  fileName?: string;
}

export function BlobViewer({ content }: BlobViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Destroy previous view if any
    viewRef.current?.destroy();

    const state = EditorState.create({
      doc: content,
      extensions: [
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
        highlightSpecialChars(),
        drawSelection(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        bracketMatching(),
        highlightSelectionMatches(),
        jsonLang(),
        foldGutter(),
        keymap.of([...defaultKeymap, ...searchKeymap, ...foldKeymap]),
        EditorView.lineWrapping,
        EditorView.theme({
          '&': { height: '100%', fontSize: '14px', outline: 'none' },
          '&.cm-focused': { outline: 'none' },
          '.cm-scroller': {
            fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
            overflow: 'auto',
          },
          '.cm-content': {
            padding: '16px 24px',
            maxWidth: '700px',
            marginLeft: 'auto',
            marginRight: 'auto',
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
    };
  }, [content]);

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
