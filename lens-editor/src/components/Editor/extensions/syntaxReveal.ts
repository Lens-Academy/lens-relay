/**
 * Markdown syntax that live preview shows where the cursor is (a heading's #,
 * a quote's >, ** and _, backticks, a link's [ ](url), [[ ]], ---, a bullet's
 * -) eases in rather than popping up. After a click it grows from nothing as
 * it fades in, so the text beside it slides over instead of jumping; after a
 * key it only fades in, as does a bullet's - (it takes the place of the •,
 * so growing would move the text). The animations are in index.css.
 *
 * Each selection move (never an edit) compares the syntax shown before and
 * after, with live preview's own rules (livePreview.ts), and marks what has
 * just appeared until the animation is over. While it grows the cursor is
 * hidden: CodeMirror draws it where the text was when the click landed, and
 * draws it again where the text comes to rest once the marks are taken off.
 */
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { StateEffect, Transaction } from '@codemirror/state';
import type { EditorState, Range } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { frontmatterField } from './frontmatter';

/** How long the marks stay on: the animations' length and a little over */
const REVEAL_MS = 220;

/** Shown while the cursor's line is theirs */
const LINE_MARKS = new Set(['HeaderMark', 'HorizontalRule']);
/** Shown while the selection touches the element they belong to */
const ELEMENT_MARKS: Record<string, Set<string>> = {
  EmphasisMark: new Set(['Emphasis', 'StrongEmphasis']),
  StrikethroughMark: new Set(['Strikethrough']),
  CodeMark: new Set(['InlineCode']),
  LinkMark: new Set(['Link', 'Image', 'Autolink']),
  URL: new Set(['Link', 'Image', 'Autolink']),
  LinkTitle: new Set(['Link', 'Image']),
  WikilinkMark: new Set(['Wikilink']),
};
/** Links and images live preview leaves as text (livePreview.ts): nothing to reveal */
const REPLACED_LINK = /^\[[^\]]*\]\([^)]*\)$/;
const REPLACED_IMAGE = /^!\[[^\]]*\]\([^\s)]+(?:\s+"[^"]*")?\)$/;

interface Shown {
  from: number;
  to: number;
  /** Only fades in, even after a click */
  fade?: boolean;
}

/** The syntax live preview shows for this selection, by "from:to" */
function shownSyntax(state: EditorState): Map<string, Shown> {
  const shown = new Map<string, Shown>();
  const { doc, selection } = state;
  const tree = syntaxTree(state);
  const frontmatter = state.field(frontmatterField, false);
  const inFrontmatter = (pos: number) =>
    !!frontmatter?.enabled && frontmatter.range !== null && pos >= frontmatter.range.from && pos <= frontmatter.range.to;
  const touches = (from: number, to: number) => selection.ranges.some((r) => r.to >= from && r.from <= to);
  const oneLine = (from: number, to: number) => to <= doc.lineAt(from).to;
  const add = (from: number, to: number, fade?: boolean) => {
    if (from < to) shown.set(`${from}:${to}`, { from, to, fade });
  };
  const headLine = doc.lineAt(selection.main.head);

  for (const range of selection.ranges) {
    const first = doc.lineAt(range.from);
    // A long selection: its first lines are enough to animate
    const last = doc.lineAt(Math.min(range.to, doc.line(Math.min(doc.lines, first.number + 100)).to));
    tree.iterate({
      from: first.from,
      to: last.to,
      enter(node) {
        if (inFrontmatter(node.from)) return;
        if (node.name === 'FencedCode') {
          // Its fence lines, shown while the selection is in the block
          if (touches(node.from, node.to)) {
            const open = doc.lineAt(node.from);
            const close = doc.lineAt(node.to);
            add(open.from, open.to);
            if (close.number !== open.number) add(close.from, close.to);
          }
          return false;
        }
        if (node.name === 'Blockquote') {
          // The > on its lines, with the space after each: each shown while the
          // selection is in what holds it, the quote or (on a line that
          // continues a paragraph) the paragraph
          if (touches(node.from, node.to)) {
            tree.iterate({
              from: node.from,
              to: node.to,
              enter(mark) {
                const holder = mark.node.parent;
                if (mark.name !== 'QuoteMark' || !holder || !touches(holder.from, holder.to)) return;
                const lineTo = doc.lineAt(mark.to).to;
                add(mark.from, mark.to < lineTo && doc.sliceString(mark.to, mark.to + 1) === ' ' ? mark.to + 1 : mark.to);
              },
            });
          }
          return;
        }
        if (LINE_MARKS.has(node.name)) {
          const line = doc.lineAt(node.from);
          if (line.number === headLine.number) {
            // A heading's marks with the space after them
            add(node.from, node.name === 'HeaderMark' ? Math.min(node.to + 1, line.to) : node.to);
          }
          return;
        }
        if (node.name === 'ListMark') {
          // A bullet's -, shown while the selection touches it; not a task's,
          // whose box stays (livePreview.ts)
          const item = node.node.parent;
          if (item?.parent?.name === 'BulletList' && !item.getChild('Task') && touches(node.from, node.to)) {
            add(node.from, node.to, true);
          }
          return;
        }
        const parents = ELEMENT_MARKS[node.name];
        const parent = node.node.parent;
        if (!parents || !parent || !parents.has(parent.name) || !touches(parent.from, parent.to)) return;
        if (parent.name === 'Link' || parent.name === 'Image' || parent.name === 'Wikilink') {
          if (!oneLine(parent.from, parent.to)) return;
          const text = doc.sliceString(parent.from, parent.to);
          if (parent.name === 'Link' && !REPLACED_LINK.test(text)) return;
          if (parent.name === 'Image' && !REPLACED_IMAGE.test(text)) return;
        }
        add(node.from, node.to);
      },
    });
  }
  return shown;
}

