/**
 * Frontmatter Extension for CodeMirror 6
 *
 * Two states, toggled by clicking the header bar:
 * - Collapsed (default): block-replace widget "Frontmatter: N properties"
 * - Expanded: raw Y.Text with decorations + widget spacers for alignment
 *
 * StateField: collapsed state (block-replace) + expanded header widget.
 * ViewPlugin: expanded line/mark decorations + spacer widgets.
 * Source mode: lightweight plugin that just neutralizes bold/underline.
 */

import {
  ViewPlugin,
  ViewUpdate,
  EditorView,
  Decoration,
  WidgetType,
  hoverTooltip,
} from '@codemirror/view';
import type { DecorationSet, Tooltip } from '@codemirror/view';
import { StateField, StateEffect, EditorSelection } from '@codemirror/state';
import type { StateCommand } from '@codemirror/state';

// ── Frontmatter detection ─────────────────────────────────────────

interface FrontmatterRange {
  from: number;
  to: number;
  keyCount: number;
}

function detectFrontmatter(doc: { line(n: number): { from: number; to: number; text: string }; lines: number }): FrontmatterRange | null {
  if (doc.lines === 0) return null;
  const firstLine = doc.line(1);
  if (firstLine.text.trim() !== '---') return null;

  for (let ln = 2; ln <= doc.lines; ln++) {
    const line = doc.line(ln);
    if (line.text.trim() === '---') {
      let keyCount = 0;
      for (let k = 2; k < ln; k++) {
        const t = doc.line(k).text;
        if (/^\S+\s*:/.test(t) && !/^-\s/.test(t)) keyCount++;
      }
      return { from: firstLine.from, to: line.to, keyCount };
    }
  }
  return null;
}

// ── Text measurement ──────────────────────────────────────────────

let measureCtx: CanvasRenderingContext2D | null = null;

/** Frontmatter lines render at 13px regardless of editor base font size. */
const FRONTMATTER_FONT_SIZE = '13px';

function measureTextWidth(text: string, refElement: HTMLElement): number {
  if (!measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d')!;
  }
  const style = getComputedStyle(refElement);
  // Build font string with frontmatter's actual font-size, not the editor's
  measureCtx.font = `${style.fontStyle} ${style.fontWeight} ${FRONTMATTER_FONT_SIZE} ${style.fontFamily}`;
  return measureCtx.measureText(text).width;
}

// ── Widgets ───────────────────────────────────────────────────────

/** Invisible inline spacer — CM6 accounts for widget width in cursor positioning */
class SpacerWidget extends WidgetType {
  constructor(private widthPx: number) { super(); }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.style.display = 'inline-block';
    span.style.width = `${this.widthPx}px`;
    span.style.height = '1em';
    span.style.verticalAlign = 'text-bottom';
    return span;
  }

  eq(other: SpacerWidget): boolean {
    return this.widthPx === other.widthPx;
  }
}

/** Toggle bar — used for both collapsed and expanded header */
class FrontmatterBarWidget extends WidgetType {
  constructor(private keyCount: number, private expanded: boolean) { super(); }

  toDOM(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'cm-frontmatter-bar' + (this.expanded ? ' cm-frontmatter-header' : '');

    const chevron = document.createElement('span');
    chevron.className = 'cm-frontmatter-chevron' + (this.expanded ? ' cm-frontmatter-chevron-open' : '');
    chevron.textContent = '›';
    bar.appendChild(chevron);

    const label = document.createElement('span');
    label.className = 'cm-frontmatter-label';
    label.textContent = this.keyCount === 1
      ? 'Frontmatter: 1 property'
      : `Frontmatter: ${this.keyCount} properties`;
    bar.appendChild(label);

    const expanded = this.expanded;
    bar.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const view = EditorView.findFromDOM(bar.closest('.cm-editor')!);
      view?.dispatch({ effects: setFrontmatterCollapsed.of(expanded) }); // toggle
    });

    return bar;
  }

  eq(other: FrontmatterBarWidget): boolean {
    return this.keyCount === other.keyCount && this.expanded === other.expanded;
  }
}

// ── State ─────────────────────────────────────────────────────────

const setFrontmatterCollapsed = StateEffect.define<boolean>();
export const setFrontmatterEnabled = StateEffect.define<boolean>();

interface FrontmatterState {
  collapsed: boolean;
  enabled: boolean;
  range: FrontmatterRange | null;
}

