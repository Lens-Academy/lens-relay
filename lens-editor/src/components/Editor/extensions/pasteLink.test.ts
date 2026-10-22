import { describe, it, expect, afterEach } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import type { SelectionRange } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { Autolink, Table } from '@lezer/markdown';
import { WikilinkExtension } from './wikilinkParser';
import { frontmatterField } from './frontmatter';
import { criticMarkupExtension, setCurrentAuthor, toggleSuggestionMode } from './criticmarkup';
import { markdownTableExtension } from './markdownTable';
import { livePreview } from './livePreview';
import { pasteLink, pastedLinkField } from './pasteLink';
import type { FolderMetadata } from '../../../hooks/useFolderMetadata';

const metadata: FolderMetadata = {
  '/Lens/03-Product/Budget.md': { id: '0f0f0f0f-0000-4000-8000-000000000000', type: 'markdown', version: 0 },
  '/Lens/03-Product/Pitch.md': { id: 'a1b2c3d4-0000-4000-8000-000000000001', type: 'markdown', version: 0 },
  '/Lens/09-Transcripts/Call 21 Oct.md': { id: 'b2c3d4e5-0000-4000-8000-000000000002', type: 'markdown', version: 0 },
  '/Lens/widgets/chart.html': { id: 'c3d4e5f6-0000-4000-8000-000000000003', type: 'file', version: 0 },
  '/Lens/img/logo.png': { id: 'd4e5f6a7-0000-4000-8000-000000000004', type: 'image', version: 0 },
};
const CURRENT = '/Lens/03-Product/Budget.md';
const EDITOR = 'https://editor.lensacademy.org';

const views: EditorView[] = [];
afterEach(() => {
  views.forEach((v) => v.destroy());
  views.length = 0;
});

