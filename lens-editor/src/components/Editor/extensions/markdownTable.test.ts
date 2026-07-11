import { describe, it, expect, afterEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { Table } from '@lezer/markdown';
import { cursorLineUp } from '@codemirror/commands';
import { livePreview, toggleSourceMode } from './livePreview';
import { markdownTableCompartment, markdownTableExtension, tableEscapeKeymap } from './markdownTable';

function createEditor(content: string, cursorPos: number) {
  const state = EditorState.create({
    doc: content,
    selection: { anchor: cursorPos },
    extensions: [
      markdown({ extensions: [Table] }),
      markdownTableExtension(),
    ],
  });
  return new EditorView({ state, parent: document.body });
}

function createEditorWithModeToggle(content: string, cursorPos: number) {
  const state = EditorState.create({
    doc: content,
    selection: { anchor: cursorPos },
    extensions: [
      markdown({ extensions: [Table] }),
      livePreview(),
      markdownTableCompartment.of(markdownTableExtension()),
    ],
  });
  return new EditorView({ state, parent: document.body });
}

function pressEscape(view: EditorView): boolean {
  const binding = tableEscapeKeymap.find(k => k.key === 'Escape');
  return binding?.run?.(view) ?? false;
}

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

describe('markdownTable - rendering', () => {
  it('renders an HTML table widget when cursor is outside the table', () => {
    const content = '| A | B |\n| - | - |\n| 1 | 2 |\n\nAfter';
    view = createEditor(content, content.indexOf('After'));

    expect(view.contentDOM.querySelectorAll('.cm-md-table').length).toBe(1);
  });

  it('does NOT render the widget when cursor is on a table line (after user navigates)', () => {
    const content = '| A | B |\n| - | - |\n| 1 | 2 |\n\nAfter';
    view = createEditor(content, content.indexOf('After'));
    // Simulate the user navigating into the table via keyboard
    view.dispatch({
      selection: { anchor: 3 },
      userEvent: 'select.keyboard',
    });

    expect(view.contentDOM.querySelectorAll('.cm-md-table').length).toBe(0);
  });

  it('renders the widget on initial load even when default cursor lands on a table line', () => {
    // Mimics the "refresh / open doc" scenario: cursor defaults to position 0,
    // which happens to be on the table's first line. Widget should still render
    // because no user interaction has happened yet.
    const content = '| Name | ID |\n| - | - |\n| Ben | 92 |';
    view = createEditor(content, 0);

    expect(view.contentDOM.querySelectorAll('.cm-md-table').length).toBe(1);
  });

  it('cell editing does not flip the editor into "user navigated" mode', () => {
    // Regression guard: our cell input handler dispatches without a userEvent
    // annotation, so it must NOT toggle the cursor-hide rule. Otherwise a user
    // who opens a doc and types into a cell would suddenly see the widget
    // collapse to raw markdown (because their CM6 cursor is still at 0, which
    // lies on the table's first line).
    const content = '| Name | ID |\n| - | - |\n| Ben | 92 |';
    view = createEditor(content, 0);
    expect(view.contentDOM.querySelectorAll('.cm-md-table').length).toBe(1);

    // Simulate the user typing into a cell (mirrors what attachCellHandlers does)
    const cell = view.contentDOM.querySelector<HTMLElement>('.cm-md-table td')!;
    cell.textContent = 'Bens';
    cell.dispatchEvent(new Event('input', { bubbles: true }));

    // Widget must still be rendered — cell editing isn't "navigation into raw mode"
    expect(view.contentDOM.querySelectorAll('.cm-md-table').length).toBe(1);
  });

  it('renders header and body cell content', () => {
    const content = '| Name | Age |\n| - | - |\n| Alice | 30 |\n\nend';
    view = createEditor(content, content.indexOf('end'));

    const ths = view.contentDOM.querySelectorAll('.cm-md-table th');
    const tds = view.contentDOM.querySelectorAll('.cm-md-table td');
    expect(Array.from(ths).map(el => el.textContent)).toEqual(['Name', 'Age']);
    expect(Array.from(tds).map(el => el.textContent)).toEqual(['Alice', '30']);
  });

  it('renders bold, italic, and inline code marks inside table cells', () => {
    const content = '| **Name** | *Role* |\n| - | - |\n| `Alice` | **Editor** and *writer* |\n\nend';
    view = createEditor(content, content.indexOf('end'));

    const table = view.contentDOM.querySelector('.cm-md-table')!;
    expect(table.querySelector('th strong')?.textContent).toBe('Name');
    expect(table.querySelector('th em')?.textContent).toBe('Role');
    expect(table.querySelector('td code')?.textContent).toBe('Alice');
    expect(table.querySelector('tbody strong')?.textContent).toBe('Editor');
    expect(table.querySelector('tbody em')?.textContent).toBe('writer');
    expect(table.textContent).not.toContain('**');
    expect(table.textContent).not.toContain('`');
  });

  it('renders underscore bold and italic marks inside table cells', () => {
    const content = '| __Name__ | _Role_ |\n| - | - |\n| __Alice__ | _Editor_ |\n\nend';
    view = createEditor(content, content.indexOf('end'));

    const table = view.contentDOM.querySelector('.cm-md-table')!;
    expect(table.querySelector('th strong')?.textContent).toBe('Name');
    expect(table.querySelector('th em')?.textContent).toBe('Role');
    expect(table.querySelector('td strong')?.textContent).toBe('Alice');
    expect(table.querySelector('td em')?.textContent).toBe('Editor');
    expect(table.textContent).not.toContain('__');
  });

  it('shows exact Markdown while a formatted cell is focused and restores marks on blur', () => {
    const content = '| A |\n| - |\n| **bold** and `code` |\n\nend';
    view = createEditor(content, content.indexOf('end'));

    const td = view.contentDOM.querySelector<HTMLElement>('.cm-md-table td')!;
    expect(td.querySelector('strong')?.textContent).toBe('bold');
    expect(td.querySelector('code')?.textContent).toBe('code');

    td.focus();
    expect(td.textContent).toBe('**bold** and `code`');
    expect(td.querySelector('strong')).toBeNull();

    td.blur();
    expect(td.querySelector('strong')?.textContent).toBe('bold');
    expect(td.querySelector('code')?.textContent).toBe('code');
    expect(view.state.doc.toString()).toBe(content);
  });

  it('preserves exact underscore emphasis source across focus and blur', () => {
    const content = '| A |\n| - |\n| __bold__ and _italic_ |\n\nend';
    view = createEditor(content, content.indexOf('end'));

    const td = view.contentDOM.querySelector<HTMLElement>('.cm-md-table td')!;
    expect(td.querySelector('strong')?.textContent).toBe('bold');
    expect(td.querySelector('em')?.textContent).toBe('italic');

    td.focus();
    expect(td.textContent).toBe('__bold__ and _italic_');
    td.blur();

    expect(td.querySelector('strong')?.textContent).toBe('bold');
    expect(td.querySelector('em')?.textContent).toBe('italic');
    expect(view.state.doc.toString()).toBe(content);
  });

  it('keeps inline delimiters intact when editing a formatted cell', () => {
    const content = '| A |\n| - |\n| **bold** |\n\nend';
    view = createEditor(content, content.indexOf('end'));

    const td = view.contentDOM.querySelector<HTMLElement>('.cm-md-table td')!;
    td.focus();
    td.textContent = '**bolder** and *italic* with `code`';
    td.dispatchEvent(new Event('input', { bubbles: true }));

    expect(view.state.doc.toString()).toContain('| **bolder** and *italic* with `code` |');
    td.blur();
    expect(td.querySelector('strong')?.textContent).toBe('bolder');
    expect(td.querySelector('em')?.textContent).toBe('italic');
    expect(td.querySelector('code')?.textContent).toBe('code');
  });

  it('applies column alignment from the delimiter row', () => {
    const content = '| L | C | R |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |\n\nend';
    view = createEditor(content, content.indexOf('end'));

    const ths = view.contentDOM.querySelectorAll<HTMLElement>('.cm-md-table th');
    expect(ths[0].style.textAlign).toBe('left');
    expect(ths[1].style.textAlign).toBe('center');
    expect(ths[2].style.textAlign).toBe('right');
  });

  it('renders multiple tables in the same document', () => {
    const content = '| A |\n| - |\n| 1 |\n\n| B |\n| - |\n| 2 |\n\nend';
    view = createEditor(content, content.indexOf('end'));

    expect(view.contentDOM.querySelectorAll('.cm-md-table').length).toBe(2);
  });

  it('hides only the table whose line the cursor is on, when multiple tables exist', () => {
    const content = '| A |\n| - |\n| 1 |\n\n| B |\n| - |\n| 2 |\n\nend';
    view = createEditor(content, content.indexOf('end'));
    // User navigates onto the SECOND table's data row
    view.dispatch({
      selection: { anchor: content.indexOf('| 2 |') + 2 },
      userEvent: 'select.keyboard',
    });

    expect(view.contentDOM.querySelectorAll('.cm-md-table').length).toBe(1);
    const th = view.contentDOM.querySelector('.cm-md-table th');
    expect(th?.textContent).toBe('A');
  });

  it('does not include trailing non-pipe lines as table rows', () => {
    // Lezer's GFM Table parsing greedily includes following non-pipe lines as
    // TableRow children. The widget must filter these out — otherwise "after"
    // would render as a one-cell row inside the table.
    const content = '| A |\n| - |\n| 1 |\nafter';
    view = createEditor(content, content.length); // cursor at end of "after"

    const tableEls = view.contentDOM.querySelectorAll('.cm-md-table');
    expect(tableEls.length).toBe(1);
    const tds = tableEls[0].querySelectorAll('td');
    expect(tds.length).toBe(1);
    expect(tds[0].textContent).toBe('1');
  });

  it('cells are contenteditable for in-place editing', () => {
    const content = '| A |\n| - |\n| 1 |\n\nend';
    view = createEditor(content, content.indexOf('end'));

    const cells = view.contentDOM.querySelectorAll<HTMLElement>('.cm-md-table th, .cm-md-table td');
    expect(cells.length).toBeGreaterThan(0);
    cells.forEach(cell => {
      expect(cell.isContentEditable).toBe(true);
    });
  });

  it('renders only in live preview mode and shows raw markdown in source mode', () => {
    const content = '| A | B |\n| - | - |\n| 1 | 2 |\n\nAfter';
    view = createEditorWithModeToggle(content, content.indexOf('After'));

    expect(view.contentDOM.querySelectorAll('.cm-md-table').length).toBe(1);

    toggleSourceMode(view, true);
    expect(view.contentDOM.querySelectorAll('.cm-md-table').length).toBe(0);
    expect(view.contentDOM.textContent).toContain('| A | B |');

    toggleSourceMode(view, false);
    expect(view.contentDOM.querySelectorAll('.cm-md-table').length).toBe(1);
  });
});

describe('markdownTable - cell editing', () => {
  it('typing into a cell dispatches a document change for that cell only', () => {
    const content = '| A | B |\n| - | - |\n| 1 | 2 |\n\nend';
    view = createEditor(content, content.indexOf('end'));

    const tds = view.contentDOM.querySelectorAll<HTMLElement>('.cm-md-table td');
    const firstTd = tds[0];
    firstTd.textContent = '99';
    firstTd.dispatchEvent(new Event('input', { bubbles: true }));

    // The "1" in the first body cell should have become "99"; "2" untouched
    expect(view.state.doc.toString()).toBe('| A | B |\n| - | - |\n| 99 | 2 |\n\nend');
  });

  it('clearing a cell to empty dispatches the deletion', () => {
    const content = '| A |\n| - |\n| hello |\n\nend';
    view = createEditor(content, content.indexOf('end'));

    const td = view.contentDOM.querySelector<HTMLElement>('.cm-md-table td')!;
    td.textContent = '';
    td.dispatchEvent(new Event('input', { bubbles: true }));

    expect(view.state.doc.toString()).toBe('| A |\n| - |\n|  |\n\nend');
  });

  it('typing | in a cell escapes it as \\| in the doc and preserves table structure', () => {
    const content = '| A | B |\n| - | - |\n| 1 | 2 |\n\nend';
    view = createEditor(content, content.indexOf('end'));

    const firstTd = view.contentDOM.querySelector<HTMLElement>('.cm-md-table td')!;
    firstTd.textContent = 'a|b';
    firstTd.dispatchEvent(new Event('input', { bubbles: true }));

    // The | in the cell content must be backslash-escaped in the markdown,
    // otherwise lezer reparses the row as having three columns instead of two.
    expect(view.state.doc.toString()).toBe('| A | B |\n| - | - |\n| a\\|b | 2 |\n\nend');

    // And the row in the rendered widget should still have exactly 2 cells
    const tds = view.contentDOM.querySelectorAll('.cm-md-table tbody tr td');
    expect(tds.length).toBe(2);
  });

  it('typing \\ in a cell escapes it as \\\\ in the doc (round-trip preserves backslashes)', () => {
    const content = '| A |\n| - |\n| x |\n\nend';
    view = createEditor(content, content.indexOf('end'));

    const td = view.contentDOM.querySelector<HTMLElement>('.cm-md-table td')!;
    td.textContent = 'a\\b';
    td.dispatchEvent(new Event('input', { bubbles: true }));

    // The single \ should be doubled in the markdown source so it doesn't
    // get interpreted as an escape-character on the next reparse.
    expect(view.state.doc.toString()).toBe('| A |\n| - |\n| a\\\\b |\n\nend');
  });

  it('escaped pipes in source are displayed as plain | in the cell', () => {
    // A doc that already contains \| in a cell should render as "a|b" in the widget.
    const content = '| A |\n| - |\n| a\\|b |\n\nend';
    view = createEditor(content, content.indexOf('end'));

    const td = view.contentDOM.querySelector<HTMLElement>('.cm-md-table td')!;
    expect(td.textContent).toBe('a|b');
  });

  it('pasting text with newlines strips them so the row is not broken', () => {
    const content = '| A |\n| - |\n|  |\n\nend';
    view = createEditor(content, content.indexOf('end'));

    const td = view.contentDOM.querySelector<HTMLElement>('.cm-md-table td')!;

    // Construct a paste event with clipboardData containing newlines
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: { getData: (type: string) => type === 'text/plain' ? 'one\ntwo\r\nthree' : '' },
    });
    // Place a selection inside the cell so the paste handler has a range
    td.focus();
    const range = document.createRange();
    range.selectNodeContents(td);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    td.dispatchEvent(pasteEvent);

    // Newlines must be replaced with spaces — otherwise the markdown row
    // splits across multiple lines, breaking the table.
    expect(view.state.doc.toString().includes('\none\n')).toBe(false);
    expect(view.state.doc.toString()).toContain('one two three');
  });

  it('pasting text containing | escapes them so the row is not split', () => {
    const content = '| A |\n| - |\n|  |\n\nend';
    view = createEditor(content, content.indexOf('end'));

    const td = view.contentDOM.querySelector<HTMLElement>('.cm-md-table td')!;

    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: { getData: (type: string) => type === 'text/plain' ? 'a|b|c' : '' },
    });
    td.focus();
    const range = document.createRange();
    range.selectNodeContents(td);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    td.dispatchEvent(pasteEvent);

    expect(view.state.doc.toString()).toContain('a\\|b\\|c');
    // Still a single-column row
    const tds = view.contentDOM.querySelectorAll('.cm-md-table tbody tr td');
    expect(tds.length).toBe(1);
  });
});

