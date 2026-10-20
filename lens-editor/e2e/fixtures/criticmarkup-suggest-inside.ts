import { EditorState } from '@codemirror/state';
import { EditorView, drawSelection, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { TaskList } from '@lezer/markdown';
import { livePreview } from '../../src/components/Editor/extensions/livePreview';
import {
  criticMarkupExtension,
  criticMarkupField,
  setCurrentAuthor,
  toggleSuggestionMode,
} from '../../src/components/Editor/extensions/criticmarkup';
import '../../src/index.css';

const meta = (author: string) => JSON.stringify({ author, timestamp: 1760000000000 });

// Elias's pending suggestions, for Mark to edit in suggestion mode
const documentText = [
  '# Suggestions by Elias',
  `{++${meta('Elias')}@@An added line with metadata++}`,
  `Plain text {++${meta('Elias')}@@inserted words++} in the middle.`,
  `A pair: {--${meta('Elias')}@@old words--}{++${meta('Elias')}@@new words++} replaces text.`,
  '{++An added line without metadata++}',
  `A deletion: {--${meta('Elias')}@@Deleted words--} and more.`,
  `A substitution: {~~${meta('Elias')}@@old text~>new text~~} here.`,
  'Last line.',
].join('\n');

// The extensions of Editor.tsx that shape these lines, with its theme
const view = new EditorView({
  parent: document.querySelector<HTMLElement>('#editor')!,
  state: EditorState.create({
    doc: documentText,
    extensions: [
      history(),
      drawSelection(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      markdown({ base: markdownLanguage, extensions: [TaskList], addKeymap: false }),
      livePreview(),
      criticMarkupExtension(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
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
view.dispatch({ effects: toggleSuggestionMode.of(true) });

Object.assign(window, {
  view,
  ranges: () => view.state.field(criticMarkupField),
  setSuggestionMode: (on: boolean) => view.dispatch({ effects: toggleSuggestionMode.of(on) }),
});
