import { EditorState } from '@codemirror/state';
import { EditorView, drawSelection, keymap } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { TaskList } from '@lezer/markdown';
import { livePreview } from '../../src/components/Editor/extensions/livePreview';
import { criticMarkupExtension } from '../../src/components/Editor/extensions/criticmarkup';
import { getContextMenuItems } from '../../src/components/Editor/extensions/criticmarkup-context-menu';
import '../../src/index.css';

const meta = (author: string) => JSON.stringify({ author, timestamp: 1760000000000 });

const documentText = [
  '# Review',
  `An edit: {--${meta("Mark's AI")}@@old words--}{++${meta("Mark's AI")}@@new words++}{>>${meta('Elias')}@@Why the change?<<} here.`,
  `Hello {++${meta('Elias')}@@big ++}world{>>${meta('Elias')}@@Is big right?<<}{>>${meta('Mark')}@@Yes.<<} there.`,
  `Some {==highlighted text==}{>>${meta('Elias')}@@A comment<<} here.`,
  'Plain words at the end',
].join('\n');

// Editor.tsx's live preview, CriticMarkup and theme
const view = new EditorView({
  parent: document.querySelector<HTMLElement>('#editor')!,
  state: EditorState.create({
    doc: documentText,
    extensions: [
      drawSelection(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      keymap.of(defaultKeymap),
      markdown({ base: markdownLanguage, extensions: [TaskList], addKeymap: false }),
      livePreview(),
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

// A plain stand-in for Editor.tsx's context menu: the CriticMarkup items at
// the right-clicked position, as its handleContextMenu asks for them
const menu = document.querySelector<HTMLElement>('#menu')!;
view.dom.addEventListener('contextmenu', (e) => {
  const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
  if (pos === null) return;
  e.preventDefault();
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  menu.dataset.pos = String(pos);
  menu.replaceChildren(...getContextMenuItems(view, pos, e.target).map((item) => {
    const button = document.createElement('button');
    button.textContent = item.label;
    button.addEventListener('click', () => {
      menu.replaceChildren();
      item.action();
    });
    return button;
  }));
});

Object.assign(window, {
  view,
  text: () => view.state.doc.toString(),
  selectedText: () => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
});