describe('markdownTable - row navigation across edits', () => {
  // Helper to simulate typing into a focused cell (browser sets textContent, then fires input)
  function typeInCell(cell: HTMLElement, text: string) {
    cell.textContent = (cell.textContent ?? '') + text;
    cell.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function pressArrowDown(cell: HTMLElement) {
    cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  }

  it('typing then pressing Down produces a clean row with correct content (no accumulation)', () => {
    const content = '| Name | ID |\n| - | - |\n| 92 |  |\n\nend';
    view = createEditor(content, content.indexOf('end'));

    // Click into the "92" cell
    const firstDataCell = view.contentDOM.querySelector<HTMLElement>('.cm-md-table tbody tr td')!;
    firstDataCell.focus();

    // Type "f" → press Down (should add new row + focus it) → type "f" → repeat
    typeInCell(firstDataCell, 'f');
    pressArrowDown(firstDataCell);

    const docAfter = view.state.doc.toString();
    expect(docAfter.match(/92f/g)?.length ?? 0).toBe(1);
    expect(docAfter.split('\n').filter(l => l.includes('|')).length).toBe(4);
  });

  it('Enter on the last row adds a new row and focuses its first cell (typing lands there)', async () => {
    const content = '| Name | ID |\n| - | - |\n| Ben | 92 |\n\nend';
    view = createEditor(content, content.indexOf('end'));

    const benCell = view.contentDOM.querySelector<HTMLElement>('.cm-md-table tbody tr td')!;
    benCell.focus();

    // Press Enter on Ben — should append a new row and focus its first cell.
    benCell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    // Focus restoration is scheduled in a RAF after the dispatch.
    await new Promise<void>(r => requestAnimationFrame(() => r()));

    // Doc has the new empty row
    expect(view.state.doc.toString()).toContain('| Ben | 92 |\n|  |  |');

    // Focus is on a cell in the new last row, and that cell is editable.
    const active = document.activeElement as HTMLElement;
    expect(active?.tagName).toBe('TD');
    expect(active?.contentEditable).toBe('true');

    // The active cell belongs to the LAST tr (the one we just added).
    const lastTr = view.contentDOM.querySelector<HTMLElement>('.cm-md-table tbody tr:last-child');
    expect(lastTr?.contains(active)).toBe(true);

    // Typing into it produces a doc change (proves the input handler is wired up).
    active.textContent = 'a';
    active.dispatchEvent(new Event('input', { bubbles: true }));
    expect(view.state.doc.toString()).toContain('|a|');
  });

  it('repeated type-then-down does not corrupt the table or accumulate text in one cell', () => {
    const content = '| Name | ID |\n| - | - |\n| 92 |  |\n\nend';
    view = createEditor(content, content.indexOf('end'));

    // Re-find the last data row's first cell from the live DOM each iteration —
    // happy-dom doesn't reliably restore DOM focus across RAF, so we drive the
    // simulated user from the DOM rather than document.activeElement.
    function lastFirstCell(): HTMLElement {
      const rows = view.contentDOM.querySelectorAll('.cm-md-table tbody tr');
      const last = rows[rows.length - 1];
      return last.querySelector('td') as HTMLElement;
    }

    for (let i = 0; i < 5; i++) {
      const c = lastFirstCell();
      typeInCell(c, 'f');
      pressArrowDown(c);
    }

    // Each iteration adds exactly one 'f' to one cell. There should be no
    // run of more than one 'f' anywhere in the doc — if addRow's stale nodeTo
    // corrupted the markdown, characters would pile up.
    const doc = view.state.doc.toString();
    const fRuns = doc.match(/f+/g) ?? [];
    for (const run of fRuns) {
      expect(run.length, `unexpected run of 'f's in doc:\n${doc}`).toBeLessThanOrEqual(1);
    }

    // And the table's structural integrity: every table line should start with `|`
    // and end with `|`, with consistent column count.
    const tableLines = doc.split('\n').filter(l => l.includes('|'));
    for (const line of tableLines) {
      expect(line.trim().startsWith('|'), `malformed table line: ${JSON.stringify(line)}`).toBe(true);
      expect(line.trim().endsWith('|'), `malformed table line: ${JSON.stringify(line)}`).toBe(true);
    }
  });
});

describe('markdownTable - escape keymap', () => {
  it('moves cursor to the line after the table when pressed on a table line', () => {
    const content = '| A |\n| - |\n| 1 |\nafter';
    // Cursor on the header line (line 1)
    view = createEditor(content, 3);

    const handled = pressEscape(view);
    expect(handled).toBe(true);

    const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;
    expect(cursorLine).toBe(4); // "after" line
  });

  it('inserts a blank line and moves cursor when the table is at the last line of the doc', () => {
    const content = '| A |\n| - |\n| 1 |';
    view = createEditor(content, 3);
    const initialLines = view.state.doc.lines;

    const handled = pressEscape(view);
    expect(handled).toBe(true);

    expect(view.state.doc.lines).toBe(initialLines + 1);
    const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;
    expect(cursorLine).toBe(initialLines + 1);
  });

  it('returns false (no-op) when cursor is not on a table line', () => {
    const content = '| A |\n| - |\n| 1 |\n\nbefore';
    view = createEditor(content, content.indexOf('before') + 2);

    const handled = pressEscape(view);
    expect(handled).toBe(false);
  });

  it('Up arrow skips over the table widget rather than landing inside it (atomic)', () => {
    // Doc structure:
    //   line 1: | A | B |       ← table
    //   line 2: | - | - |       ← table
    //   line 3: | 1 | 2 |       ← table
    //   line 4: (blank)
    //   line 5: After
    const content = '| A | B |\n| - | - |\n| 1 | 2 |\n\nAfter';
    view = createEditor(content, content.length); // cursor at end of "After"

    // First Up: into the blank line above "After"
    cursorLineUp(view);
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(4);

    // Second Up: would normally land inside the table widget. With atomic
    // ranges, the cursor must skip over the widget entirely — so it lands
    // at line 1 (start of doc), NOT on lines 2 or 3 (inside the widget).
    cursorLineUp(view);
    const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;
    expect(cursorLine).toBe(1);
    // Specifically, the cursor must be at position 0 (start of doc / before
    // the widget content), not somewhere mid-table.
    expect(view.state.selection.main.head).toBe(0);
  });

  it('moving cursor off the table re-renders the widget (round-trip)', () => {
    const content = '| A |\n| - |\n| 1 |\nafter';
    view = createEditor(content, 3);
    // Simulate the user navigating onto the table line so the cursor-hide rule kicks in
    view.dispatch({ selection: { anchor: 3 }, userEvent: 'select.keyboard' });
    expect(view.contentDOM.querySelectorAll('.cm-md-table').length).toBe(0);

    pressEscape(view);

    // After escape, cursor is past the table → widget should now render
    expect(view.contentDOM.querySelectorAll('.cm-md-table').length).toBe(1);
  });
});
