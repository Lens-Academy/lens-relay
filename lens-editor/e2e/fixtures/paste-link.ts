import '../../src/index.css';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { Autolink, Table, TaskList } from '@lezer/markdown';
import { WikilinkExtension } from '../../src/components/Editor/extensions/wikilinkParser';
import { livePreview } from '../../src/components/Editor/extensions/livePreview';
import { markdownTableExtension } from '../../src/components/Editor/extensions/markdownTable';
import { criticMarkupExtension } from '../../src/components/Editor/extensions/criticmarkup';
import { pasteLink } from '../../src/components/Editor/extensions/pasteLink';
import { editorTheme } from '../../src/components/Editor/editorTheme';
import type { FolderMetadata } from '../../src/hooks/useFolderMetadata';

const metadata: FolderMetadata = {
  '/Lens/03-Product/Budget.md': { id: '0f0f0f0f-0000-4000-8000-000000000000', type: 'markdown', version: 0 },
  '/Lens/03-Product/Pitch.md': { id: 'a1b2c3d4-0000-4000-8000-000000000001', type: 'markdown', version: 0 },
};

const documentText = `Revenue grew 40% last year, and 120 students finished.

| Metric | Value |
| - | - |
| Signups | 350 |

End`;

// Extensions in Editor.tsx's order, so the paste handlers meet as they do there
const state = EditorState.create({
  doc: documentText,
  extensions: [
    markdown({
      base: markdownLanguage,
      extensions: [WikilinkExtension, TaskList, Autolink, Table],
      addKeymap: false,
      pasteURLAsLink: false,
    }),
    livePreview(),
    markdownTableExtension(),
    criticMarkupExtension(),
    pasteLink({ getMetadata: () => metadata, getCurrentFilePath: () => '/Lens/03-Product/Budget.md' }),
    EditorView.lineWrapping,
    editorTheme,
  ],
});

const view = new EditorView({ state, parent: document.querySelector('#editor')! });
(window as unknown as { __view: EditorView }).__view = view;
