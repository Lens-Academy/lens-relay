import { EditorState } from '@codemirror/state';
import { EditorView, drawSelection, highlightSpecialChars } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { Autolink, Table, TaskList } from '@lezer/markdown';
import { WikilinkExtension } from '../../src/components/Editor/extensions/wikilinkParser';
import { livePreview, toggleSourceMode } from '../../src/components/Editor/extensions/livePreview';
import { markdownTableCompartment, markdownTableExtension } from '../../src/components/Editor/extensions/markdownTable';
import { emphasisPersistPlugin } from '../../src/components/Editor/extensions/emphasisPersist';
import { criticMarkupExtension } from '../../src/components/Editor/extensions/criticmarkup';
import '../../src/index.css';

const meta = (author: string) => JSON.stringify({ author, timestamp: 1760000000000 });

// Elias's substitutions, one with Mark's replacement nested in it (suggestion
// mode writes that as a deletion plus an addition), beside real strikethrough
const documentText = [
  '# Substitutions and strikethrough',
  `A substitution: {~~${meta('Elias')}@@old text~>new text~~} here.`,
  'Without metadata: {~~old words~>new words~~} here.',
  `Mark's edit in its new text: {~~${meta('Elias')}@@old text~>new {--${meta('Mark')}@@text--}{++${meta('Mark')}@@words++}~~} here.`,
  `Mark's edit in its old text: {~~${meta('Elias')}@@old {--${meta('Mark')}@@text--}{++${meta('Mark')}@@words++}~>new text~~} here.`,
  `A deletion: {--${meta('Elias')}@@deleted words--} here.`,
  'A real ~~strike~~ here, and {~~old text~>new text~~} beside it.',
  'Last line.',
].join('\n');

// The extensions of Editor.tsx that draw these lines, in its order (which
// decides how their spans nest), with its theme
const view = new EditorView({
  parent: document.querySelector<HTMLElement>('#editor')!,
  state: EditorState.create({
    doc: documentText,
    selection: { anchor: documentText.length },
    extensions: [
      highlightSpecialChars(),
      drawSelection(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      markdown({
        base: markdownLanguage,
        extensions: [WikilinkExtension, TaskList, Autolink, Table],
        addKeymap: false,
      }),
      livePreview(),
      markdownTableCompartment.of(markdownTableExtension()),
      emphasisPersistPlugin,
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
        '.tok-heading': { textDecoration: 'none !important' },
        '.cm-line .tok-heading': { textDecoration: 'none !important' },
      }),
    ],
  }),
});

Object.assign(window, {
  view,
  setSourceMode: (on: boolean) => toggleSourceMode(view, on),
});
