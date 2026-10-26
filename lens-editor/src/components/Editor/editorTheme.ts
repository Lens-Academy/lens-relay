import { EditorView } from '@codemirror/view';
import { HighlightStyle, defaultHighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';

/**
 * The page look of the main editor: font, size, colour, column and
 * selection, after Notion's page (16px on a 24px line in the system font,
 * text --lens-text). Element styles (headings, quotes, code, ...) are in
 * index.css. Shared with the e2e fixtures, so their screenshots show the
 * editor as it is.
 */
export const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '16px',
    lineHeight: '1.5',
    color: 'var(--lens-text)',
    outline: 'none',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    fontFamily: 'var(--lens-font-sans)',
    overflow: 'auto',
    lineHeight: '1.5',
  },
  // The text column: 524px of text (580 minus the padding and CodeMirror's
  // line insets), about 70 characters a line, a book's measure rather than
  // Notion's 708px
  '.cm-content': {
    padding: '16px 24px 170px',
    maxWidth: '580px',
    marginLeft: 'auto',
    marginRight: 'auto',
  },
  '.cm-line': {
    lineHeight: '1.5',
  },
  // Hide gutters (fold markers only, no line numbers)
  '.cm-gutters': {
    display: 'none',
  },
  // Notion's selection blue (CodeMirror's default is lavender); the same
  // selector as CodeMirror's base theme, which a theme overrides
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    background: 'rgba(35, 131, 226, 0.28)',
  },
  // The rest of CodeMirror's own colours as tokens, which dark mode sets
  // (index.css): the selection while the editor isn't focused, the cursor
  // and tooltips
  '.cm-selectionBackground': {
    background: 'var(--lens-selection-unfocused)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--lens-text)',
  },
  '.cm-tooltip': {
    color: 'var(--lens-text)',
    backgroundColor: 'var(--lens-popover-bg)',
    borderColor: 'var(--lens-border)',
  },
});

/** A default syntax colour, as a token that dark mode lightens (index.css) */
const syntaxColor = (color: string) => `var(--lens-syntax-${color.slice(1)}, ${color})`;

/**
 * Syntax styles for markdown pages: CodeMirror's defaults, but bold at
 * Notion's semibold (600), and headings in their level's weight (index.css)
 * and not underlined. With the defaults, bold went from 600 to 700 while the
 * cursor was in it (live preview's .cm-strong is 600), and headings were 700
 * inside their class. Colours are tokens with the defaults as fallbacks, for
 * dark mode.
 */
export const markdownHighlightStyle = HighlightStyle.define(
  defaultHighlightStyle.specs.map((spec) => {
    const themed = spec.color ? { ...spec, color: syntaxColor(spec.color) } : spec;
    if (spec.tag === tags.heading) return { ...themed, fontWeight: 'inherit', textDecoration: 'none' };
    if (spec.tag === tags.strong) return { ...themed, fontWeight: '600' };
    return themed;
  }),
);
