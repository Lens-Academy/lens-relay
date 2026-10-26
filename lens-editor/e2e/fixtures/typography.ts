import '@fontsource-variable/source-serif-4/opsz.css';
import '../../src/index.css';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { Autolink, Table, TaskList } from '@lezer/markdown';
import { editorTheme, markdownHighlightStyle } from '../../src/components/Editor/editorTheme';
import { WikilinkExtension } from '../../src/components/Editor/extensions/wikilinkParser';
import { livePreview } from '../../src/components/Editor/extensions/livePreview';
import { markdownTableCompartment, markdownTableExtension } from '../../src/components/Editor/extensions/markdownTable';
import { criticMarkupExtension } from '../../src/components/Editor/extensions/criticmarkup';
import { codeBlockCopyButton } from '../../src/components/Editor/extensions/codeBlockCopyButton';
import { panelHostField, setPanelHost } from '../../src/components/ConceptRowsPanel/panelHost';
import { typographyDoc } from './typography-doc';

// The page header as DocumentTitle renders it (no icon), which EditorArea
// puts in the editor's top widget
const header = document.createElement('div');
header.innerHTML = '<div class="lens-page-header flex flex-col"><div class="relative"><div class="lens-page-controls"></div></div>'
  + '<div class="flex items-start gap-2"><textarea rows="1" aria-label="Document name" '
  + 'class="lens-doc-title flex-1 min-w-0 resize-none overflow-hidden bg-transparent border-none outline-none">Q4 OKRs and weekly plan</textarea></div></div>';

// The editor's look as Editor.tsx sets it up, on a page with every element
const state = EditorState.create({
  doc: typographyDoc,
  selection: { anchor: typographyDoc.length },
  extensions: [
    syntaxHighlighting(markdownHighlightStyle, { fallback: true }),
    markdown({ base: markdownLanguage, extensions: [WikilinkExtension, TaskList, Autolink, Table], addKeymap: false }),
    livePreview({ onClick: () => {}, isResolved: (page) => page === 'Pitch' }),
    codeBlockCopyButton(),
    markdownTableCompartment.of(markdownTableExtension()),
    criticMarkupExtension(),
    EditorView.lineWrapping,
    editorTheme,
    panelHostField,
  ],
});

const view = new EditorView({ state, parent: document.querySelector('#editor')! });
view.dispatch({ effects: setPanelHost.of(header) });
(window as unknown as { __view: EditorView }).__view = view;
