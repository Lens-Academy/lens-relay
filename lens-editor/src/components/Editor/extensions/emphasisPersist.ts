import { ViewPlugin, EditorView, Decoration } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { StateEffect, Transaction } from '@codemirror/state';
import type { EditorState, ChangeDesc } from '@codemirror/state';

interface EmphasisRange {
  from: number;
  to: number;
  cls: string;
}

const clearGhostEmphasis = StateEffect.define<void>();

function scanEmphasis(state: EditorState): EmphasisRange[] {
  const ranges: EmphasisRange[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === 'StrongEmphasis') {
        ranges.push({ from: node.from, to: node.to, cls: 'cm-strong' });
      } else if (node.name === 'Emphasis') {
        ranges.push({ from: node.from, to: node.to, cls: 'cm-emphasis' });
      }
    },
  });
  return ranges;
}

function mapRanges(ranges: EmphasisRange[], changes: ChangeDesc): EmphasisRange[] {
  return ranges
    .map(r => ({
      from: changes.mapPos(r.from),
      to: changes.mapPos(r.to),
      cls: r.cls,
    }))
    .filter(r => r.from < r.to);
}

function isTyping(update: ViewUpdate): boolean {
  return update.transactions.some(tr => {
    const event = tr.annotation(Transaction.userEvent);
    return event !== undefined && (event.startsWith('input') || event.startsWith('delete'));
  });
}

function rangesOverlap(a: EmphasisRange, b: EmphasisRange): boolean {
  return a.cls === b.cls && !(a.to <= b.from || a.from >= b.to);
}

export const emphasisPersistPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    private prevRanges: EmphasisRange[] = [];
    private ghostTimer: ReturnType<typeof setTimeout> | null = null;
    private view: EditorView;

    constructor(view: EditorView) {
      this.view = view;
      this.prevRanges = scanEmphasis(view.state);
    }

    update(update: ViewUpdate) {
      // Handle clearGhostEmphasis effect
      if (update.transactions.some(tr => tr.effects.some(e => e.is(clearGhostEmphasis)))) {
        this.decorations = Decoration.none;
        this.prevRanges = scanEmphasis(update.state);
        return;
      }

      // No doc change — just update prevRanges
      if (!update.docChanged) {
        this.prevRanges = scanEmphasis(update.state);
        return;
      }

      const currentRanges = scanEmphasis(update.state);

      if (isTyping(update)) {
        const mapped = mapRanges(this.prevRanges, update.changes);
        const lost = mapped.filter(m => !currentRanges.some(c => rangesOverlap(m, c)));

        if (lost.length > 0) {
          const sorted = [...lost].sort((a, b) => a.from - b.from || a.to - b.to);
          this.decorations = Decoration.set(
            sorted.map(r => Decoration.mark({ class: r.cls }).range(r.from, r.to))
          );
          this.prevRanges = mapped; // Preserve memory for next keystroke

          // Schedule ghost clearing
          if (this.ghostTimer) clearTimeout(this.ghostTimer);
          this.ghostTimer = setTimeout(() => {
            this.view.dispatch({ effects: clearGhostEmphasis.of(undefined) });
            this.ghostTimer = null;
          }, 400);
        } else {
          if (this.decorations !== Decoration.none) {
            this.decorations = Decoration.none;
          }
          if (this.ghostTimer) {
            clearTimeout(this.ghostTimer);
            this.ghostTimer = null;
          }
          this.prevRanges = currentRanges;
        }
      } else {
        if (this.decorations !== Decoration.none) {
          this.decorations = Decoration.none;
        }
        if (this.ghostTimer) {
          clearTimeout(this.ghostTimer);
          this.ghostTimer = null;
        }
        this.prevRanges = currentRanges;
      }
    }

    destroy() {
      if (this.ghostTimer) clearTimeout(this.ghostTimer);
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);
