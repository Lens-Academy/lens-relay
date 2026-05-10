import { EditorView, Decoration, WidgetType, keymap } from '@codemirror/view';
import type { DecorationSet, KeyBinding } from '@codemirror/view';
import { Compartment, Prec, StateField, RangeSetBuilder, Transaction } from '@codemirror/state';
import type { EditorState, Extension } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';

type Align = 'left' | 'center' | 'right';

interface CellInfo {
  from: number;
  to: number;
  content: string;
  align: Align;
}

interface TableWidgetData {
  headers: CellInfo[];
  rows: CellInfo[][];
  nodeFrom: number;
  nodeTo: number;
}

// `|` and `\` are syntactically meaningful inside a GFM table cell. Escape
// them with a backslash when writing user input to the doc; reverse the
// escape when displaying. Without this, typing or pasting `|` would split
// the row into a new column on the next reparse.
function escapeForCell(s: string): string {
  return s.replace(/[\\|]/g, c => '\\' + c);
}

function unescapeFromCell(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      out += s[i + 1];
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

function parseAlignments(delimText: string): Align[] {
  const parts = delimText.split('|');
  return parts.slice(1, parts.length - 1).map(cell => {
    const t = cell.trim();
    if (t.startsWith(':') && t.endsWith(':')) return 'center';
    if (t.endsWith(':')) return 'right';
    return 'left';
  });
}

class TableWidget extends WidgetType {
  constructor(private readonly data: TableWidgetData) {
    super();
  }

  eq(other: TableWidget): boolean {
    return (
      this.data.nodeFrom === other.data.nodeFrom &&
      this.data.nodeTo === other.data.nodeTo &&
      this.data.headers.length === other.data.headers.length &&
      this.data.rows.length === other.data.rows.length &&
      this.data.headers.every((h, i) => h.content === other.data.headers[i]?.content) &&
      this.data.rows.every((row, ri) =>
        row.every((cell, ci) => cell.content === other.data.rows[ri]?.[ci]?.content),
      )
    );
  }

  // Called when eq() returns false — patch the existing DOM instead of recreating it.
  // Returning true tells CM6 to keep the DOM node, preserving focus in the active cell.
  updateDOM(dom: HTMLElement): boolean {
    const thead = dom.querySelector('thead');
    const tbody = dom.querySelector('tbody');
    if (!thead || !tbody) return false;

    const thCells = thead.querySelectorAll('th');
    const tbodyRows = tbody.querySelectorAll('tr');

    // Structural change (different row/col count) → recreate
    if (thCells.length !== this.data.headers.length) return false;
    if (tbodyRows.length !== this.data.rows.length) return false;

    // Update position attributes and content for all cells.
    // Skip textContent update for the actively focused cell to avoid interrupting the user.
    this.data.headers.forEach((cell, ci) => {
      const el = thCells[ci] as HTMLElement | undefined;
      if (!el) return;
      el.dataset.cellFrom = String(cell.from);
      el.dataset.cellTo = String(cell.to);
      if (document.activeElement !== el) el.textContent = unescapeFromCell(cell.content.trim());
    });

    this.data.rows.forEach((row, ri) => {
      const tr = tbodyRows[ri];
      if (!tr) return;
      const tds = tr.querySelectorAll('td');
      row.forEach((cell, ci) => {
        const el = tds[ci] as HTMLElement | undefined;
        if (!el) return;
        el.dataset.cellFrom = String(cell.from);
        el.dataset.cellTo = String(cell.to);
        if (document.activeElement !== el) el.textContent = unescapeFromCell(cell.content.trim());
      });
    });

    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'cm-md-table-wrapper';
    // Used by addRow() to find this widget's DOM after a transaction
    wrapper.dataset.tableFrom = String(this.data.nodeFrom);

    const table = document.createElement('table');
    table.className = 'cm-md-table';

    const thead = table.createTHead();
    const headerTr = thead.insertRow();
    this.data.headers.forEach((cell, ci) => {
      const th = document.createElement('th');
      th.contentEditable = 'true';
      th.textContent = unescapeFromCell(cell.content.trim());
      th.style.textAlign = cell.align;
      th.dataset.cellFrom = String(cell.from);
      th.dataset.cellTo = String(cell.to);
      th.dataset.colIndex = String(ci);
      this.attachCellHandlers(th, view);
      headerTr.appendChild(th);
    });

    const tbody = table.createTBody();
    this.data.rows.forEach((row) => {
      const tr = tbody.insertRow();
      this.data.headers.forEach((_, ci) => {
        const cell = row[ci];
        const td = tr.insertCell();
        // Rows with fewer cells than the header (malformed markdown) get
        // non-editable placeholders. Editing those would have nowhere safe
        // to insert into and would corrupt the table.
        if (!cell) {
          td.dataset.colIndex = String(ci);
          return;
        }
        td.contentEditable = 'true';
        td.textContent = unescapeFromCell(cell.content.trim());
        td.style.textAlign = cell.align;
        td.dataset.cellFrom = String(cell.from);
        td.dataset.cellTo = String(cell.to);
        td.dataset.colIndex = String(ci);
        this.attachCellHandlers(td, view);
      });
    });

    wrapper.appendChild(table);
    return wrapper;
  }

  private attachCellHandlers(el: HTMLElement, view: EditorView) {
    // Stop CM6 from stealing mouse events (which would blur the contenteditable)
    el.addEventListener('mousedown', e => e.stopPropagation());

    // Plain-text paste only; newlines collapse to spaces so the paste
    // doesn't split the markdown row across multiple lines. Pipes and
    // backslashes are handled by the input handler's escapeForCell.
    el.addEventListener('paste', e => {
      e.preventDefault();
      const text = (e.clipboardData?.getData('text/plain') ?? '').replace(/\r?\n/g, ' ');
      const sel = window.getSelection();
      if (!sel?.rangeCount) return;
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      sel.collapseToEnd();
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Sync contenteditable → CM6 document on every change. The DOM holds the
    // user-visible text; the doc holds the GFM-escaped form. Every dispatch
    // converts DOM → doc by escaping `|` and `\`.
    el.addEventListener('input', () => {
      const from = parseInt(el.dataset.cellFrom!);
      const to = parseInt(el.dataset.cellTo!);
      const docContent = escapeForCell(el.textContent ?? '');
      view.dispatch({
        changes: { from, to, insert: docContent },
      });
      // Optimistically update cellTo so the next input event uses the right range.
      // updateDOM() will overwrite this with the authoritative value after the transaction.
      el.dataset.cellTo = String(from + docContent.length);
    });

    // Keyboard navigation
    el.addEventListener('keydown', e => {
      const colIdx = parseInt(el.dataset.colIndex ?? '0');

      if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        this.navigateFlat(el, e.shiftKey ? -1 : 1, colIdx, view);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        this.navigateColumn(el, colIdx, 1, view);
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        el.blur();
        view.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        this.navigateColumn(el, colIdx, -1, view);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        this.navigateColumn(el, colIdx, 1, view);
      } else {
        // Prevent CM6 keymaps (e.g. bold, italic shortcuts) from firing while editing a cell
        e.stopPropagation();
      }
    });
  }

  private allCells(el: HTMLElement): HTMLElement[] {
    return Array.from(
      el.closest('table')?.querySelectorAll('[contenteditable]') ?? [],
    ) as HTMLElement[];
  }

  private navigateFlat(current: HTMLElement, delta: number, colIdx: number, view: EditorView) {
    const cells = this.allCells(current);
    const idx = cells.indexOf(current);
    const next = cells[idx + delta];
    if (next) {
      this.focusCell(next);
    } else if (delta > 0) {
      this.addRow(current, view, colIdx);
    }
  }

  private navigateColumn(current: HTMLElement, colIdx: number, delta: number, view: EditorView) {
    const colCells = (Array.from(
      current.closest('table')?.querySelectorAll(`[data-col-index="${colIdx}"]`) ?? [],
    ) as HTMLElement[]);
    const pos = colCells.indexOf(current);
    const target = colCells[pos + delta];
    if (target) {
      this.focusCell(target);
    } else if (delta > 0) {
      this.addRow(current, view, colIdx);
    }
  }

  private focusCell(el: HTMLElement) {
    el.focus();
    // Position cursor at end of content
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  private addRow(currentCell: HTMLElement, view: EditorView, focusColIdx = 0) {
    const numCols = this.data.headers.length;
    const emptyRow = '\n| ' + Array(numCols).fill('').join(' | ') + ' |';

    // Recompute the table's true end from the current state. `this.data.nodeTo`
    // is captured at widget construction and goes stale across cell edits
    // (because handlers survive updateDOM-only rebuilds with their original
    // closure). The cell's dataset.cellFrom is kept fresh by updateDOM, so we
    // use it as a stable anchor INTO the current table.
    const cellFrom = parseInt(currentCell.dataset.cellFrom ?? '0');
    const tableNode = findTableAt(view.state, cellFrom);
    if (!tableNode) return;

    const { toLine } = tableLineRange(view.state, tableNode);
    const insertPos = view.state.doc.line(toLine).to;
    // Capture the table's start before dispatch so we can find its (rebuilt) wrapper.
    // Inserting at end-of-table doesn't shift the table's start, so this remains valid.
    const tableFrom = tableNode.from;

    view.dispatch({
      changes: { from: insertPos, to: insertPos, insert: emptyRow },
    });

    // After the dispatch, find the (possibly rebuilt) wrapper by its tracked
    // start position and focus the new row's first cell.
    requestAnimationFrame(() => {
      if (!view.dom.isConnected) return;
      const wrapper = view.dom.querySelector(`.cm-md-table-wrapper[data-table-from="${tableFrom}"]`);
      const rows = wrapper?.querySelectorAll('tbody tr');
      if (!rows?.length) return;
      const newRow = rows[rows.length - 1];
      const cell = newRow?.querySelectorAll('td')[focusColIdx] as HTMLElement | undefined;
      if (cell) this.focusCell(cell);
    });
  }

  // Tell CM6 to leave all events inside the widget to the DOM; prevents CM6 keymaps
  // from firing and avoids CM6 repositioning its cursor on click.
  ignoreEvent(): boolean {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Decorations (StateField — block decorations are not allowed via ViewPlugin)
// ---------------------------------------------------------------------------

function findTableAt(state: EditorState, pos: number): SyntaxNode | null {
  let found: SyntaxNode | null = null;
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === 'Table' && node.from <= pos && pos <= node.to) {
        found = node.node;
        return false;
      }
    },
  });
  return found;
}

// Lezer omits TableCell nodes for whitespace-only cells (`|  |  |` parses with
// only TableDelimiter children, no cells). Walk the row's delimiters and
// synthesize cell info for the gaps between them so empty cells have a real
// document range to write into when the user types.
function extractRowCells(state: EditorState, row: SyntaxNode): CellInfo[] {
  const delims: Array<{ from: number; to: number }> = [];
  const cells: Array<{ from: number; to: number; content: string }> = [];
  for (let c = row.firstChild; c; c = c.nextSibling) {
    if (c.name === 'TableDelimiter') delims.push({ from: c.from, to: c.to });
    else if (c.name === 'TableCell') cells.push({ from: c.from, to: c.to, content: state.sliceDoc(c.from, c.to) });
  }
  const out: CellInfo[] = [];
  for (let i = 0; i < delims.length - 1; i++) {
    const gapStart = delims[i].to;
    const gapEnd = delims[i + 1].from;
    const cell = cells.find(c => c.from >= gapStart && c.to <= gapEnd);
    if (cell) {
      out.push({ ...cell, align: 'left' });
    } else {
      // Empty cell — span the whole gap so typing replaces it cleanly
      out.push({ from: gapStart, to: gapEnd, content: state.sliceDoc(gapStart, gapEnd), align: 'left' });
    }
  }
  return out;
}

// Lezer's GFM Table parsing is "loose": it greedily includes trailing non-pipe
// lines as TableRow children even when they aren't real rows. Filter those out
// by requiring the row's text to contain a `|`.
function tableLineRange(state: EditorState, node: SyntaxNode) {
  const fromLine = state.doc.lineAt(node.from).number;
  let lastContentTo = node.from;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (
      (child.name === 'TableHeader' || child.name === 'TableDelimiter' || child.name === 'TableRow') &&
      state.sliceDoc(child.from, child.to).includes('|')
    ) {
      lastContentTo = child.to;
    }
  }
  const toLine = state.doc.lineAt(lastContentTo).number;
  return { fromLine, toLine };
}

function buildTableDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { selection } = state;
  const widgets: Array<{ from: number; to: number; deco: Decoration }> = [];

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'Table') return;

      // While the cursor is on any line the table occupies, show raw markdown
      // so the user can type freely. Character-position checks aren't enough
      // because lezer's TableDelimiter ends before trailing whitespace, so a
      // cursor in the trailing space would fall outside node.to even though
      // the user is still mid-row. Line-number comparison avoids that.
      // Skip this check until the user has actually interacted with the editor
      // (otherwise the default cursor at position 0 on doc load reads as
      // "user is editing the table at the top of the doc").
      const userInteracted = state.field(userInteractedField, false);
      const { fromLine: tableFromLine, toLine: tableToLine } = tableLineRange(state, node.node);
      const cursorInside = userInteracted && selection.ranges.some(r => {
        const cursorFromLine = state.doc.lineAt(r.from).number;
        const cursorToLine = state.doc.lineAt(r.to).number;
        return cursorToLine >= tableFromLine && cursorFromLine <= tableToLine;
      });
      if (cursorInside) return false;

      const headers: CellInfo[] = [];
      const rows: CellInfo[][] = [];
      let aligns: Align[] = [];

      for (let child = node.node.firstChild; child; child = child.nextSibling) {
        if (child.name === 'TableHeader') {
          headers.push(...extractRowCells(state, child.node));
        } else if (child.name === 'TableDelimiter' && aligns.length === 0) {
          // First top-level TableDelimiter is the separator row (|---|---|)
          aligns = parseAlignments(state.sliceDoc(child.from, child.to));
        } else if (child.name === 'TableRow' && state.sliceDoc(child.from, child.to).includes('|')) {
          rows.push(extractRowCells(state, child.node));
        }
      }

      headers.forEach((h, i) => { h.align = aligns[i] ?? 'left'; });
      rows.forEach(row => row.forEach((cell, i) => { cell.align = aligns[i] ?? 'left'; }));

      const firstLine = state.doc.line(tableFromLine);
      const lastLine = state.doc.line(tableToLine);
      widgets.push({
        from: firstLine.from,
        to: lastLine.to,
        deco: Decoration.replace({
          widget: new TableWidget({ headers, rows, nodeFrom: node.from, nodeTo: node.to }),
          block: true,
        }),
      });

      return false;
    },
  });

  widgets.sort((a, b) => a.from - b.from);
  for (const { from, to, deco } of widgets) {
    builder.add(from, to, deco);
  }
  return builder.finish();
}

