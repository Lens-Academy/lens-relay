import { EditorState, Prec } from '@codemirror/state';
import { EditorView, drawSelection, keymap } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, foldKeymap, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { defaultKeymap, indentLess, indentMore } from '@codemirror/commands';
import { closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { searchKeymap } from '@codemirror/search';
import { lintKeymap } from '@codemirror/lint';
import { yUndoManagerKeymap } from 'y-codemirror.next';
import { TaskList } from '@lezer/markdown';
import { livePreview } from '../../src/components/Editor/extensions/livePreview';
import { criticMarkupExtension, setCurrentAuthor, toggleSuggestionMode } from '../../src/components/Editor/extensions/criticmarkup';
import { frontmatterKeymap } from '../../src/components/Editor/extensions/frontmatter';
import { segmentIdKeymap } from '../../src/components/Editor/extensions/segmentIds';
import { tightMarkdownKeymap } from '../../src/components/Editor/extensions/tightListEnter';
import { checklistKeymap } from '../../src/components/Editor/extensions/checklistToggle';
import { markdownFormattingKeymap } from '../../src/components/Editor/extensions/markdownFormatting';
import '../../src/index.css';

// Editor.tsx's keymaps in its order (CodeMirror's defaultKeymap, whose
// Mod-Enter is insertBlankLine, well ahead of criticMarkupExtension), for a
// user who can only suggest, with its live preview and theme
const view = new EditorView({
  parent: document.querySelector<HTMLElement>('#editor')!,
  state: EditorState.create({
    doc: '',
    extensions: [
      indentUnit.of('\t'),
      EditorState.tabSize.of(4),
      drawSelection(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap.filter(
          (b) =>
            b.key !== 'Alt-ArrowLeft' &&
            b.key !== 'Alt-ArrowRight' &&
            b.key !== 'Shift-Alt-ArrowLeft' &&
            b.key !== 'Shift-Alt-ArrowRight',
        ),
        ...searchKeymap,
        ...yUndoManagerKeymap,
        ...foldKeymap,
        ...completionKeymap,
        ...lintKeymap,
      ]),
      markdown({ base: markdownLanguage, extensions: [TaskList], addKeymap: false }),
      livePreview(),
      Prec.high(keymap.of(frontmatterKeymap)),
      Prec.high(keymap.of(segmentIdKeymap(() => 'Lens/Notes.md'))),
      Prec.high(keymap.of(tightMarkdownKeymap)),
      Prec.high(keymap.of(checklistKeymap)),
      Prec.high(keymap.of(markdownFormattingKeymap)),
      keymap.of([
        { key: 'Tab', run: indentMore },
        { key: 'Shift-Tab', run: indentLess },
      ]),
      criticMarkupExtension({ canAcceptReject: false }),
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
  text: () => view.state.doc.toString(),
  /** Replaces the document (not an edit of the user's, so not suggested) */
  load: (doc: string) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } }),
  /** Puts the cursor in the visible text, where a click on these lines can't be trusted to */
  placeCursor: (pos: number) => {
    view.focus();
    view.dispatch({ selection: { anchor: pos } });
  },
});