const clearReveal = StateEffect.define<null>();

const growMark = Decoration.mark({ class: 'cm-syntax-grow' });
const fadeMark = Decoration.mark({ class: 'cm-syntax-fade' });

/**
 * A move counts as a click while the pointer is down or just let go: a click
 * on a link's text moves the cursor through the browser's own selection, not
 * as CodeMirror's pointer selection
 */
const POINTER_GRACE_MS = 150;

const revealPlugin = ViewPlugin.fromClass(
  class {
    marks: DecorationSet = Decoration.none;
    /** Syntax is growing after a click: the cursor waits */
    growing = false;
    pointerDown = false;
    pointerUpAt = 0;
    timer = 0;
    onPointerUp = () => {
      this.pointerDown = false;
      this.pointerUpAt = Date.now();
    };

    constructor(readonly view: EditorView) {
      // On the document, for a drag that ends outside the editor
      view.dom.ownerDocument.addEventListener('pointerup', this.onPointerUp, true);
    }

    update(update: ViewUpdate) {
      // An edit ends the animation, so typing never replays it
      if (update.docChanged || update.transactions.some((tr) => tr.effects.some((e) => e.is(clearReveal)))) {
        this.marks = Decoration.none;
        this.growing = false;
        return;
      }
      if (!update.selectionSet) return;
      const pointer = this.pointerDown || Date.now() - this.pointerUpAt < POINTER_GRACE_MS;
      const before = shownSyntax(update.startState);
      const fresh: Range<Decoration>[] = [];
      for (const [key, { from, to, fade }] of shownSyntax(update.state)) {
        if (!before.has(key)) fresh.push((pointer && !fade ? growMark : fadeMark).range(from, to));
      }
      if (fresh.length === 0) {
        // A key while syntax grows: the cursor shows again
        if (!pointer) this.growing = false;
        return;
      }
      this.marks = this.marks.update({ add: fresh, sort: true });
      this.growing = pointer;
      // Taken off once the last reveal is over
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => {
        this.view.dispatch({ effects: clearReveal.of(null), annotations: Transaction.addToHistory.of(false) });
      }, REVEAL_MS);
    }

    destroy() {
      window.clearTimeout(this.timer);
      this.view.dom.ownerDocument.removeEventListener('pointerup', this.onPointerUp, true);
    }
  },
  {
    decorations: (plugin) => plugin.marks,
    eventHandlers: {
      pointerdown() {
        this.pointerDown = true;
      },
    },
  },
);

export const syntaxReveal = [
  revealPlugin,
  EditorView.editorAttributes.of((view) => (view.plugin(revealPlugin)?.growing ? { class: 'cm-syntax-growing' } : null)),
];

