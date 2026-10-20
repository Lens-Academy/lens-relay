// src/components/Editor/extensions/criticmarkup.ts
import {
  Facet,
  StateField,
  StateEffect,
  RangeSetBuilder,
  EditorSelection,
  EditorState,
  Compartment,
  Transaction,
} from '@codemirror/state';
import type { ChangeSpec } from '@codemirror/state';
import {
  ViewPlugin,
  Decoration,
  EditorView,
  keymap,
  WidgetType,
} from '@codemirror/view';
import type { ViewUpdate, DecorationSet } from '@codemirror/view';
import {
  criticMarkupKeymap,
  acceptChangeAtCursor,
  rejectChangeAtCursor,
  applyChange,
  removalJoiningSplit,
} from './criticmarkup-commands';
import { parse, parseThreads, isAdjacentEditPair, type CriticMarkupRange } from '../../../lib/criticmarkup-parser';

export interface CriticMarkupCommentBadgeInfo {
  badgeNumber: number;
  isFirstInThread: boolean;
  absoluteFrom: number;
}

/** Facet controlling whether accept/reject buttons are shown. Defaults to true. */
export const canAcceptRejectFacet = Facet.define<boolean, boolean>({
  combine: (values) => values.length > 0 ? values[0] : true,
});

/**
 * Translates a local editor position (inside this CodeMirror view) to the
 * absolute Y.Text offset that CommentsLayer expects. The file editor uses
 * the identity function (its view IS the whole Y.Text). Section editors in
 * the course editor configure this to add their slice's base offset.
 */
export const commentOffsetTranslator = Facet.define<
  (local: number) => number,
  (local: number) => number
>({
  combine: (vals) => vals[0] ?? ((n) => n),
});

/**
 * Callbacks invoked when the user clicks a comment badge in this editor view.
 * Receives the absolute Y.Text offset (already passed through
 * commentOffsetTranslator). Unlike the other facets in this file, this one
 * defines no `combine` — the facet value is the array of all registrations
 * and each one is invoked.
 */
export const commentClickCallback = Facet.define<(absFrom: number) => void>();

// Author context - can be set externally
let currentAuthor = 'anonymous';

/**
 * Set the current author for CriticMarkup metadata.
 * This is used when wrapping edits in suggestion mode.
 */
export function setCurrentAuthor(author: string) {
  currentAuthor = author;
}

/**
 * Get the current author for CriticMarkup metadata.
 */
export function getCurrentAuthor(): string {
  return currentAuthor;
}

// CSS class mapping for each CriticMarkup type
const TYPE_CLASSES: Record<CriticMarkupRange['type'], string> = {
  addition: 'cm-addition',
  deletion: 'cm-deletion',
  substitution: 'cm-substitution',
  comment: 'cm-comment',
  highlight: 'cm-highlight',
};

function typeClass(range: CriticMarkupRange): string {
  return range.type === 'substitution'
    ? `${TYPE_CLASSES[range.type]} cm-criticmarkup-no-strikethrough`
    : TYPE_CLASSES[range.type];
}

// Line-level CSS classes for blank lines within suggestions
const LINE_CLASSES: Partial<Record<CriticMarkupRange['type'], string>> = {
  addition: 'cm-addition-line',
  deletion: 'cm-deletion-line',
};

/**
 * StateEffect to toggle suggestion mode on/off.
 */
export const toggleSuggestionMode = StateEffect.define<boolean>();

export const setCommentBadgeMap = StateEffect.define<Map<number, CriticMarkupCommentBadgeInfo> | null>();

export const commentBadgeMapField = StateField.define<Map<number, CriticMarkupCommentBadgeInfo> | null>({
  create() { return null; },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setCommentBadgeMap)) return e.value;
    }
    return value;
  },
});

// Superscript digit characters for badge numbers
const SUPERSCRIPT_DIGITS = ['\u2070', '\u00B9', '\u00B2', '\u00B3', '\u2074', '\u2075', '\u2076', '\u2077', '\u2078', '\u2079'];

function toSuperscript(n: number): string {
  return String(n).split('').map(d => SUPERSCRIPT_DIGITS[parseInt(d)]).join('');
}

/**
 * Widget that renders a numbered badge for comment threads.
 */
class CommentBadgeWidget extends WidgetType {
  constructor(
    private number: number,
    private threadFrom: number,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-comment-badge';
    span.textContent = String(this.number);
    span.dataset.commentFrom = String(this.threadFrom);
    return span;
  }

  eq(other: CommentBadgeWidget): boolean {
    return this.number === other.number && this.threadFrom === other.threadFrom;
  }

  ignoreEvent(): boolean {
    return false; // Allow click events
  }
}

/**
 * StateField that tracks whether suggestion mode is active.
 * When true, edits are wrapped in CriticMarkup instead of being applied directly.
 */
export const suggestionModeField = StateField.define<boolean>({
  create() {
    return false;
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(toggleSuggestionMode)) {
        return effect.value;
      }
    }
    return value;
  },
});

/**
 * StateField that holds parsed CriticMarkup ranges from the document.
 * Ranges are re-parsed whenever the document changes.
 */
export const criticMarkupField = StateField.define<CriticMarkupRange[]>({
  create(state) {
    return parse(state.doc.toString());
  },
  update(ranges, transaction) {
    if (!transaction.docChanged) return ranges;
    return parse(transaction.state.doc.toString());
  },
});

/**
 * Helper function to check if the editor selection intersects a given range.
 */
function selectionIntersects(
  selection: EditorSelection,
  from: number,
  to: number
): boolean {
  return selection.ranges.some((range) => range.to >= from && range.from <= to);
}

/**
 * Widget that renders a zero-width space to give hidden-syntax-only lines
 * a proper line height so the cursor remains visible.
 */
class CursorAnchorWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.textContent = '\u200B'; // zero-width space
    span.className = 'cm-cursor-anchor';
    return span;
  }

  eq(): boolean {
    return true; // All instances are equivalent
  }
}

/**
 * Widget that renders accept (checkmark) and reject (X) buttons for CriticMarkup.
 * Appears at the end of markup content when cursor is inside.
 *
 * Uses data attributes for range identification - click handlers are
 * attached via event delegation in the ViewPlugin.
 */