function setup(doc: string, selection: SelectionRange | EditorSelection) {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection,
      extensions: [
        EditorState.allowMultipleSelections.of(true),
        // As Editor.tsx: lang-markdown's own paste-as-link is off
        markdown({ base: markdownLanguage, extensions: [WikilinkExtension, Autolink, Table], pasteURLAsLink: false }),
        frontmatterField,
        criticMarkupExtension(),
        pasteLink({ getMetadata: () => metadata, getCurrentFilePath: () => CURRENT }),
      ],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

/** Select the first occurrence of `text` in `doc`. */
function selecting(doc: string, text: string): SelectionRange {
  const from = doc.indexOf(text);
  if (from < 0) throw new Error(`"${text}" not in doc`);
  return EditorSelection.range(from, from + text.length);
}

/** Fire a real paste event at the editor. */
function paste(view: EditorView, text: string) {
  const data = new DataTransfer();
  data.setData('text/plain', text);
  view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
}

const DOC = 'Revenue grew 40% last year.';

describe('pasting a URL over selected text', () => {
  it('makes a markdown link of a URL from elsewhere', () => {
    const view = setup(DOC, selecting(DOC, '40%'));
    paste(view, 'https://example.com/report');
    expect(view.state.doc.toString()).toBe('Revenue grew [40%](https://example.com/report) last year.');
    expect(view.state.selection.main.head).toBe('Revenue grew [40%](https://example.com/report)'.length);
  });

  it('selected backwards links the same', () => {
    const { from, to } = selecting(DOC, '40%');
    const view = setup(DOC, EditorSelection.range(to, from));
    paste(view, 'https://example.com/report');
    expect(view.state.doc.toString()).toBe('Revenue grew [40%](https://example.com/report) last year.');
  });

  it.each([
    ['a doc URL', `${EDITOR}/a1b2c3d4/Lens/03-Product/Pitch.md`, '[[Pitch|40%]]'],
    ['a doc in another folder', `${EDITOR}/b2c3d4e5/Lens/09-Transcripts/Call-21-Oct.md`, '[[../09-Transcripts/Call 21 Oct|40%]]'],
    ['a bare uuid prefix', `${EDITOR}/b2c3d4e5`, '[[../09-Transcripts/Call 21 Oct|40%]]'],
    ['an /open/ path', `${EDITOR}/open/Lens/09-Transcripts/Call%2021%20Oct.md`, '[[../09-Transcripts/Call 21 Oct|40%]]'],
    ['a vault path', `${EDITOR}/Lens/09-Transcripts/Call%2021%20Oct`, '[[../09-Transcripts/Call 21 Oct|40%]]'],
    ['the course editor', `${EDITOR}/edu/a1b2c3d4`, '[[Pitch|40%]]'],
    ['an HTML page', `${EDITOR}/c3d4e5f6/Lens/widgets/chart.html`, '[[../widgets/chart|40%]]'],
    ['the page\'s own origin', `${window.location.origin}/a1b2c3d4/Lens/03-Product/Pitch.md`, '[[Pitch|40%]]'],
    ['a URL with a line anchor', `${EDITOR}/a1b2c3d4/Lens/03-Product/Pitch.md#L12`, '[[Pitch|40%]]'],
  ])('makes a wikilink of %s', (_, url, link) => {
    const view = setup(DOC, selecting(DOC, '40%'));
    paste(view, url);
    expect(view.state.doc.toString()).toBe(`Revenue grew ${link} last year.`);
    expect(view.state.selection.main.head).toBe(`Revenue grew ${link}`.length);
  });

  it.each([
    ['an image in the editor', `${EDITOR}/d4e5f6a7/Lens/img/logo.png`],
    ['an unknown doc', `${EDITOR}/99999999/Lens/Gone.md`],
    ['an editor-like path on another site', 'https://example.com/a1b2c3d4/Lens/03-Product/Pitch.md'],
  ])('makes a markdown link of %s', (_, url) => {
    const view = setup(DOC, selecting(DOC, '40%'));
    paste(view, url);
    expect(view.state.doc.toString()).toBe(`Revenue grew [40%](${url}) last year.`);
  });

  it('makes a markdown link of a doc URL when the text has a |', () => {
    const doc = 'Q3 | 40% done';
    const view = setup(doc, selecting(doc, 'Q3 | 40%'));
    paste(view, `${EDITOR}/a1b2c3d4`);
    expect(view.state.doc.toString()).toBe(`[Q3 | 40%](${EDITOR}/a1b2c3d4) done`);
  });

  it('makes a markdown link of a doc URL in a table row (source mode)', () => {
    const doc = '| A |\n| - |\n| 40% |';
    const view = setup(doc, selecting(doc, '40%'));
    paste(view, `${EDITOR}/a1b2c3d4`);
    expect(view.state.doc.toString()).toBe(`| A |\n| - |\n| [40%](${EDITOR}/a1b2c3d4) |`);
  });

  it.each([
    ['www.example.com/report', 'https://www.example.com/report'],
    ['mailto:team@lensacademy.org', 'mailto:team@lensacademy.org'],
  ])('takes %s as lang-markdown did', (pasted, url) => {
    const view = setup(DOC, selecting(DOC, '40%'));
    paste(view, pasted);
    expect(view.state.doc.toString()).toBe(`Revenue grew [40%](${url}) last year.`);
  });

  it('links a whole bold run', () => {
    const doc = 'grew **40%** last year';
    const view = setup(doc, selecting(doc, '**40%**'));
    paste(view, 'https://example.com/report');
    expect(view.state.doc.toString()).toBe('grew [**40%**](https://example.com/report) last year');
  });

  it('leaves spaces at the edges of the selection outside the link', () => {
    const view = setup(DOC, selecting(DOC, ' 40% '));
    paste(view, 'https://example.com/report');
    expect(view.state.doc.toString()).toBe('Revenue grew [40%](https://example.com/report) last year.');
  });

  it('trims the pasted URL', () => {
    const view = setup(DOC, selecting(DOC, '40%'));
    paste(view, '  https://example.com/report\n');
    expect(view.state.doc.toString()).toBe('Revenue grew [40%](https://example.com/report) last year.');
  });

  it('keeps balanced parentheses in the URL and encodes unbalanced ones', () => {
    const view = setup(DOC, selecting(DOC, '40%'));
    paste(view, 'https://en.wikipedia.org/wiki/Growth_(economics)');
    expect(view.state.doc.toString()).toBe('Revenue grew [40%](https://en.wikipedia.org/wiki/Growth_(economics)) last year.');

    const other = setup(DOC, selecting(DOC, '40%'));
    paste(other, 'https://example.com/a)b');
    expect(other.state.doc.toString()).toBe('Revenue grew [40%](https://example.com/a%29b) last year.');
  });

  it('links inside list items, headings and emphasis', () => {
    const doc = '# Growth\n\n- grew **40%** last year';
    const view = setup(doc, selecting(doc, '40%'));
    paste(view, 'https://example.com/report');
    expect(view.state.doc.toString()).toBe('# Growth\n\n- grew **[40%](https://example.com/report)** last year');
  });

  it('suggests only the brackets in suggestion mode', () => {
    setCurrentAuthor('Mark');
    const view = setup(DOC, selecting(DOC, '40%'));
    view.dispatch({ effects: toggleSuggestionMode.of(true) });
    paste(view, 'https://example.com/report');
    expect(view.state.doc.toString()).toMatch(
      /^Revenue grew \{\+\+\{[^}]*"author":"Mark"[^}]*\}@@\[\+\+\}40%\{\+\+\{[^}]*\}@@\]\(https:\/\/example\.com\/report\)\+\+\} last year\.$/,
    );
  });
});

