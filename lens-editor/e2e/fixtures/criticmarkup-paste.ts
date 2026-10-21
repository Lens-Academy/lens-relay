import { EditorState } from '@codemirror/state';
import { EditorView, drawSelection, dropCursor, keymap } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { TaskList } from '@lezer/markdown';
import * as Y from 'yjs';
import { yCollab } from 'y-codemirror.next';
import { livePreview, toggleSourceMode } from '../../src/components/Editor/extensions/livePreview';
import {
  criticMarkupExtension,
  criticMarkupField,
  setCurrentAuthor,
  toggleSuggestionMode,
} from '../../src/components/Editor/extensions/criticmarkup';
import { keepAuthorship } from '../../src/components/Editor/extensions/keepAuthorship';
import { getAuthorshipRuns } from '../../src/lib/authorship-runs';
import { getClientActorMap, registerClientMapping } from '../../src/lib/provenance';
import '../../src/index.css';

const meta = (author: string) => JSON.stringify({ author, timestamp: 1760000000000 });

// Luc wrote the text, Elias the suggestions and the comment in it. Mark, who
// suggests, copies from them and pastes on the paste line; the line after it
// has a suggestion of its own, which a broken paste would run on into.
const LUC = 1001;
const ELIAS = 1002;
const MARK = 2000;
const parts: [number, string][] = [
  [LUC, '# Pasting suggestions\nThis line ends with '],
  [ELIAS, `{++${meta('Elias')}@@an addition++}`],
  [LUC, '\nA '],
  [ELIAS, `{--${meta('Elias')}@@very --}`],
  [LUC, 'quick '],
  [ELIAS, `{~~${meta('Elias')}@@red~>brown~~}`],
  [LUC, ' fox {==jumps==}'],
  [ELIAS, `{>>${meta('Elias')}@@Which way?<<}`],
  [LUC, ' over the '],
  [ELIAS, `{--${meta('Elias')}@@lazy--}{++${meta('Elias')}@@sleepy++}`],
  [LUC, ' dog.\nPaste here: \nThis line has '],
  [ELIAS, `{++${meta('Elias')}@@its own addition++}`],
  [LUC, ' after the paste.\nThis line must stay as it is.\nLast line.'],
];

const ydoc = new Y.Doc();
const ytext = ydoc.getText('contents');
for (const [client, text] of parts) {
  ydoc.clientID = client;
  ytext.insert(ytext.length, text);
}
registerClientMapping(ydoc, 'human:Luc', 1760000000000, LUC);
registerClientMapping(ydoc, 'human:Elias', 1760000000000, ELIAS);
ydoc.clientID = MARK;
registerClientMapping(ydoc, 'human:Mark', Date.now(), MARK);

// The extensions of Editor.tsx that shape these lines and copy and paste
// them, in its order, with its theme
const view = new EditorView({
  parent: document.querySelector<HTMLElement>('#editor')!,
  state: EditorState.create({
    doc: ytext.toString(),
    extensions: [
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      closeBrackets(),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap]),
      markdown({ base: markdownLanguage, extensions: [TaskList], addKeymap: false }),
      livePreview(),
      keepAuthorship(ydoc, ytext),
      yCollab(ytext, null, { undoManager: false }),
      criticMarkupExtension(),
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

/** Who wrote `from`-`to` of the document, as "author: text" per run */
function authors(from: number, to: number): string[] {
  const actors = getClientActorMap(ydoc);
  const text = ytext.toString();
  return getAuthorshipRuns(ytext)
    .filter((run) => run.to > from && run.from < to)
    .map((run) => `${actors.get(run.client) ?? 'unknown'}: ${text.slice(Math.max(run.from, from), Math.min(run.to, to))}`);
}

/** The text line `n` shows: without hidden syntax, the ✓ ✗ buttons, comment
 *  badges and the zero-width space before hidden syntax at a line's start */
function shownText(n: number): string {
  const line = view.contentDOM.querySelectorAll('.cm-content > .cm-line')[n - 1].cloneNode(true) as HTMLElement;
  line.querySelectorAll('.cm-hidden-syntax, .cm-criticmarkup-buttons, .cm-comment-badge, .cm-cursor-anchor')
    .forEach((el) => el.remove());
  return line.textContent ?? '';
}

Object.assign(window, {
  view,
  ranges: () => view.state.field(criticMarkupField),
  authors,
  shownText,
  setSuggestionMode: (on: boolean) => view.dispatch({ effects: toggleSuggestionMode.of(on) }),
  setSourceMode: (on: boolean) => toggleSourceMode(view, on),
});
