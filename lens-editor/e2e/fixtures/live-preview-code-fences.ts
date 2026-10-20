import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { TaskList } from '@lezer/markdown';
import { livePreview } from '../../src/components/Editor/extensions/livePreview';
import { codeBlockCopyButton } from '../../src/components/Editor/extensions/codeBlockCopyButton';
import '../../src/index.css';

// Code blocks whose fences are hidden while the cursor is elsewhere: with a
// language, a tilde fence, an info string, none, in a quote, and indented in a
// list item
const documentText = [
  'Intro paragraph.',
  '```js',
  'const x = 1;',
  '```',
  'Between blocks.',
  '~~~python',
  'print("hi")',
  '~~~',
  '```ts title="config.ts"',
  'export default {};',
  '```',
  '```',
  'plain code',
  '```',
  '> A quote with code:',
  '> ```js',
  '> quoted();',
  '> ```',
  '',
  '- Install the tools:',
  '  ```bash',
  '  npm ci',
  '  ```',
  'Last line.',
].join('\n');

// The extensions of Editor.tsx that shape these lines, with its theme
const view = new EditorView({
  parent: document.querySelector<HTMLElement>('#editor')!,
  state: EditorState.create({
    doc: documentText,
    extensions: [
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      markdown({ base: markdownLanguage, extensions: [TaskList], addKeymap: false }),
      livePreview(),
      codeBlockCopyButton(),
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
