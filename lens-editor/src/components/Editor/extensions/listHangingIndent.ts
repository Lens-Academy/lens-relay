// Hanging indent for list items.
//
// With EditorView.lineWrapping, a long bullet line wraps back to column zero,
// so the continuation rows sit under the bullet instead of under the text.
// Obsidian aligns wrapped rows with the first row's text; this plugin does the
// same by measuring the rendered width of each list line's prefix (leading
// indentation + marker + optional task checkbox) and applying
//
//   padding-left: <prefix width>; text-indent: -<prefix width>
//
// via a `--list-hang` custom property on the line (see index.css).
//
// The measurement is a fixpoint only if the prefix's rendered width does not
// itself depend on the line's text-indent. Leading tabs break that: tab stops
// are computed from the content edge, so a negative text-indent changes how
// wide each tab renders. Leading whitespace on list lines is therefore wrapped
// in a `.cm-list-indent` span styled `display: inline-block; text-indent: 0`,
// which gives the tabs their own tab stops and a fixed width.

import { ViewPlugin, Decoration, EditorView } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { StateEffect } from '@codemirror/state';
import type { EditorState, Line, Range } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { frontmatterField } from './frontmatter';

type SyntaxNode = ReturnType<typeof syntaxTree>['topNode'];

/**
 * Blockquote markers + indent, bullet/ordered marker, whitespace, optional
 * task marker. Group 1 is everything before the marker.
 */
const LIST_PREFIX_RE = /^((?:[ \t]*>)*[ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/;

/** Block contexts in which a `- ` line is literal text, not a list item. */
const NON_LIST_BLOCKS = new Set(['FencedCode', 'CodeBlock', 'HTMLBlock', 'CommentBlock']);

/**
 * Length of the list prefix (indent + marker + task checkbox + spaces) on
 * `line`, or null when the line is not a list item. Exported for tests.
 */
export function listPrefixLength(state: EditorState, line: Line): number | null {
  const match = LIST_PREFIX_RE.exec(line.text);
  if (!match) return null;

  const fm = state.field(frontmatterField, false)?.range;
  if (fm && line.from >= fm.from && line.from < fm.to) return null;

  let node: SyntaxNode | null = syntaxTree(state).resolveInner(line.from, 1);
  for (; node; node = node.parent) {
    if (NON_LIST_BLOCKS.has(node.name)) return null;
  }

  return match[0].length;
}

/** Dispatched (deferred) after a measurement produced new hang widths. */
const listHangMeasured = StateEffect.define<null>();

interface LineMeasure {
  from: number;
  hang: number;
}

const listHangingIndentPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    /** Measured prefix width in px, keyed by line start. */
    private hang = new Map<number, number>();
    private dispatchScheduled = false;
    private destroyed = false;

    constructor(view: EditorView) {
      this.decorations = this.build(view);
      view.requestMeasure(this.measureRequest);
    }

    update(update: ViewUpdate) {
      if (update.docChanged) {
        const mapped = new Map<number, number>();
        for (const [from, hang] of this.hang) {
          const pos = update.changes.mapPos(from, 1);
          if (update.state.doc.lineAt(pos).from === pos) mapped.set(pos, hang);
        }
        this.hang = mapped;
      }

      const ownEffectOnly =
        !update.docChanged && !update.viewportChanged && !update.geometryChanged &&
        update.transactions.length > 0 &&
        update.transactions.every((tr) => tr.effects.some((e) => e.is(listHangMeasured)));

      // Prefix widths depend on things other plugins decide per update (bullet
      // and checkbox widgets appear/disappear with the selection, source mode
      // toggles, ...), so re-measure on every update except the one we caused.
      this.decorations = this.build(update.view);
      if (!ownEffectOnly) update.view.requestMeasure(this.measureRequest);
    }

    destroy() {
      this.destroyed = true;
    }

    private build(view: EditorView): DecorationSet {
      const ranges: Range<Decoration>[] = [];
      const seen = new Set<number>();
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to; ) {
          const line = view.state.doc.lineAt(pos);
          pos = line.to + 1;
          if (seen.has(line.from)) continue;
          seen.add(line.from);

          const prefixLen = listPrefixLength(view.state, line);
          if (prefixLen === null) continue;

          const hang = this.hang.get(line.from);
          if (hang !== undefined) {
            ranges.push(
              Decoration.line({
                class: 'cm-list-line',
                attributes: { style: `--list-hang: ${hang}px` },
              }).range(line.from),
            );
          }

          const indentLen = LIST_PREFIX_RE.exec(line.text)![1].length;
          if (indentLen > 0) {
            ranges.push(
              Decoration.mark({ class: 'cm-list-indent' }).range(line.from, line.from + indentLen),
            );
          }
        }
      }
      return Decoration.set(ranges, true);
    }

    private measureRequest = {
      key: this,
      read: (view: EditorView): LineMeasure[] => {
        const out: LineMeasure[] = [];
        const maxHang = view.contentDOM.clientWidth / 2;
        const seen = new Set<number>();
        for (const { from, to } of view.visibleRanges) {
          for (let pos = from; pos <= to; ) {
            const line = view.state.doc.lineAt(pos);
            pos = line.to + 1;
            if (seen.has(line.from)) continue;
            seen.add(line.from);

            const prefixLen = listPrefixLength(view.state, line);
            if (prefixLen === null) continue;

            const start = view.coordsAtPos(line.from, 1);
            const end = view.coordsAtPos(line.from + prefixLen, 1);
            if (!start || !end) continue;
            // Prefix wrapped onto a second row, or nonsensical: no hang.
            if (end.top >= start.bottom) continue;
            const hang = Math.round((end.left - start.left) * 100) / 100;
            if (hang <= 0 || hang > maxHang) continue;
            out.push({ from: line.from, hang });
          }
        }
        return out;
      },
      write: (measured: LineMeasure[], view: EditorView) => {
        let changed = false;
        const next = new Map<number, number>();
        for (const { from, hang } of measured) {
          next.set(from, hang);
          if (this.hang.get(from) !== hang) changed = true;
        }
        // Lines that scrolled out of view keep their last width so they do not
        // flash unindented when scrolled back in before the next measurement.
        for (const [from, hang] of this.hang) {
          if (!next.has(from)) next.set(from, hang);
        }
        if (!changed) return;
        this.hang = next;

        // Measure callbacks run inside CM's update cycle, where dispatch is
        // forbidden; the microtask still runs before the frame is painted.
        if (this.dispatchScheduled) return;
        this.dispatchScheduled = true;
        queueMicrotask(() => {
          this.dispatchScheduled = false;
          if (this.destroyed) return;
          view.dispatch({ effects: listHangMeasured.of(null) });
        });
      },
    };
  },
  { decorations: (v) => v.decorations },
);

export const listHangingIndent = listHangingIndentPlugin;
