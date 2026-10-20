import { EditorState } from '@codemirror/state';
import { EditorView, drawSelection } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { TaskList } from '@lezer/markdown';
import { livePreview } from '../../src/components/Editor/extensions/livePreview';
import { setCurrentAuthor, toggleSuggestionMode } from '../../src/components/Editor/extensions/criticmarkup';
import { editorKeymaps } from '../../src/test/codemirror-helpers';
import '../../src/index.css';

const meta = (author: string) => JSON.stringify({ author, timestamp: 1760000000000 });

const documentText = [
  '# Suggestions',
  `Hello {++${meta('Elias')}@@big ++}world.`,
  `A pair: {--${meta('Elias')}@@old words--}{++${meta('Elias')}@@new words++} here.`,
  `Some {==highlighted text==}{>>${meta('Elias')}@@A comment<<} here.`,
  'Plain words at the end',
].join('\n');

// Editor.tsx's keymaps in its order (CodeMirror's defaultKeymap well ahead of
// criticMarkupExtension), with its live preview and theme
const view = new EditorView({
  parent: document.querySelector<HTMLElement>('#editor')!,
  state: EditorState.create({
    doc: documentText,
    extensions: [
      drawSelection(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      markdown({ base: markdownLanguage, extensions: [TaskList], addKeymap: false }),
      livePreview(),
      editorKeymaps(),
      EditorView.lineWrapping,
      EditorView.theme({
        '&': { height: '100%', fontSize: '16px', lineHeight: '1.5', color: '#222222' },
        '.cm-scroller': {
          fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
          overflow: 'auto',
          lineHeight: '1.5',
        },
        '.cm-content': { padding: '16px 24px 170px', maxWidth: '700px', marginLeft: 'auto', marginRight: 'auto' },
        '.cm-line': { lineHeight: '1.5' },
      }),
    ],
  }),
});

setCurrentAuthor('Mark');

Object.assign(window, {
  view,
  text: () => view.state.doc.toString(),
  /** Puts the cursor in the visible text, where a click on these lines can't be trusted to */
  placeCursor: (pos: number) => {
    view.focus();
    view.dispatch({ selection: { anchor: pos } });
  },
  setSuggestionMode: (on: boolean) => view.dispatch({ effects: toggleSuggestionMode.of(on) }),
});