class AcceptRejectWidget extends WidgetType {
  constructor(
    readonly rangeFrom: number,
    readonly rangeTo: number,
    readonly merged: boolean = false
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const container = document.createElement('span');
    container.className = 'cm-criticmarkup-buttons';
    container.dataset.rangeFrom = String(this.rangeFrom);
    container.dataset.rangeTo = String(this.rangeTo);
    if (this.merged) container.dataset.merged = '1';

    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'cm-criticmarkup-accept';
    acceptBtn.textContent = '\u2713'; // checkmark
    acceptBtn.title = 'Accept change (Ctrl+Enter)';
    acceptBtn.setAttribute('aria-label', 'Accept change');

    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'cm-criticmarkup-reject';
    rejectBtn.textContent = '\u2717'; // X mark
    rejectBtn.title = 'Reject change (Ctrl+Backspace)';
    rejectBtn.setAttribute('aria-label', 'Reject change');

    container.appendChild(acceptBtn);
    container.appendChild(rejectBtn);

    return container;
  }

  eq(other: AcceptRejectWidget): boolean {
    return this.rangeFrom === other.rangeFrom && this.rangeTo === other.rangeTo && this.merged === other.merged;
  }

  ignoreEvent(): boolean {
    return false; // Allow click events
  }
}

/**
 * Widget that renders accept/reject buttons with a count badge for bulk operations.
 * Shown when a text selection spans multiple CriticMarkup ranges.
 */
class BulkAcceptRejectWidget extends WidgetType {
  constructor(readonly count: number) {
    super();
  }

  toDOM(): HTMLElement {
    const container = document.createElement('span');
    container.className = 'cm-criticmarkup-buttons cm-criticmarkup-bulk';

    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'cm-criticmarkup-accept';
    acceptBtn.textContent = `\u2713 ${this.count}`;
    acceptBtn.title = `Accept ${this.count} changes (Ctrl+Enter)`;
    acceptBtn.setAttribute('aria-label', `Accept ${this.count} changes`);

    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'cm-criticmarkup-reject';
    rejectBtn.textContent = `\u2717 ${this.count}`;
    rejectBtn.title = `Reject ${this.count} changes (Ctrl+Backspace)`;
    rejectBtn.setAttribute('aria-label', `Reject ${this.count} changes`);

    container.appendChild(acceptBtn);
    container.appendChild(rejectBtn);

    return container;
  }

  eq(other: BulkAcceptRejectWidget): boolean {
    return this.count === other.count;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * The change the accept/reject buttons `container` belong to: the range they
 * name, or both ranges of a merged deletion+addition pair. Null for bulk
 * buttons, or when no range matches any more.
 */
function buttonRanges(view: EditorView, container: HTMLElement | null): CriticMarkupRange[] | null {
  if (!container?.dataset.rangeFrom || !container.dataset.rangeTo) return null;
  const from = parseInt(container.dataset.rangeFrom, 10);
  const to = parseInt(container.dataset.rangeTo, 10);
  const ranges = view.state.field(criticMarkupField);
  if (container.dataset.merged) {
    const deletion = ranges.find((r) => r.type === 'deletion' && r.from === from);
    const addition = deletion && ranges.find((r) => isAdjacentEditPair(deletion, r) && r.to === to);
    return deletion && addition ? [deletion, addition] : null;
  }
  const range = ranges.find((r) => r.from === from && r.to === to);
  return range ? [range] : null;
}

/**
 * Runs the accept or reject button that `target` is (in) and returns true, or
 * returns false when it is not one. The buttons act on their own change (with a
 * deletion nested in an addition, or two changes touching, the cursor is in
 * more than one, and each shows its buttons); bulk buttons act on the
 * selection, restoring `savedSelection` first (a selection the button's
 * mousedown would have collapsed). Afterwards the selection collapses to the
 * cursor.
 */
function runButton(view: EditorView, target: HTMLElement, savedSelection: { from: number; to: number } | null): boolean {
  const accept = target.closest('.cm-criticmarkup-accept');
  if (!accept && !target.closest('.cm-criticmarkup-reject')) return false;
  const container = target.closest('.cm-criticmarkup-buttons') as HTMLElement | null;
  const own = savedSelection ? null : buttonRanges(view, container);
  if (own) {
    applyChange(view, own, accept ? 'accept' : 'reject');
  } else {
    if (savedSelection) {
      view.dispatch({ selection: { anchor: savedSelection.from, head: savedSelection.to } });
    }
    if (accept) acceptChangeAtCursor(view);
    else rejectChangeAtCursor(view);
  }
  view.dispatch({ selection: { anchor: view.state.selection.main.head } });
  return true;
}

/**
 * ViewPlugin that applies decorations (CSS classes) to CriticMarkup ranges.
 * Decorations are rebuilt when the document changes, viewport changes, or selection changes.
 * Delimiters and metadata are always hidden; accept/reject buttons shown when cursor is inside.
 */
export const criticMarkupPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    // Saved selection from mousedown, used for bulk accept/reject
    // (clicking a button collapses the selection before the click handler fires)
    private savedSelection: { from: number; to: number } | null = null;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);

      // Capture selection on mousedown before the browser collapses it
      view.contentDOM.addEventListener('mousedown', (e) => {
        const target = e.target as HTMLElement;
        if (target.classList.contains('cm-criticmarkup-accept') ||
            target.classList.contains('cm-criticmarkup-reject')) {
          const sel = view.state.selection.main;
          if (sel.from !== sel.to) {
            this.savedSelection = { from: sel.from, to: sel.to };
          }
          // Keep the selection, collapsed too: the cursor moving to where the
          // click maps (hidden syntax throws that off) could take it out of
          // the change, and the buttons away before the click
          e.preventDefault();
        }
      });