const frontmatterField = StateField.define<FrontmatterState>({
  create(state) {
    return { collapsed: true, enabled: true, range: detectFrontmatter(state.doc) };
  },

  update(value, tr) {
    let { collapsed, enabled } = value;
    let changed = false;

    for (const e of tr.effects) {
      if (e.is(setFrontmatterCollapsed)) { collapsed = e.value; changed = true; }
      if (e.is(setFrontmatterEnabled)) { enabled = e.value; changed = true; }
    }

    const range = tr.docChanged ? detectFrontmatter(tr.state.doc) : value.range;
    if (changed || tr.docChanged) {
      return { collapsed, enabled, range };
    }
    return value;
  },

  provide: (f) => EditorView.decorations.from(f, (val) => {
    if (!val.range || !val.enabled) return Decoration.none;
    if (val.collapsed) {
      return Decoration.set([
        Decoration.replace({
          widget: new FrontmatterBarWidget(val.range.keyCount, false),
          block: true,
        }).range(val.range.from, val.range.to),
      ]);
    }
    // Expanded: header widget above frontmatter
    return Decoration.set([
      Decoration.widget({
        widget: new FrontmatterBarWidget(val.range.keyCount, true),
        block: true,
        side: -1,
      }).range(val.range.from),
    ]);
  }),
});

// ── ViewPlugin (expanded decorations) ─────────────────────────────

/** Fixed pixel width for the key+spacer column. Values start after this. */
const TARGET_COLUMN_PX = 120;

const frontmatterExpandedPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged ||
          update.transactions.some(tr => tr.effects.some(e =>
            e.is(setFrontmatterCollapsed) || e.is(setFrontmatterEnabled)))) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView): DecorationSet {
      const field = view.state.field(frontmatterField);
      if (field.collapsed || !field.enabled || !field.range) return Decoration.none;

      const doc = view.state.doc;
      const fm = field.range;
      const targetPx = TARGET_COLUMN_PX;
      const decos: Array<{ from: number; to: number; deco: Decoration }> = [];
      const startLine = doc.lineAt(fm.from);
      const endLine = doc.lineAt(fm.to);

      // Background on all frontmatter lines
      for (let ln = startLine.number; ln <= endLine.number; ln++) {
        const line = doc.line(ln);
        decos.push({
          from: line.from, to: line.from,
          deco: Decoration.line({ class: 'cm-frontmatter-line' }),
        });
      }

      // Rounded corners
      decos.push({
        from: startLine.from, to: startLine.from,
        deco: Decoration.line({ class: 'cm-frontmatter-line-first' }),
      });
      decos.push({
        from: endLine.from, to: endLine.from,
        deco: Decoration.line({ class: 'cm-frontmatter-line-last' }),
      });

      // Hide --- delimiters
      if (startLine.from < startLine.to) {
        decos.push({
          from: startLine.from, to: startLine.to,
          deco: Decoration.mark({ class: 'cm-frontmatter-delimiter' }),
        });
      }
      if (endLine.from < endLine.to && endLine.number !== startLine.number) {
        decos.push({
          from: endLine.from, to: endLine.to,
          deco: Decoration.mark({ class: 'cm-frontmatter-delimiter' }),
        });
      }

      // Body lines
      let lastValueIndentPx = 0; // track value column for continuation lines
      for (let ln = startLine.number + 1; ln < endLine.number; ln++) {
        const line = doc.line(ln);
        const keyMatch = line.text.match(/^(\S+)\s*:\s*/);
        const isDashLine = /^-\s/.test(line.text); // "- foo" = misindented list item, not a key
        if (isDashLine) {
          if (lastValueIndentPx > 0) {
            decos.push({
              from: line.from, to: line.from,
              deco: Decoration.line({
                attributes: { style: `padding-left: ${lastValueIndentPx}px !important` },
              }),
            });
          }
          decos.push({
            from: line.from, to: line.to,
            deco: Decoration.mark({ class: 'cm-frontmatter-bad-indent' }),
          });
        } else if (keyMatch) {
          const keyLen = keyMatch[1].length;
          const colonPos = line.from + keyLen;
          const colonEnd = line.from + keyMatch[0].length;
          const keyTextPx = measureTextWidth(keyMatch[1], view.contentDOM);
          const spacerPx = Math.max(0, Math.round(targetPx - keyTextPx));
          const colonPx = measureTextWidth(': ', view.contentDOM);
          const wrapIndent = Math.round(targetPx + colonPx);
          lastValueIndentPx = wrapIndent;

          // Hanging indent for value wrapping — wrapped lines align with value start (after colon)
          decos.push({
            from: line.from, to: line.from,
            deco: Decoration.line({
              attributes: { style: `padding-left: ${wrapIndent}px !important; text-indent: -${wrapIndent}px` },
            }),
          });
          // Key
          decos.push({
            from: line.from, to: colonPos,
            deco: Decoration.mark({ class: 'cm-frontmatter-key' }),
          });
          // Spacer before colon
          if (spacerPx > 0) {
            decos.push({
              from: colonPos, to: colonPos,
              deco: Decoration.widget({
                widget: new SpacerWidget(spacerPx),
                side: -1,
              }),
            });
          }
          // Colon + space
          decos.push({
            from: colonPos, to: colonEnd,
            deco: Decoration.mark({ class: 'cm-frontmatter-colon' }),
          });
        } else if (line.text.match(/^\s/) && lastValueIndentPx > 0) {
          // Indented continuation line (YAML list items, multi-line values)
          // No text-indent — just shift the whole line to the value column
          const badIndent = /^\s*- /.test(line.text) && !/^ {2}- /.test(line.text);
          decos.push({
            from: line.from, to: line.from,
            deco: Decoration.line({
              attributes: { style: `padding-left: ${lastValueIndentPx}px !important` },
            }),
          });
          decos.push({
            from: line.from, to: line.to,
            deco: Decoration.mark({
              class: badIndent ? 'cm-frontmatter-bad-indent' : 'cm-frontmatter-value-continuation',
            }),
          });
        } else if (line.text.length > 0) {
          lastValueIndentPx = 0;
          decos.push({
            from: line.from, to: line.to,
            deco: Decoration.mark({ class: 'cm-frontmatter-key-incomplete' }),
          });
        }
      }

      decos.sort((a, b) => a.from - b.from || a.to - b.to);
      return Decoration.set(decos.map(d => d.deco.range(d.from, d.to)));
    }
  },
  { decorations: (v) => v.decorations }
);

