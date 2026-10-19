import { EditorState } from '@codemirror/state';
import { EditorView, drawSelection, keymap } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
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

// Suggestions whose delimiters (and metadata) live preview hides, at the start,
// middle and end of lines
const documentText = [
  '# Suggestions',
  '{++An added line++}',
  `{++${meta('Elias')}@@An added line with metadata++}`,
  '{--A deleted line--}',
  `{~~${meta('Elias')}@@Old wording~>New wording~~} opens this line.`,
  `{==Highlighted text==}{>>${meta('Elias')}@@A comment<<} opens this line.`,
  'This line ends with {++an addition++}',
  'Plain text {++inserted++} in the middle.',
  `A pair: {--${meta('Elias')}@@old words--}{++${meta('Elias')}@@new words++} replaces text.`,
  'A long paragraph wraps onto several rows, with suggestions along the way: '
    + `{++${meta('Elias')}@@some added words++} in the middle of a sentence, `
    + `{--${meta('Elias')}@@a phrase to remove--} a little further on, and a `
    + `{==highlight==}{>>${meta('Elias')}@@Why this one?<<} before the text carries on `
    + 'for a while longer so that the line wraps at least twice in the editor column.',
  'Last line.',
].join('\n');

// The extensions of Editor.tsx that shape these lines, with its theme
const view = new EditorView({
  parent: document.querySelector<HTMLElement>('#editor')!,
  state: EditorState.create({
    doc: documentText,
    extensions: [
      drawSelection(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      markdown({ base: markdownLanguage, extensions: [TaskList], addKeymap: false }),
      livePreview(),
      criticMarkupExtension(),
      keymap.of(defaultKeymap),
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
