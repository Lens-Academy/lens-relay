import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { Table } from '@lezer/markdown';
import { markdownTableExtension } from '../../src/components/Editor/extensions/markdownTable';

const documentText = `Ordinary prose used to measure the reading column.

| A | B |
| - | - |
| 1 | 2 |

| Wide column number one | Wide column number two | Wide column number three | Wide column number four | Wide column number five | Wide column number six | Wide column number seven | Wide column number eight | Wide column number nine | Wide column number ten | Wide column number eleven | Wide column number twelve |
| - | - | - | - | - | - | - | - | - | - | - | - |
| v1 | v2 | v3 | v4 | v5 | v6 | v7 | v8 | v9 | v10 | v11 | v12 |

| Topic | Description |
| - | - |
| Course Curriculum | Show the importance of x-risk Show there are ways to help Help understand the ecosystem Help create an action plan Show the importance of x-risk again |
| Lens Coach | Personalization Empathy Accountability Ongoing Guidance after course completion |

| Note | Detail |
| - | - |
| capped | This single prose column is far far longer than the per-column cap when unwrapped, so it must wrap at the cap instead of stretching the table across the entire editor pane like it otherwise would |
| link | https://example.com/averylongpathsegmentthatcannotbreakanywhereatallandkeepsongoingforeverandeverwithoutanybreakpoints |

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
