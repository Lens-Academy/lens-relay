import { useEffect, useRef, type MutableRefObject } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';
import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown';
import { editorTheme, markdownHighlightStyle } from '../Editor/editorTheme';
import { lensMarkdownExtensions } from '../Editor/extensions/wikilinkTable';
import { livePreview } from '../Editor/extensions/livePreview';
import { markdownTableExtension } from '../Editor/extensions/markdownTable';
import { criticMarkupExtension } from '../Editor/extensions/criticmarkup';
import type { DiffPart } from '../../lib/history-api';
import { diffDecorations } from '../../lib/history-doc';

/**
 * One version of a file, rendered read-only by the editor's own markdown rendering (live preview,
 * tables, suggestion marks), with what changed drawn on top: added text marked, removed text shown
 * struck through where it was. Embeds are off: they would show the linked file as it is today.
 */

const historyTheme = EditorView.theme({
  // The editor's suggestion colours (index.css .cm-addition / .cm-deletion), which follow the theme.
  '.lens-history-added': { backgroundColor: 'rgba(34, 197, 94, 0.2)', color: 'var(--lens-addition-text)' },
  '.lens-history-removed': { backgroundColor: 'rgba(239, 68, 68, 0.2)', color: 'var(--lens-deletion-text)', textDecoration: 'line-through' },
  '&.cm-editor': { height: '100%' },
});

export function HistoryDoc({ text, parts, viewRef }: {
  text: string;
  parts: DiffPart[] | null;
  /** Set to the live view, so the panel can scroll it to a change. */
  viewRef?: MutableRefObject<EditorView | null>;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          EditorView.editable.of(false),
          EditorState.readOnly.of(true),
          syntaxHighlighting(markdownHighlightStyle, { fallback: true }),
          markdown({ base: commonmarkLanguage, extensions: lensMarkdownExtensions, addKeymap: false }),
          livePreview(undefined, { embeds: false }),
          markdownTableExtension(),
          criticMarkupExtension({ canAcceptReject: false }),
          EditorView.lineWrapping,
          editorTheme,
          historyTheme,
          ...(parts ? [EditorView.decorations.of(diffDecorations(parts))] : []),
        ],
      }),
    });
    if (viewRef) viewRef.current = view;
    return () => {
      if (viewRef?.current === view) viewRef.current = null;
      view.destroy();
    };
  }, [text, parts, viewRef]);
  return <div ref={host} className="h-full" data-testid="history-doc" />;
}
