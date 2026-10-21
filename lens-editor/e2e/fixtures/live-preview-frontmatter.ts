import { EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { TaskList } from '@lezer/markdown';
import { livePreview } from '../../src/components/Editor/extensions/livePreview';
import { frontmatterKeymap } from '../../src/components/Editor/extensions/frontmatter';
import '../../src/index.css';

// A note with frontmatter, its closing --- under `key: value` (?case=properties,
// the default; a setext heading's underline to the markdown parser) or under a
// YAML list (?case=list; a divider to the parser)
const DOCUMENTS: Record<string, string[]> = {
  properties: [
    '---',
    'title: Weekly team meeting',
    'status: draft',
    '---',
    '# Agenda',
    '',
    'First paragraph of the note.',
    '',
    'Last line.',
  ],
  list: [
    '---',
    'title: Weekly team meeting',
    'tags:',
    '  - meetings',
    '  - team',
    '---',
    'Body paragraph right under it.',
    '',
    'Last line.',
  ],
};

const name = new URLSearchParams(location.search).get('case') ?? 'properties';

// The extensions of Editor.tsx that shape these lines, with its theme
const view = new EditorView({
  parent: document.querySelector<HTMLElement>('#editor')!,
  state: EditorState.create({
    doc: DOCUMENTS[name].join('\n'),
    extensions: [
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      keymap.of(defaultKeymap),
      markdown({ base: markdownLanguage, extensions: [TaskList], addKeymap: false }),
      livePreview(),
      Prec.high(keymap.of(frontmatterKeymap)),
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