      // Event delegation for accept/reject button clicks and comment badge clicks
      view.contentDOM.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (runButton(view, target, this.savedSelection)) {
          e.preventDefault();
          e.stopPropagation();
          this.savedSelection = null;
        } else if (target.classList.contains('cm-comment-badge')) {
          e.preventDefault();
          e.stopPropagation();
          const absFrom = parseInt(target.dataset.commentFrom ?? '', 10);
          if (!isNaN(absFrom)) {
            view.state.facet(commentClickCallback).forEach((cb) => cb(absFrom));
          }
        }
      });
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet) {
        this.decorations = this.buildDecorations(update.view);
        return;
      }
      for (const tr of update.transactions) {
        for (const e of tr.effects) {
          if (e.is(setCommentBadgeMap)) {
            this.decorations = this.buildDecorations(update.view);
            return;
          }
        }
      }
    }

    buildDecorations(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const ranges = view.state.field(criticMarkupField);
      const selection = view.state.selection;

      // Collect all decorations to sort before adding
      const decorations: Array<{ from: number; to: number; deco: Decoration }> = [];
      // Line decorations are added separately (must not be mixed into mark sort)
      const lineDecos: Array<{ from: number; deco: Decoration }> = [];

      // Build comment thread info for badge numbering. Section editors can
      // provide a badge map sliced from the full document, so an open field
      // keeps the same comment numbers as the course comments sidebar.
      const threads = parseThreads(ranges);
      // Map each comment range's `from` to its badge info
      const commentBadgeMap = new Map<number, { badgeNumber: number; isFirst: boolean; threadFrom: number }>();
      // Translator from local CM positions to absolute Y.Text offsets.
      const translateOffset = view.state.facet(commentOffsetTranslator);
      const suppliedBadgeMap = view.state.field(commentBadgeMapField);
      if (suppliedBadgeMap) {
        for (const range of ranges) {
          if (range.type !== 'comment') continue;
          const supplied = suppliedBadgeMap.get(range.from);
          if (!supplied) continue;
          commentBadgeMap.set(range.from, {
            badgeNumber: supplied.badgeNumber,
            isFirst: supplied.isFirstInThread,
            threadFrom: range.from,
          });
        }
      } else {
        for (let ti = 0; ti < threads.length; ti++) {
          const thread = threads[ti];
          for (let ci = 0; ci < thread.comments.length; ci++) {
            commentBadgeMap.set(thread.comments[ci].from, {
              badgeNumber: ti + 1,
              isFirst: ci === 0,
              threadFrom: thread.from,
            });
          }
        }
      }

      // Detect bulk selection: if selection spans multiple markup ranges,
      // show a single bulk widget instead of per-range accept/reject buttons
      const sel = selection.main;
      const bulkRanges = sel.from !== sel.to
        ? ranges.filter(r => r.from < sel.to && r.to > sel.from)
        : [];
      const isBulkSelection = bulkRanges.length > 1;
      const canAcceptReject = view.state.facet(canAcceptRejectFacet);

      if (isBulkSelection && canAcceptReject) {
        decorations.push({
          from: sel.to,
          to: sel.to,
          deco: Decoration.widget({
            widget: new BulkAcceptRejectWidget(bulkRanges.length),
            side: 1,
          }),
        });
      }

      // Pre-compute adjacent deletion+addition pairs for merged accept/reject buttons.
      // When a deletion ends exactly where an addition begins, they form a logical
      // substitution that should have a single button covering both ranges.
      const adjacentPairEnd = new Set<number>();   // indices of additions that are part of a pair
      const adjacentPairStart = new Set<number>(); // indices of deletions that are part of a pair
      for (let i = 0; i < ranges.length - 1; i++) {
        if (isAdjacentEditPair(ranges[i], ranges[i + 1])) {
          adjacentPairStart.add(i);
          adjacentPairEnd.add(i + 1);
        }
      }

      for (let ri = 0; ri < ranges.length; ri++) {
        const range = ranges[ri];
        const className = typeClass(range);
        const cursorInside = selectionIntersects(selection, range.from, range.to);

        // Comments: hide all text, show badge widget for first in thread
        if (range.type === 'comment') {
          const badgeInfo = commentBadgeMap.get(range.from);
          const spansLineBreak = view.state.doc.lineAt(range.from).number !== view.state.doc.lineAt(range.to).number;

          if (spansLineBreak) {
            // Multiline comments can't use Decoration.replace (CM6 plugin limitation).
            // Hide all text with cm-hidden-syntax marks and place badge widget at start.
            decorations.push({
              from: range.from,
              to: range.to,
              deco: Decoration.mark({ class: 'cm-hidden-syntax' }),
            });
            if (badgeInfo?.isFirst) {
              decorations.push({
                from: range.from,
                to: range.from,
                deco: Decoration.widget({
                  widget: new CommentBadgeWidget(badgeInfo.badgeNumber, translateOffset(badgeInfo.threadFrom)),
                  side: -1,
                }),
              });
            }

            // Collapse intermediate ghost lines (lines entirely within hidden comment range)
            const doc = view.state.doc;
            const startLine = doc.lineAt(range.from).number;
            const endLine = doc.lineAt(range.to).number;
            for (let ln = startLine; ln <= endLine; ln++) {
              const line = doc.line(ln);
              const lineFullyHidden = line.from >= range.from && line.to <= range.to;
              if (lineFullyHidden) {
                lineDecos.push({
                  from: line.from,
                  deco: Decoration.line({ class: 'cm-comment-collapsed-line' }),
                });
              }
            }
          } else if (badgeInfo?.isFirst) {
            // First comment in thread (single line): replace entire range with badge
            decorations.push({
              from: range.from,
              to: range.to,
              deco: Decoration.replace({
                widget: new CommentBadgeWidget(badgeInfo.badgeNumber, translateOffset(badgeInfo.threadFrom)),
              }),
            });
          } else {
            // Non-first comment in thread (single line): hide entirely
            decorations.push({
              from: range.from,
              to: range.to,
              deco: Decoration.replace({}),
            });
          }
          continue;
        }

        // Non-comment ranges: standard three-decoration pattern
        // Always hide delimiters and metadata, only show colored content
        // Opening delimiter + metadata (everything before content)
        decorations.push({
          from: range.from,
          to: range.contentFrom,
          deco: Decoration.mark({ class: 'cm-hidden-syntax' }),
        });

        // Content (between delimiters)
        decorations.push({
          from: range.contentFrom,
          to: range.contentTo,
          deco: Decoration.mark({ class: className }),
        });

        // Closing delimiter
        decorations.push({
          from: range.contentTo,
          to: range.to,
          deco: Decoration.mark({ class: 'cm-hidden-syntax' }),
        });

        // Add colored left border on lines within additions/deletions that have
        // no visible content (blank lines, or lines where all text is hidden syntax)
        const lineClass = LINE_CLASSES[range.type];
        if (lineClass) {
          const doc = view.state.doc;
          // Iterate ALL lines in the markup range (including delimiter lines)
          const startLine = doc.lineAt(range.from).number;
          const endLine = doc.lineAt(range.to).number;
          for (let ln = startLine; ln <= endLine; ln++) {
            const line = doc.line(ln);
            // Check if this line has any visible suggestion content
            const visibleFrom = Math.max(line.from, range.contentFrom);
            const visibleTo = Math.min(line.to, range.contentTo);
            if (visibleFrom >= visibleTo || doc.sliceString(visibleFrom, visibleTo).trim() === '') {
              lineDecos.push({
                from: line.from,
                deco: Decoration.line({ class: lineClass }),
              });
            }
          }
        }

        // When cursor is inside, show accept/reject buttons and ensure cursor visibility
        // Skip per-range buttons when bulk widget is shown or accept/reject is disabled
        if (cursorInside && !isBulkSelection && canAcceptReject) {
          // Adjacent deletion+addition pairs: show a single merged button.
          // The deletion (pair start) suppresses its button; the addition (pair end)
          // shows a button spanning both ranges. If cursor is in the deletion,
          // we also need to show the merged button on the addition.
          const isPairStart = adjacentPairStart.has(ri);
          const isPairEnd = adjacentPairEnd.has(ri);

          if (!isPairStart) {
            // Normal range or pair-end addition: show button here
            const widgetFrom = isPairEnd ? ranges[ri - 1].from : range.from;
            decorations.push({
              from: range.contentTo,
              to: range.contentTo,
              deco: Decoration.widget({
                widget: new AcceptRejectWidget(widgetFrom, range.to, isPairEnd),
                side: 1, // After the content
              }),
            });
          } else {
            // Pair-start deletion with cursor inside: show merged button at the
            // end of the paired addition (next range)
            const pairedAddition = ranges[ri + 1];
            decorations.push({
              from: pairedAddition.contentTo,
              to: pairedAddition.contentTo,
              deco: Decoration.widget({
                widget: new AcceptRejectWidget(range.from, pairedAddition.to, true),
                side: 1,
              }),
            });
          }

          // If cursor is on a line where all text is hidden syntax (delimiter lines),
          // add a zero-width space widget so the cursor has proper height
          const cursorHead = view.state.selection.main.head;
          const cursorLine = view.state.doc.lineAt(cursorHead);
          const visFrom = Math.max(cursorLine.from, range.contentFrom);
          const visTo = Math.min(cursorLine.to, range.contentTo);
          const lineIsAllHidden = visFrom >= visTo || view.state.doc.sliceString(visFrom, visTo).trim() === '';
          if (lineIsAllHidden && cursorHead >= range.from && cursorHead <= range.to) {
            decorations.push({
              from: cursorHead,
              to: cursorHead,
              deco: Decoration.widget({
                widget: new CursorAnchorWidget(),
                side: 0,
              }),
            });
          }
        }
      }

      // Merge line decorations into the main array
      for (const ld of lineDecos) {
        decorations.push({ from: ld.from, to: ld.from, deco: ld.deco });
      }

      // Sort by position and startSide (required for RangeSetBuilder)
      // Line decos have startSide -200, marks -1, widgets vary
      decorations.sort((a, b) => {
        if (a.from !== b.from) return a.from - b.from;
        const aSide = (a.deco as any).startSide ?? 0;
        const bSide = (b.deco as any).startSide ?? 0;
        if (aSide !== bSide) return aSide - bSide;
        return a.to - b.to;
      });

      for (const d of decorations) {
        builder.add(d.from, d.to, d.deco);
      }

      return builder.finish();
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

/**
 * ViewPlugin for source mode - applies color classes to entire CriticMarkup ranges
 * without hiding any syntax. Shows raw markup with color coding.
 * Accept/reject buttons appear when cursor is inside a range.
 */
export const criticMarkupSourcePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private savedSelection: { from: number; to: number } | null = null;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);

      // Capture selection on mousedown before the browser collapses it
      view.contentDOM.addEventListener('mousedown', (e) => {
        const target = e.target as HTMLElement;
        if (target.classList.contains('cm-criticmarkup-accept') ||
            target.classList.contains('cm-criticmarkup-reject')) {
          const sel = view.state.selection.main;
          if (sel.from !== sel.to) {
            this.savedSelection = { from: sel.from, to: sel.to };
          }
          // Keep the selection (see criticMarkupPlugin)
          e.preventDefault();
        }
      });

      // Event delegation for accept/reject button clicks
      view.contentDOM.addEventListener('click', (e) => {
        if (runButton(view, e.target as HTMLElement, this.savedSelection)) {
          e.preventDefault();
          e.stopPropagation();
          this.savedSelection = null;
        }
      });
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const ranges = view.state.field(criticMarkupField);
      const selection = view.state.selection;

      const decorations: Array<{ from: number; to: number; deco: Decoration }> = [];

      // Detect bulk selection
      const sel = selection.main;
      const bulkRanges = sel.from !== sel.to
        ? ranges.filter(r => r.from < sel.to && r.to > sel.from)
        : [];
      const isBulkSelection = bulkRanges.length > 1;
      const canAcceptReject = view.state.facet(canAcceptRejectFacet);

      if (isBulkSelection && canAcceptReject) {
        decorations.push({
          from: sel.to,
          to: sel.to,
          deco: Decoration.widget({
            widget: new BulkAcceptRejectWidget(bulkRanges.length),
            side: 1,
          }),
        });
      }

      for (const range of ranges) {
        // Only decorate the content, not the delimiters/metadata
        decorations.push({
          from: range.contentFrom,
          to: range.contentTo,
          deco: Decoration.mark({ class: typeClass(range) }),
        });

        if (selectionIntersects(selection, range.from, range.to) && !isBulkSelection && canAcceptReject) {
          decorations.push({
            from: range.contentTo,
            to: range.contentTo,
            deco: Decoration.widget({
              widget: new AcceptRejectWidget(range.from, range.to),
              side: 1,
            }),
          });
        }
      }

      decorations.sort((a, b) => {
        if (a.from !== b.from) return a.from - b.from;
        if (a.to !== b.to) return a.to - b.to;
        const aIsWidget = a.from === a.to;
        const bIsWidget = b.from === b.to;
        if (aIsWidget !== bIsWidget) return aIsWidget ? 1 : -1;
        return 0;
      });

      for (const d of decorations) {
        builder.add(d.from, d.to, d.deco);
      }

      return builder.finish();
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

