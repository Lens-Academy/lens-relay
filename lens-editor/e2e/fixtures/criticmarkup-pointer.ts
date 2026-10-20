import { EditorState } from '@codemirror/state';
import { EditorView, drawSelection, keymap } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { TaskList } from '@lezer/markdown';
import { livePreview } from '../../src/components/Editor/extensions/livePreview';
import { criticMarkupExtension, criticMarkupField } from '../../src/components/Editor/extensions/criticmarkup';
import '../../src/index.css';

const meta = (author: string) => JSON.stringify({ author, timestamp: 1760000000000 });

// Suggestions in the middle and at the end of lines, with and without
// metadata, in a wrapped paragraph, beside a comment badge, and a suggestion
// over three lines whose first and last lines show no text of it
const documentText = [
  '# Pointing at suggestions',
  'Plain text {++inserted++} in the middle.',
  `A suggestion with metadata {++${meta('Elias')}@@some added words++} in the middle of a sentence.`,
  `A pair: {--${meta('Elias')}@@old words--}{++${meta('Elias')}@@new words++} replaces text.`,
  `Some {==highlighted text==}{>>${meta('Elias')}@@A comment<<} after it.`,
  `- A list item with {--${meta('Elias')}@@a removed phrase--} and more text`,
  'A long paragraph wraps onto several rows, with suggestions along the way: '
    + `{++${meta('Elias')}@@some added words++} in the middle of a sentence, `
    + `{--${meta('Elias')}@@a phrase to remove--} a little further on, and a `
    + `{==highlight==}{>>${meta('Elias')}@@Why this one?<<} before the text carries on `
    + 'for a while longer so that the line wraps at least twice in the editor column.',
  'This line ends with {++an addition++}',
  `{++${meta('Elias')}@@`,
  'An added line of its own',
  '++}',
  'Last line.',
].join('\n');

// The extensions of Editor.tsx that shape these lines, in its order, with its theme
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

Object.assign(window, {
  view,
  ranges: () => view.state.field(criticMarkupField),
});