describe('pasting stays a normal paste', () => {
  it('with no selection', () => {
    const view = setup(DOC, EditorSelection.cursor(DOC.indexOf('last')));
    paste(view, 'https://example.com/report');
    expect(view.state.doc.toString()).toBe('Revenue grew 40% https://example.com/reportlast year.');
  });

  it.each([
    ['text that is not a URL', DOC, '40%', 'fifty percent'],
    ['a URL with other text', DOC, '40%', 'see https://example.com/report'],
    ['two URLs', DOC, '40%', 'https://example.com/a https://example.com/b'],
    ['a non-web URL', DOC, '40%', 'javascript:alert(1)'],
    ['a selection over two lines', 'grew 40%\nlast year', '40%\nlast', 'https://example.com/report'],
    ['a selection in inline code', 'run `npm 40` now', '40', 'https://example.com/report'],
    ['a selection in a code block', '```\ngrew 40%\n```', '40%', 'https://example.com/report'],
    ['a selection in a link\'s text', 'grew [about 40%](https://a.com) here', '40%', 'https://example.com/report'],
    ['a selection in a wikilink', 'see [[Pitch|40%]] here', '40%', 'https://example.com/report'],
    ['a selection holding a link', 'grew [40%](https://a.com) here', '[40%](https://a.com)', 'https://example.com/report'],
    ['a selection in the frontmatter', '---\ngrowth: 40%\n---\nText', '40%', 'https://example.com/report'],
    ['a selected URL', 'see https://a.com here', 'https://a.com', 'https://example.com/report'],
    ['a selection of spaces', 'grew   40%', '  ', 'https://example.com/report'],
    ['half of a bold run', 'grew **40% more** now', '**40%', 'https://example.com/report'],
    ['a selection ending in half of a bold run', 'grew **40% more** now', 'grew **40%', 'https://example.com/report'],
    ['a selection holding a list mark', '- grew 40%', '- grew', 'https://example.com/report'],
    ['a selection holding a heading mark', '# Growth', '# Growth', 'https://example.com/report'],
    ['a selection across table cells', '| A | B |\n| - | - |\n| 40% | 50% |', '40% | 50%', 'https://example.com/report'],
  ])('for %s', (_, doc, selected, pasted) => {
    const view = setup(doc, selecting(doc, selected));
    paste(view, pasted);
    expect(view.state.doc.toString()).toBe(doc.replace(selected, pasted));
  });

  it('for a selection from inside someone\'s suggestion to outside it', () => {
    const doc = 'grew {++{"author":"Luc","timestamp":1}@@about 40%++} last year';
    const view = setup(doc, EditorSelection.range(doc.indexOf('40%'), doc.indexOf(' year')));
    paste(view, 'https://example.com/report');
    expect(view.state.doc.toString()).not.toContain('[40%');
  });

  it('for several selections', () => {
    const doc = 'one two';
    const view = setup(doc, EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(4, 7)]));
    paste(view, 'https://example.com/report');
    expect(view.state.doc.toString()).not.toContain('[');
  });
});

