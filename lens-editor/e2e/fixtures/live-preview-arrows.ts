import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { TaskList } from '@lezer/markdown';
import { livePreview } from '../../src/components/Editor/extensions/livePreview';
import { criticMarkupExtension } from '../../src/components/Editor/extensions/criticmarkup';
import '../../src/index.css';

// Lines that start with syntax live preview or CriticMarkup hides, between
// plain lines
const documentText = [
  '# Weekly team meeting',
  'Intro paragraph.',
  '## Decisions',
  'We move the OKR review to Thursday.',
  '',
  '---',
  'Updates',
  '-------',
  '- First item',
  '- Second item',
  '',
  '**Bold** opens this line.',
  '`code` opens this line.',
  '> A quote line',
  '',
  '```js',
  'const x = 1;',
  '```',
  '{++An added line++}',
  '{--A deleted line--}',
  'Last line.',
].join('\n');

// The extensions of Editor.tsx that shape these lines, with its theme. Not
// the code block's copy button: beside it, CodeMirror finds nothing to measure
// on the hidden ```js line and throws on a click or ArrowDown there (a
// separate problem).
const view = new EditorView({
  parent: document.querySelector<HTMLElement>('#editor')!,
  state: EditorState.create({
    doc: documentText,
    extensions: [
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

(window as unknown as { view: EditorView }).view = view;