// Tracks whether the user has actually interacted with the editor (typed,
// clicked, used a keymap, etc.). Until they have, we skip the "cursor on a
// table line → show raw" rule — otherwise an opened doc that happens to start
// with a table renders as raw markdown because the default cursor position
// (0) lies on the table's first line.
const userInteractedField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    if (value) return true; // sticky once set
    return tr.annotation(Transaction.userEvent) !== undefined;
  },
});

const tableField = StateField.define<DecorationSet>({
  create(state) {
    return buildTableDecorations(state);
  },
  update(value, tr) {
    if (tr.docChanged || tr.selection || tr.annotation(Transaction.userEvent) !== undefined) {
      return buildTableDecorations(tr.state);
    }
    return value;
  },
  // Provide the same range set as both decorations AND atomic ranges. Atomic
  // makes arrow-key navigation skip over the widget instead of landing inside
  // it — predictable and matches Obsidian Live Preview. The ranges only exist
  // when the widget is rendered (cursor not on a table line), so the typing
  // flow that creates a table from raw markdown is unaffected.
  provide: f => [
    EditorView.decorations.from(f),
    EditorView.atomicRanges.of(view => view.state.field(f)),
  ],
});

// ---------------------------------------------------------------------------
// Escape keymap — moves the text cursor past the table to trigger rendering
// ---------------------------------------------------------------------------