type ButtonsWidget = AcceptRejectWidget | BulkAcceptRejectWidget;
type StickyPlacement = { widget: ButtonsWidget; left: number; top: number; covered: number } | null;

function sameWidget(a: ButtonsWidget | null, b: ButtonsWidget) {
  return a !== null && a.constructor === b.constructor && a.eq(b as never);
}

/**
 * Keeps the accept/reject buttons reachable when their place is off screen.
 *
 * The buttons sit at the end of the change (or of the selection, for bulk).
 * When the change starts on screen but its end is below the visible part of
 * the editor (Ctrl+A, a suggestion taller than the screen), this shows a
 * floating copy of the same buttons at the bottom of the visible area: in the
 * empty margin right of the text when there is room for it (desktop), else
 * over the bottom right of the text, moved up out of the cursor's way, with a
 * scroll margin so typing never lands under it.
 */
const stickyButtonsPlugin = ViewPlugin.fromClass(
  class {
    readonly dom: HTMLElement;
    /** The widget shown in the text, from the decorations plugin. */
    private active: { widget: ButtonsWidget; pos: number; start: number } | null = null;
    /** The widget whose copy is in `dom`. */
    private widget: ButtonsWidget | null = null;
    /** Height to keep clear at the bottom while the floating buttons cover text. */
    coveredHeight = 0;
    private readonly schedule = () => this.view.requestMeasure({
      key: this,
      read: (view) => this.measure(view),
      write: (pos) => this.place(pos),
    });
    /** Scrolling only matters while a change is selected. */
    private readonly onScroll = () => {
      if (this.active) this.schedule();
    };

    constructor(readonly view: EditorView) {
      this.dom = document.createElement('div');
      this.dom.className = 'cm-criticmarkup-sticky';
      this.dom.style.visibility = 'hidden';
      // Keep the selection and focus: bulk accept needs the selection intact.
      this.dom.addEventListener('mousedown', (e) => e.preventDefault());
      this.dom.addEventListener('click', (e) => this.click(e));
      view.dom.appendChild(this.dom);
      this.active = this.activeWidget(view);
      window.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
      window.addEventListener('resize', this.onScroll);
      window.visualViewport?.addEventListener('resize', this.onScroll);
      window.visualViewport?.addEventListener('scroll', this.onScroll);
      this.schedule();
    }

    update(update: ViewUpdate) {
      this.active = this.activeWidget(update.view);
      this.schedule();
    }

    destroy() {
      this.dom.remove();
      window.removeEventListener('scroll', this.onScroll, { capture: true });
      window.removeEventListener('resize', this.onScroll);
      window.visualViewport?.removeEventListener('resize', this.onScroll);
      window.visualViewport?.removeEventListener('scroll', this.onScroll);
    }

    /** The accept/reject widget currently shown in the text, and where. */
    private activeWidget(view: EditorView) {
      const plugin = view.plugin(criticMarkupPlugin) ?? view.plugin(criticMarkupSourcePlugin);
      if (!plugin) return null;
      let found: { widget: ButtonsWidget; pos: number; start: number } | null = null;
      plugin.decorations.between(0, view.state.doc.length, (from, _to, deco) => {
        const widget = deco.spec.widget;
        if (widget instanceof BulkAcceptRejectWidget) {
          found = { widget, pos: from, start: view.state.selection.main.from };
          return false;
        }
        if (widget instanceof AcceptRejectWidget) {
          // With several cursors, follow the change at the main one: that is
          // the one accept/reject acts on.
          const head = view.state.selection.main.head;
          const atHead = widget.rangeFrom <= head && head <= widget.rangeTo;
          if (!found || atHead) found = { widget, pos: from, start: widget.rangeFrom };
          if (atHead) return false;
        }
      });
      return found as { widget: ButtonsWidget; pos: number; start: number } | null;
    }

    /** Screen top and bottom of a document position, rendered or not. */
    private screenY(view: EditorView, pos: number) {
      const coords = view.coordsAtPos(pos);
      if (coords) return { top: coords.top, bottom: coords.bottom };
      const block = view.lineBlockAt(pos);
      return { top: view.documentTop + block.top, bottom: view.documentTop + block.bottom };
    }

    /** The part of the editor that is actually on screen. */
    private visibleRect(view: EditorView) {
      const r = view.dom.getBoundingClientRect();
      let top = r.top, bottom = r.bottom;
      for (let el: HTMLElement | null = view.scrollDOM; el && el !== document.body; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (style.overflowY === 'visible' && style.overflowX === 'visible') continue;
        const er = el.getBoundingClientRect();
        top = Math.max(top, er.top);
        bottom = Math.min(bottom, er.bottom);
      }
      const vv = window.visualViewport;
      top = Math.max(top, vv ? vv.offsetTop : 0);
      bottom = Math.min(bottom, vv ? vv.offsetTop + vv.height : window.innerHeight);
      return { top, bottom };
    }

    /**
     * The bottom of the visible area at column x, above anything floating
     * over the editor there (the phone toolbar is fixed over its bottom).
     */
    private uncoveredBottom(view: EditorView, x: number, vis: { top: number; bottom: number }) {
      for (let y = vis.bottom - 1; y > vis.top + 40; y -= 4) {
        const hit = document.elementFromPoint(x, y);
        if (!hit || view.dom.contains(hit)) return y + 1;
      }
      return vis.bottom;
    }

    private measure(view: EditorView): StickyPlacement {
      const active = this.active;
      if (!active) return null;
      const vis = this.visibleRect(view);
      const end = this.screenY(view, active.pos);
      const start = this.screenY(view, active.start);
      // Only when the change runs off the bottom: its end is below the visible
      // area while its start is above that edge (on screen or scrolled past).
      if (end.bottom <= vis.bottom || start.top >= vis.bottom || vis.bottom - vis.top < 80) return null;

      const editor = view.dom.getBoundingClientRect();
      const content = view.contentDOM.getBoundingClientRect();
      const textRight = content.right - parseFloat(getComputedStyle(view.contentDOM).paddingRight);
      const width = sameWidget(this.widget, active.widget) ? this.dom.offsetWidth : 0;
      const height = this.dom.offsetHeight || 32;
      const gap = 8;
      const inMargin = width > 0 && editor.right - textRight >= width + 2 * gap;
      let left = inMargin ? textRight + gap : Math.min(textRight, editor.right - gap) - width;
      left = Math.max(left, editor.left + gap);
      let top = this.uncoveredBottom(view, left + width / 2, vis) - height - gap;
      if (!inMargin) {
        // Over the text: never cover the cursor.
        const head = view.coordsAtPos(view.state.selection.main.head);
        if (head && head.bottom > top && head.top < top + height && head.right > left && head.left < left + width) {
          top = head.top - height - gap / 2;
        }
      }
      return {
        widget: active.widget,
        left: left - editor.left,
        top: top - editor.top,
        covered: inMargin ? 0 : height + 2 * gap,
      };
    }

    private place(pos: StickyPlacement) {
      if (!pos) {
        this.dom.style.visibility = 'hidden';
        this.coveredHeight = 0;
        return;
      }
      if (!sameWidget(this.widget, pos.widget)) {
        this.widget = pos.widget;
        this.dom.replaceChildren(pos.widget.toDOM());
        // Width changed: measure again before showing it in the right place.
        this.dom.style.visibility = 'hidden';
        this.schedule();
        return;
      }
      this.dom.style.left = `${pos.left}px`;
      this.dom.style.top = `${pos.top}px`;
      this.dom.style.visibility = 'visible';
      this.coveredHeight = pos.covered;
    }

    private click(e: MouseEvent) {
      // mousedown is prevented, so the selection is still the one to act on.
      if (runButton(this.view, e.target as HTMLElement, null)) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
  },
  {
    provide: (plugin) => EditorView.scrollMargins.of((view) => {
      const covered = view.plugin(plugin)?.coveredHeight ?? 0;
      return covered ? { bottom: covered } : null;
    }),
  }
);

/**
 * The change that adds `text` at `pos` as the current author's addition (with
 * metadata `meta`), and the cursor after the text.
 *
 * It never goes inside another pending addition: the parsers (this one, the
 * relay's and the review page's) end an addition at the first `++}`, so a
 * nested addition cut the outer one short and showed the rest as raw markup.
 * Into an addition of your own, or just after one, the text just goes in.
 * Another author's is split around yours instead: their part, yours, their
 * part, each part keeping its author and time. At the start or end of their
 * text yours goes just before or after theirs (into an addition of yours
 * already there), and before the deletion of a deletion+addition pair, which
 * must stay together. Inside a change nested in their addition (a deletion of
 * part of it), yours goes where that change starts.
 */
function placeAddition(
  state: EditorState,
  ranges: readonly CriticMarkupRange[],
  pos: number,
  text: string,
  meta: string,
): { change: { from: number; insert: string }; cursor: number } {
  const wrapped = `{++${meta}@@${text}++}`;
  const around = ranges.find((r) => r.type === 'addition' && r.from < pos && pos < r.to);
  if (!around) {
    const yours = ranges.find((r) => r.type === 'addition' && r.metadata?.author === currentAuthor && r.to === pos);
    if (yours) return { change: { from: yours.contentTo, insert: text }, cursor: yours.contentTo + text.length };
    return { change: { from: pos, insert: wrapped }, cursor: pos + wrapped.length - 3 };
  }
  if (around.metadata?.author === currentAuthor) {
    const into = Math.min(Math.max(pos, around.contentFrom), around.contentTo);
    return { change: { from: into, insert: text }, cursor: into + text.length };
  }

  const theirs = around;
  const nested = ranges.find(
    (r) => r !== theirs && r.from >= theirs.contentFrom && r.to <= theirs.contentTo && r.from < pos && pos < r.to,
  );
  if (nested) pos = nested.from;

  if (pos > theirs.contentFrom && pos < theirs.contentTo) {
    const reopen = state.doc.sliceString(theirs.from, theirs.contentFrom);
    return { change: { from: pos, insert: `++}${wrapped}${reopen}` }, cursor: pos + wrapped.length };
  }
  const before = pos <= theirs.contentFrom;
  const at = before ? (ranges.find((r) => isAdjacentEditPair(r, theirs))?.from ?? theirs.from) : theirs.to;
  const mine = ranges.find(
    (r) => r.type === 'addition' && r.metadata?.author === currentAuthor && (before ? r.to : r.from) === at,
  );
  if (mine) {
    const into = before ? mine.contentTo : mine.contentFrom;
    return { change: { from: into, insert: text }, cursor: into + text.length };
  }
  return { change: { from: at, insert: wrapped }, cursor: at + wrapped.length - 3 };
}

/** Where a substitution's `~>` starts */
function arrowOf(sub: CriticMarkupRange): number {
  return sub.contentFrom + (sub.oldContent?.length ?? 0);
}

/** Whether `from`-`to` is in a substitution's old text or in its new text, not across its `~>` */
function inSubstitutionText(sub: CriticMarkupRange, from: number, to: number): boolean {
  const arrow = arrowOf(sub);
  return (from >= sub.contentFrom && to <= arrow) || (from >= arrow + 2 && to <= sub.contentTo);
}

/**
 * Whether the character at `pos` is markup of a suggestion or comment: a
 * delimiter, metadata, a substitution's `~>`, or any of a comment (shown as a
 * badge). Taking it into a deletion breaks that suggestion.
 */
function isMarkupAt(ranges: readonly CriticMarkupRange[], pos: number): boolean {
  return ranges.some((r) => {
    if (pos < r.from || pos >= r.to) return false;
    if (r.type === 'comment' || pos < r.contentFrom || pos >= r.contentTo) return true;
    return r.type === 'substitution' && pos >= arrowOf(r) && pos < arrowOf(r) + 2;
  });
}

/**
 * Transaction filter that wraps insertions in CriticMarkup when suggestion mode is ON.
 * Insertions are wrapped in {++metadata@@content++} format.
 *
 * Continuous typing optimization: If cursor is inside an existing addition by the same
 * author, let the edit through without wrapping to avoid per-character markup.
 * Inside another author's addition, see placeAddition.
 *
 * The text of another author's deletion is already suggested for deletion:
 * Backspace or Delete there changes nothing but moves the cursor over it, and
 * what you type there (over a selection, too) goes just before their deletion,
 * as inside one of yours. A replacement inside a substitution is written as a
 * deletion+addition pair, the same change in markup that can sit inside a
 * substitution. Nesting the same kind of suggestion, at any depth, broke the
 * outer one: the parsers (this one, the relay's and the review page's) end it
 * at the first closing delimiter. Backspace or Delete on a substitution's `~>`
 * moves the cursor over it too.
 */
const suggestionModeFilter = EditorState.transactionFilter.of((tr: Transaction) => {
  // Only process document changes
  if (!tr.docChanged) return tr;

  // Only wrap when suggestion mode is ON
  if (!tr.startState.field(suggestionModeField)) return tr;

  // Only wrap user-initiated edits (typing, paste, delete).
  // Remote sync (y-codemirror.next) and programmatic dispatches don't set userEvent.
  if (!tr.annotation(Transaction.userEvent)) return tr;

  const cursorPos = tr.startState.selection.main.head;
  const ranges = tr.startState.field(criticMarkupField);

  // Check if cursor is inside an existing addition by the same author
  const ownAddition = ranges.find(
    (r) =>
      r.type === 'addition' &&
      r.metadata?.author === currentAuthor &&
      cursorPos > r.from &&
      cursorPos < r.to
  );

  // If inside own addition, let the edit through — unless it empties the content
  // or escapes the content boundaries (e.g. backspace at left edge)
  if (ownAddition) {
    let wouldEmpty = false;
    let escapesLeft = false;
    let escapesRight = false;
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      const added = inserted.toString();
      if (fromA < ownAddition.contentFrom) {
        escapesLeft = true;
        return;
      }
      if (toA > ownAddition.contentTo) {
        escapesRight = true;
        return;
      }
      if (!added) {
        const contentBefore = tr.startState.doc.sliceString(ownAddition.contentFrom, fromA);
        const contentAfter = tr.startState.doc.sliceString(toA, ownAddition.contentTo);
        if (!contentBefore && !contentAfter) {
          wouldEmpty = true;
        }
      }
    });

    if (wouldEmpty) {
      // If it split someone else's addition, that one's parts join up again
      const join = removalJoiningSplit(tr.startState, ownAddition);
      return {
        changes: [join ?? { from: ownAddition.from, to: ownAddition.to, insert: '' }],
        selection: EditorSelection.cursor(join ? join.from : ownAddition.from),
        effects: tr.effects,
      };
    }

    // Beyond the wrapper may be another change's hidden markup (the parts of
    // someone else's addition that this one was typed into): leave it, rather
    // than wrap a delimiter character in a deletion
    if ((escapesLeft && ranges.some((r) => r.to === ownAddition.from))
      || (escapesRight && ranges.some((r) => r.from === ownAddition.to))) {
      return { effects: tr.effects };
    }

    if (escapesLeft && ownAddition.from > 0) {
      // Backspace at left edge of content: create deletion for char before the wrapper
      const timestamp = Date.now();
      const meta = JSON.stringify({ author: currentAuthor, timestamp });
      const charBefore = tr.startState.doc.sliceString(ownAddition.from - 1, ownAddition.from);
      const delInsert = `{--${meta}@@${charBefore}--}`;
      return {
        changes: [{ from: ownAddition.from - 1, to: ownAddition.from, insert: delInsert }],
        selection: EditorSelection.cursor(ownAddition.from - 1),
        effects: tr.effects,
      };
    }

    if (escapesRight && ownAddition.to < tr.startState.doc.length) {
      // Forward-delete at right edge: create deletion for char after the wrapper
      const timestamp = Date.now();
      const meta = JSON.stringify({ author: currentAuthor, timestamp });
      const charAfter = tr.startState.doc.sliceString(ownAddition.to, ownAddition.to + 1);
      const delInsert = `{--${meta}@@${charAfter}--}`;
      return {
        changes: [{ from: ownAddition.to, to: ownAddition.to + 1, insert: delInsert }],
        selection: EditorSelection.cursor(ownAddition.to + delInsert.length),
        effects: tr.effects,
      };
    }

    return tr;
  }

  // Keep subsequent typing in the replacement half of a substitution. The
  // first replacement transaction positions the cursor immediately before
  // the closing delimiter, which is also the end of `newContent`.
  const ownSubstitutions = ranges.filter(
    (r) => r.type === 'substitution' && r.metadata?.author === currentAuthor
  );

  for (const ownSubstitution of ownSubstitutions) {
    const newContentFrom = ownSubstitution.contentTo - (ownSubstitution.newContent?.length ?? 0);
    let changesStayInNewContent = true;
    let newContentLength = ownSubstitution.newContent?.length ?? 0;
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      if (fromA < newContentFrom || toA > ownSubstitution.contentTo) {
        changesStayInNewContent = false;
      }
      newContentLength += inserted.length - (toA - fromA);
    });
    if (!changesStayInNewContent) continue;

    if (newContentLength === 0) {
      const metadataPrefix = tr.startState.doc.sliceString(
        ownSubstitution.from + 3,
        ownSubstitution.contentFrom,
      );
      const deletion = `{--${metadataPrefix}${ownSubstitution.oldContent ?? ''}--}`;
      return {
        changes: { from: ownSubstitution.from, to: ownSubstitution.to, insert: deletion },
        selection: EditorSelection.cursor(ownSubstitution.from),
        effects: tr.effects,
      };
    }

    return tr;
  }

  // Check if cursor is inside an existing deletion by the same author
  const ownDeletion = ranges.find(
    (r) =>
      r.type === 'deletion' &&
      r.metadata?.author === currentAuthor &&
      cursorPos > r.from &&
      cursorPos < r.to
  );

  if (ownDeletion) {
    // Intercept edits inside own deletion to extend it
    const extChanges: ChangeSpec[] = [];
    let extCursorPos: number | undefined;

    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      const deleted = tr.startState.doc.sliceString(fromA, toA);
      const added = inserted.toString();

      if (deleted && !added) {
        const isForwardDelete = fromA >= cursorPos;
        // What Backspace takes from before the block (Delete: after it): up to
        // the document's edge, and never another suggestion's markup (the
        // `--}` of a deletion just before this one), which that would break
        const room = isForwardDelete ? tr.startState.doc.length - ownDeletion.to : ownDeletion.from;
        let grabLen = 0;
        while (grabLen < Math.min(toA - fromA, room)
          && !isMarkupAt(ranges, isForwardDelete ? ownDeletion.to + grabLen : ownDeletion.from - 1 - grabLen)) {
          grabLen++;
        }

        if (grabLen === 0) {
          // Nothing to take: the cursor goes to that edge of your deleted
          // text, from where the next Backspace or Delete reaches past it
          extCursorPos = isForwardDelete ? ownDeletion.contentTo : ownDeletion.contentFrom;
        } else if (!isForwardDelete) {
          // Backspace: grab text from before the block and prepend to content
          const grabbed = tr.startState.doc.sliceString(
            ownDeletion.from - grabLen,
            ownDeletion.from
          );
          extChanges.push({ from: ownDeletion.from - grabLen, to: ownDeletion.from, insert: '' });
          extChanges.push({
            from: ownDeletion.contentFrom,
            to: ownDeletion.contentFrom,
            insert: grabbed,
          });
          extCursorPos = ownDeletion.contentFrom - grabLen;
        } else {
          // Forward delete: grab text from after the block and append to content
          const grabbed = tr.startState.doc.sliceString(
            ownDeletion.to,
            ownDeletion.to + grabLen
          );
          extChanges.push({
            from: ownDeletion.contentTo,
            to: ownDeletion.contentTo,
            insert: grabbed,
          });
          extChanges.push({ from: ownDeletion.to, to: ownDeletion.to + grabLen, insert: '' });
          // Cursor to the RIGHT of the appended char
          extCursorPos = ownDeletion.contentTo + grabLen;
        }
      } else if (added && !deleted) {
        // Typing inside deletion: create addition before the deletion block
        const ts = Date.now();
        const addMeta = JSON.stringify({ author: currentAuthor, timestamp: ts });
        const placed = placeAddition(tr.startState, ranges, ownDeletion.from, added, addMeta);
        extChanges.push(placed.change);
        extCursorPos = placed.cursor;
      }
    });

    if (extChanges.length > 0 || extCursorPos !== undefined) {
      return {
        changes: extChanges,
        selection: extCursorPos !== undefined
          ? EditorSelection.cursor(extCursorPos)
          : tr.selection,
        effects: tr.effects,
      };
    }
    // Fall through for unhandled cases
  }

  const timestamp = Date.now();
  const meta = JSON.stringify({ author: currentAuthor, timestamp });

  const newChanges: ChangeSpec[] = [];
  let newCursorPos: number | undefined;
  // Where the cursor goes if all the edit deletes is someone else's deleted
  // text (or a substitution's `~>`)
  let movedOver: number | undefined;

  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const deleted = tr.startState.doc.sliceString(fromA, toA);
    const added = inserted.toString();
    // The suggestions (and comments) the edit is inside of, outermost first
    const around = ranges.filter((r) => r.from < fromA && toA < r.to);
    const deletion = around.find((r) => r.type === 'deletion');
    const substitutions = around.filter((r) => r.type === 'substitution');

    if (deletion && (!deleted || (fromA >= deletion.contentFrom && toA <= deletion.contentTo))) {
      // In a pending deletion (one of yours with the cursor in it went to the
      // branch above, unless this replaces text): what this deletes there is
      // already suggested for deletion, and what it adds goes just before the
      // deletion (inside, accepting the deletion would drop it)
      if (added) {
        const placed = placeAddition(tr.startState, ranges, deletion.from, added, meta);
        newChanges.push(placed.change);
        newCursorPos = placed.cursor;
      } else {
        movedOver = cursorPos <= fromA ? toA : fromA;
      }
    } else if (!added && substitutions.some((s) => fromA >= arrowOf(s) && toA <= arrowOf(s) + 2)) {
      // The `~>` between a substitution's old and new text, which taking out
      // would break it: the cursor moves over it too
      movedOver = cursorPos <= fromA ? toA : fromA;
    } else if (deleted && added && substitutions.length > 0 && substitutions.every((s) => inSubstitutionText(s, fromA, toA))) {
      // Replacement in a substitution -> a deletion there and an addition just
      // after it, a deletion+addition pair (a substitution would end the outer
      // one at its own `~~}`). placeAddition places the addition, so it never
      // goes inside an addition around it either
      const deletionText = `{--${meta}@@${deleted}--}`;
      const placed = placeAddition(tr.startState, ranges, toA, added, meta);
      newChanges.push({ from: fromA, to: toA, insert: deletionText }, placed.change);
      // The cursor in the new text, where further typing goes
      newCursorPos = placed.cursor + (placed.change.from >= toA ? deletionText.length - deleted.length : 0);
    } else if (deleted && added) {
      // Replacement -> substitution
      const replacement = `{~~${meta}@@${deleted}~>${added}~~}`;
      newChanges.push({
        from: fromA,
        to: toA,
        insert: replacement,
      });
      // Keep the cursor in the visible replacement text so the next input
      // extends this substitution instead of creating an adjacent addition.
      newCursorPos = fromA + replacement.length - 3;
    } else if (deleted) {
      // Check for adjacent own deletion to extend (sequential backspace)
      const adjacentAfter = ranges.find(
        (r) =>
          r.type === 'deletion' &&
          r.metadata?.author === currentAuthor &&
          toA === r.from
      );

      if (adjacentAfter) {
        // Extend existing deletion by prepending deleted text
        newChanges.push({ from: fromA, to: toA, insert: '' });
        newChanges.push({
          from: adjacentAfter.contentFrom,
          to: adjacentAfter.contentFrom,
          insert: deleted,
        });
        // Cursor inside content (contentFrom shifted left by deleted chars)
        newCursorPos = adjacentAfter.contentFrom - deleted.length;
      } else {
        // Check for adjacent own deletion before (sequential forward-delete)
        const adjacentBefore = ranges.find(
          (r) =>
            r.type === 'deletion' &&
            r.metadata?.author === currentAuthor &&
            fromA === r.to
        );

        if (adjacentBefore) {
          // Extend existing deletion by appending deleted text
          newChanges.push({
            from: adjacentBefore.contentTo,
            to: adjacentBefore.contentTo,
            insert: deleted,
          });
          newChanges.push({ from: fromA, to: toA, insert: '' });
          // Cursor to the RIGHT of the appended char
          newCursorPos = adjacentBefore.contentTo + deleted.length;
        } else {
          // New deletion wrapper
          const delInsert = `{--${meta}@@${deleted}--}`;
          newChanges.push({
            from: fromA,
            to: toA,
            insert: delInsert,
          });
          // Position cursor inside the deletion content
          const contentStart = fromA + delInsert.indexOf('@@') + 2;
          const isForwardDel = cursorPos <= fromA;
          newCursorPos = isForwardDel
            ? contentStart + deleted.length  // RIGHT of deleted text
            : contentStart;                  // LEFT of deleted text
        }
      }
    } else if (added) {
      // Pure insertion, with the cursor after it (inside the addition content)
      const placed = placeAddition(tr.startState, ranges, fromA, added, meta);
      newChanges.push(placed.change);
      newCursorPos = placed.cursor;
    }
  });

  if (newChanges.length === 0) {
    if (movedOver === undefined) return tr;
    // Nothing to suggest: the cursor moves over what it would delete
    return { selection: EditorSelection.cursor(movedOver), effects: tr.effects, scrollIntoView: tr.scrollIntoView };
  }

  return {
    changes: newChanges,
    selection:
      newCursorPos !== undefined
        ? EditorSelection.cursor(newCursorPos)
        : tr.selection,
    effects: tr.effects,
  };
});

/**
 * Compartment for toggling CriticMarkup decorations on/off (source mode toggle).
 * When source mode is ON, this compartment is emptied to show raw markup.
 */
export const criticMarkupCompartment = new Compartment();

/**
 * Extension that provides CriticMarkup parsing and decoration support.
 * Includes keyboard shortcuts:
 * - Mod-Enter: Accept change at cursor
 * - Mod-Backspace: Reject change at cursor
 */
interface CriticMarkupOptions {
  canAcceptReject?: boolean;
  commentBadgeMap?: Map<number, CriticMarkupCommentBadgeInfo>;
}

export function criticMarkupExtension(options: CriticMarkupOptions = {}) {
  const { canAcceptReject = true, commentBadgeMap = null } = options;
  return [
    canAcceptRejectFacet.of(canAcceptReject),
    criticMarkupField,
    commentBadgeMapField.init(() => commentBadgeMap),
    suggestionModeField,
    suggestionModeFilter,
    criticMarkupCompartment.of(criticMarkupPlugin),
    stickyButtonsPlugin,
    keymap.of(criticMarkupKeymap),
  ];
}
