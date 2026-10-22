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
import { typographyDoc } from './typography-doc';

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
  ],
});

(window as unknown as { __view: EditorView }).__view = new EditorView({ state, parent: document.querySelector('#editor')! });
