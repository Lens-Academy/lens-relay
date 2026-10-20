import { EditorState } from '@codemirror/state';
import { EditorView, drawSelection, keymap } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { TaskList } from '@lezer/markdown';
import { livePreview, toggleSourceMode } from '../../src/components/Editor/extensions/livePreview';
import {
  criticMarkupExtension,
  criticMarkupField,
  setCurrentAuthor,
  toggleSuggestionMode,
} from '../../src/components/Editor/extensions/criticmarkup';
import '../../src/index.css';

const meta = (author: string) => JSON.stringify({ author, timestamp: 1760000000000 });

// Suggestions in the middle and at the end of lines, with and without
// metadata, and lines after them that a broken suggestion would run on into
const documentText = [
  '# Deleting next to suggestions',
  'Plain text {++inserted++} in the middle.',
  `A suggestion with metadata {++${meta('Elias')}@@some added words++} in the middle of a sentence.`,
  'This line ends with {++an addition++}',
  '{--A deleted line--} and the text after it.',
  `Some {==highlighted text==}{>>${meta('Elias')}@@A comment<<} after it.`,
  `A pair: {--${meta('Elias')}@@old words--}{++${meta('Elias')}@@new words++} replaces text.`,
  'This line must stay as it is.',
  'Last line.',
].join('\n');

// The extensions of Editor.tsx that shape these lines, in its order (its
// keymap, with CodeMirror's word deletion, ahead of the CriticMarkup one),
// with its theme
const view = new EditorView({
  parent: document.querySelector<HTMLElement>('#editor')!,
  state: EditorState.create({
    doc: documentText,
    extensions: [
      drawSelection(),
      EditorState.allowMultipleSelections.of(true),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      closeBrackets(),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap]),
      markdown({ base: markdownLanguage, extensions: [TaskList], addKeymap: false }),
      livePreview(),
      criticMarkupExtension(),
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
  ranges: () => view.state.field(criticMarkupField),
  setSuggestionMode: (on: boolean) => view.dispatch({ effects: toggleSuggestionMode.of(on) }),
  setSourceMode: (on: boolean) => toggleSourceMode(view, on),
});
