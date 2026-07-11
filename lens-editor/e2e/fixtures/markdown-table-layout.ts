import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { Table } from '@lezer/markdown';
import { markdownTableExtension } from '../../src/components/Editor/extensions/markdownTable';

const documentText = `Ordinary prose used to measure the reading column.

| A | B |
| - | - |
| 1 | 2 |

| First very wide column | Second very wide column | Third very wide column | Fourth very wide column |
| - | - | - | - |
| unbroken-value-that-needs-room | another-unbroken-value-that-needs-room | third-unbroken-value-that-needs-room | fourth-unbroken-value-that-needs-room |

After tables`;

const state = EditorState.create({
  doc: documentText,
  selection: { anchor: documentText.length },
  extensions: [
    markdown({ extensions: [Table] }),
    markdownTableExtension(),
    EditorView.lineWrapping,
    EditorView.theme({
      '&': { height: '100%' },
      '.cm-scroller': { overflow: 'auto' },
      '.cm-content': {
        boxSizing: 'border-box',
        width: '100%',
        maxWidth: '700px',
        marginLeft: 'auto',
        marginRight: 'auto',
        padding: '16px 24px 170px',
      },
    }),
  ],
});

new EditorView({ state, parent: document.querySelector('#editor')! });