describe('a pasted link in live preview', () => {
  function setupPreview(doc: string, selection: SelectionRange) {
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection,
        extensions: [
          markdown({ base: markdownLanguage, extensions: [WikilinkExtension, Autolink, Table], pasteURLAsLink: false }),
          livePreview(),
          pasteLink({ getMetadata: () => metadata, getCurrentFilePath: () => CURRENT }),
        ],
      }),
      parent: document.body,
    });
    views.push(view);
    return view;
  }

  const linkText = (view: EditorView) => view.contentDOM.querySelector('.cm-link-widget')?.textContent ?? null;
  const wikilinkText = (view: EditorView) => view.contentDOM.querySelector('.cm-wikilink-widget')?.textContent ?? null;

  it('shows as a link at once, not as [text](url), with the cursor right after it', () => {
    const view = setupPreview(DOC, selecting(DOC, '40%'));
    paste(view, 'https://example.com/report');
    expect(view.state.selection.main.head).toBe('Revenue grew [40%](https://example.com/report)'.length);
    expect(linkText(view)).toBe('40%');
  });

  it('shows a pasted wikilink as a link at once', () => {
    const view = setupPreview(DOC, selecting(DOC, '40%'));
    paste(view, `${EDITOR}/a1b2c3d4`);
    expect(wikilinkText(view)).toBe('40%');
  });

  it('keeps showing as a link after typing on', () => {
    const view = setupPreview(DOC, selecting(DOC, '40%'));
    paste(view, 'https://example.com/report');
    const at = view.state.selection.main.head;
    view.dispatch({ changes: { from: at, insert: ',' }, selection: { anchor: at + 1 }, userEvent: 'input.type' });
    expect(view.state.field(pastedLinkField)).toBeNull();
    expect(linkText(view)).toBe('40%');
  });

  it('shows its syntax again once the cursor moves onto it, as other links do', () => {
    const view = setupPreview(DOC, selecting(DOC, '40%'));
    paste(view, 'https://example.com/report');
    view.dispatch({ selection: { anchor: DOC.indexOf('40%') + 2 }, userEvent: 'select' });
    expect(linkText(view)).toBeNull();
    expect(view.contentDOM.textContent).toContain('[40%](https://example.com/report)');
  });

  it('shows its syntax again when the cursor comes back to its end later', () => {
    const view = setupPreview(DOC, selecting(DOC, '40%'));
    paste(view, 'https://example.com/report');
    const end = view.state.selection.main.head;
    view.dispatch({ selection: { anchor: end + 3 }, userEvent: 'select' });
    view.dispatch({ selection: { anchor: end }, userEvent: 'select' });
    expect(linkText(view)).toBeNull();
  });

  it('stays a link while someone else edits elsewhere', () => {
    const view = setupPreview(DOC, selecting(DOC, '40%'));
    paste(view, 'https://example.com/report');
    view.dispatch({ changes: { from: 0, insert: 'Q3: ' } }); // a remote change has no user event
    expect(view.state.field(pastedLinkField)).toEqual({ from: 'Q3: Revenue grew '.length, to: view.state.selection.main.head });
    expect(linkText(view)).toBe('40%');
  });
});

describe('pasting a URL over selected text in a table cell', () => {
  function tableCell(content: string) {
    const view = new EditorView({
      state: EditorState.create({
        doc: content,
        selection: { anchor: content.indexOf('end') },
        extensions: [markdown({ extensions: [Table] }), markdownTableExtension()],
      }),
      parent: document.body,
    });
    views.push(view);
    return { view, td: view.contentDOM.querySelector<HTMLElement>('.cm-md-table td')! };
  }

  function pasteInCell(td: HTMLElement, text: string, select: (range: Range) => void) {
    td.focus();
    const range = document.createRange();
    select(range);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/plain' ? text : '') },
    });
    td.dispatchEvent(event);
  }

  it('links the selected text', () => {
    const { view, td } = tableCell('| A |\n| - |\n| 40% |\n\nend');
    pasteInCell(td, 'https://example.com/report', (range) => range.selectNodeContents(td));
    expect(view.state.doc.toString()).toBe('| A |\n| - |\n| [40%](https://example.com/report) |\n\nend');
  });

  it('makes a markdown link of a doc URL too', () => {
    const { view, td } = tableCell('| A |\n| - |\n| 40% |\n\nend');
    pasteInCell(td, `${EDITOR}/a1b2c3d4/Lens/03-Product/Pitch.md`, (range) => range.selectNodeContents(td));
    expect(view.state.doc.toString()).toBe(`| A |\n| - |\n| [40%](${EDITOR}/a1b2c3d4/Lens/03-Product/Pitch.md) |\n\nend`);
  });

  it('pastes the URL as it is with no selection', () => {
    const { view, td } = tableCell('| A |\n| - |\n| 40% |\n\nend');
    pasteInCell(td, 'https://example.com/report', (range) => {
      range.selectNodeContents(td);
      range.collapse(false);
    });
    expect(view.state.doc.toString()).toBe('| A |\n| - |\n| 40%https://example.com/report |\n\nend');
  });
});