// ── Source-mode plugin ────────────────────────────────────────────

const frontmatterSourcePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView): DecorationSet {
      const fm = view.state.field(frontmatterField).range;
      if (!fm) return Decoration.none;

      const doc = view.state.doc;
      const decos: Array<{ from: number; to: number; deco: Decoration }> = [];
      const startLine = doc.lineAt(fm.from);
      const endLine = doc.lineAt(fm.to);

      for (let ln = startLine.number; ln <= endLine.number; ln++) {
        decos.push({
          from: doc.line(ln).from, to: doc.line(ln).from,
          deco: Decoration.line({ class: 'cm-frontmatter-line' }),
        });
      }

      decos.sort((a, b) => a.from - b.from);
      return Decoration.set(decos.map(d => d.deco.range(d.from, d.to)));
    }
  },
  { decorations: (v) => v.decorations }
);

// ── Enter handler for YAML lists ─────────────────────────────────

const frontmatterEnter: StateCommand = ({ state, dispatch }) => {
  const fm = state.field(frontmatterField);
  if (fm.collapsed || !fm.enabled || !fm.range) return false;

  const pos = state.selection.main.head;
  if (pos < fm.range.from || pos > fm.range.to) return false;

  const line = state.doc.lineAt(pos);
  const listMatch = line.text.match(/^(\s+- )/);

  if (listMatch) {
    const prefix = listMatch[1]; // e.g. "  - "

    // Empty list item (just "  - ") — remove marker, exit list
    if (/^\s+-\s*$/.test(line.text)) {
      const prevLineEnd = line.from > 0 ? line.from - 1 : line.from;
      dispatch(state.update({
        changes: { from: prevLineEnd, to: line.to, insert: '\n' },
        selection: EditorSelection.cursor(prevLineEnd + 1),
        scrollIntoView: true,
        userEvent: 'input',
      }));
      return true;
    }

    // Continue list — insert newline + same prefix
    dispatch(state.update({
      changes: { from: pos, insert: '\n' + prefix },
      selection: EditorSelection.cursor(pos + 1 + prefix.length),
      scrollIntoView: true,
      userEvent: 'input',
    }));
    return true;
  }

  // Non-list line inside frontmatter — plain newline
  // (prevents markdown Enter handler from misinterpreting frontmatter content)
  dispatch(state.update({
    changes: { from: pos, insert: '\n' },
    selection: EditorSelection.cursor(pos + 1),
    scrollIntoView: true,
    userEvent: 'input',
  }));
  return true;
};

export const frontmatterKeymap = [
  { key: 'Enter' as const, run: frontmatterEnter },
];

// ── Hover tooltips for frontmatter errors ────────────────────────

const frontmatterHover = hoverTooltip((view, pos): Tooltip | null => {
  const fm = view.state.field(frontmatterField);
  if (fm.collapsed || !fm.enabled || !fm.range) return null;
  if (pos < fm.range.from || pos > fm.range.to) return null;

  const line = view.state.doc.lineAt(pos);

  // Dash at column 0 — misindented list item
  if (/^-\s/.test(line.text)) {
    return {
      pos: line.from,
      end: line.to,
      above: true,
      create: () => {
        const dom = document.createElement('div');
        dom.className = 'cm-frontmatter-tooltip';
        dom.textContent = 'List items must be indented with 2 spaces: "  - value". This can be easier to see in source editing mode';
        return { dom };
      },
    };
  }

  // Indented list item with wrong indentation
  if (/^\s*-\s/.test(line.text) && !/^ {2}- /.test(line.text)) {
    const spaces = line.text.match(/^(\s*)/)?.[1].length ?? 0;
    return {
      pos: line.from,
      end: line.to,
      above: true,
      create: () => {
        const dom = document.createElement('div');
        dom.className = 'cm-frontmatter-tooltip';
        dom.textContent = `List items need exactly 2 spaces before the dash (found ${spaces}). This can be easier to see in source editing mode`;
        return { dom };
      },
    };
  }

  return null;
});

// ── Exports ───────────────────────────────────────────────────────

export { frontmatterField, frontmatterSourcePlugin };
export const frontmatterPlugin = [frontmatterExpandedPlugin, frontmatterHover];