export const tableEscapeKeymap: KeyBinding[] = [{
  key: 'Escape',
  run(view: EditorView): boolean {
    const { state } = view;
    const cursorLine = state.doc.lineAt(state.selection.main.from).number;
    let handled = false;

    syntaxTree(state).iterate({
      enter(node) {
        if (node.name !== 'Table') return;
        const { fromLine: tableFromLine, toLine: tableToLine } = tableLineRange(state, node.node);
        if (cursorLine < tableFromLine || cursorLine > tableToLine) return;

        // Text cursor is on a table line — jump it to the line after the table.
        if (tableToLine < state.doc.lines) {
          const nextLine = state.doc.line(tableToLine + 1);
          view.dispatch({ selection: { anchor: nextLine.from } });
        } else {
          // Table ends at the last line of the doc — append a blank line first.
          const tableEnd = state.doc.line(tableToLine).to;
          view.dispatch({
            changes: { from: tableEnd, to: tableEnd, insert: '\n' },
            selection: { anchor: tableEnd + 1 },
          });
        }
        handled = true;
        return false;
      },
    });

    return handled;
  },
}];

export const markdownTableCompartment = new Compartment();

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const tableTheme = EditorView.theme({
  '.cm-md-table-wrapper': {
    display: 'block',
    overflowX: 'auto',
    margin: '6px 0',
    borderRadius: '6px',
    border: '1px solid #e5e7eb',
  },
  '.cm-md-table': {
    borderCollapse: 'collapse',
    width: '100%',
    fontSize: '14px',
    lineHeight: '1.5',
  },
  '.cm-md-table th, .cm-md-table td': {
    padding: '6px 12px',
    borderRight: '1px solid #e5e7eb',
    borderBottom: '1px solid #e5e7eb',
    whiteSpace: 'nowrap',
    outline: 'none',
    minWidth: '60px',
  },
  // Force a line-box of full text height in every cell so empty cells don't
  // collapse below the height of filled rows. The pseudo has zero width and
  // is invisible, so it doesn't affect cell content or cursor positioning.
  '.cm-md-table th::before, .cm-md-table td::before': {
    content: '""',
    display: 'inline-block',
    width: '0',
    height: '1.5em',
    verticalAlign: 'middle',
  },
  '.cm-md-table th:last-child, .cm-md-table td:last-child': {
    borderRight: 'none',
  },
  '.cm-md-table tbody tr:last-child td': {
    borderBottom: 'none',
  },
  '.cm-md-table thead tr': {
    borderBottom: '2px solid #e5e7eb',
  },
  '.cm-md-table th': {
    background: '#f9fafb',
    fontWeight: '600',
    color: '#374151',
  },
  '.cm-md-table td': {
    color: '#4b5563',
    background: 'white',
  },
  '.cm-md-table tbody tr:hover td': {
    background: '#f9fafb',
  },
  '.cm-md-table th:focus, .cm-md-table td:focus': {
    background: '#eff6ff',
    boxShadow: 'inset 0 0 0 2px #3b82f6',
    borderRadius: '2px',
  },
});

export function markdownTableExtension(): Extension {
  return [userInteractedField, tableField, Prec.highest(keymap.of(tableEscapeKeymap)), tableTheme];
}
