/**
 * Read-aloud in the Markdown editor (engine: src/lib/read-aloud/engine.ts).
 *
 * - Highlights the sentence (and word) being heard with mark decorations on
 *   the source, so it works whatever CodeMirror has rendered, and keeps it in
 *   view unless the listener scrolls away.
 * - While audio plays, a click on a sentence jumps there instead of moving the
 *   cursor. When it does not play, clicks are ordinary editor clicks.
 * - Hovering a line shows a small play button before it, which plays from that
 *   line.
 *
 * The sentences come from buildMarkdownReading and are rebuilt after edits,
 * so playback carries on through other people's typing.
 */

import { StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { ReadAloudEngine, type ReadAloudHighlight } from '../../../lib/read-aloud/engine';
import {
  buildMarkdownReading,
  docRangeOf,
  unitAtPos,
  unitForLine,
  type MarkdownReading,
} from '../../../lib/read-aloud/markdown-reading';
import { readAloudAvailable } from '../../../lib/read-aloud/api';

interface Marks {
  sentence: { from: number; to: number } | null;
  word: { from: number; to: number } | null;
  hover: { from: number; to: number } | null;
}

const setMarks = StateEffect.define<Partial<Marks>>();

const sentenceMark = Decoration.mark({ class: 'cm-read-aloud-sentence' });
const wordMark = Decoration.mark({ class: 'cm-read-aloud-word' });
const hoverMark = Decoration.mark({ class: 'cm-read-aloud-hover' });

const marksField = StateField.define<{ marks: Marks; deco: DecorationSet }>({
  create: () => ({ marks: { sentence: null, word: null, hover: null }, deco: Decoration.none }),
  update(value, tr) {
    let marks = value.marks;
    if (tr.docChanged) {
      const map = (r: { from: number; to: number } | null) =>
        r && { from: tr.changes.mapPos(r.from, 1), to: tr.changes.mapPos(r.to, -1) };
      marks = { sentence: map(marks.sentence), word: map(marks.word), hover: map(marks.hover) };
    }
    for (const e of tr.effects) if (e.is(setMarks)) marks = { ...marks, ...e.value };
    if (marks === value.marks) return value;
    const ranges: Range<Decoration>[] = [];
    const add = (r: { from: number; to: number } | null, deco: Decoration) => {
      if (r && r.to > r.from) ranges.push(deco.range(r.from, r.to));
    };
    add(marks.hover, hoverMark);
    add(marks.sentence, sentenceMark);
    add(marks.word, wordMark);
    return { marks, deco: Decoration.set(ranges, true) };
  },
  provide: f => EditorView.decorations.from(f, v => v.deco),
});

/** Rebuild delay after an edit while playing. */
const REBUILD_MS = 300;
/** Mouse travel that makes a press a drag rather than a click. */
const CLICK_SLOP_PX = 4;

export class ReadAloudController {
  readonly engine = new ReadAloudEngine();
  private reading: MarkdownReading | null = null;
  /** Whether `reading` was built from a fully parsed document. */
  private readingComplete = false;
  /** The server offers read-aloud (it has a Speechify key); until then no hover button. */
  private available = false;
  /** Document position of the heard sentence, mapped through edits. */
  private anchor: number | null = null;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private button: HTMLButtonElement;
  private buttonUnit: number | null = null;
  private press: { x: number; y: number; unit: number } | null = null;
  private ownScrollUntil = 0;
  private unsubscribe: () => void;
  private unsubscribeHighlight: () => void;
  private lastScrollPaused = false;

  constructor(private readonly view: EditorView) {
    this.unsubscribeHighlight = this.engine.onHighlight(h => this.highlight(h));
    void readAloudAvailable().then(ok => { this.available = ok; });

    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'cm-read-aloud-line-play';
    this.button.setAttribute('aria-label', 'Read aloud from here');
    this.button.title = 'Read aloud from here';
    this.button.appendChild(playIcon());
    this.button.style.display = 'none';
    // Keep the cursor (and the hidden syntax on its line) where it is.
    this.button.addEventListener('mousedown', e => e.preventDefault());
    this.button.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      if (this.buttonUnit != null) this.playFrom(this.buttonUnit);
    });
    view.scrollDOM.appendChild(this.button);

    view.scrollDOM.addEventListener('mousemove', this.onMouseMove);
    view.scrollDOM.addEventListener('mouseleave', this.onMouseLeave);
    view.scrollDOM.addEventListener('wheel', this.onUserScroll, { passive: true });
    view.scrollDOM.addEventListener('touchmove', this.onUserScroll, { passive: true });
    // Capture on the editor root, ahead of CodeMirror's own handlers on the content.
    view.dom.addEventListener('mousedown', this.onMouseDown, true);
    window.addEventListener('mouseup', this.onMouseUp, true);

    // "Back to current sentence" turns following on again: scroll there now.
    this.unsubscribe = this.engine.subscribe(() => {
      const paused = this.engine.getSnapshot().autoScrollPaused;
      if (this.lastScrollPaused && !paused) this.scrollToCurrent(true);
      this.lastScrollPaused = paused;
    });
  }

  /** Start reading at the first sentence in view (the Listen button). */
  start() {
    const reading = this.ensureReading();
    if (reading.units.length === 0) {
      this.engine.open();
      return;
    }
    const top = this.view.lineBlockAtHeight(this.view.scrollDOM.scrollTop + 1);
    let unit = unitForLine(reading, top.from, this.view.state.doc.length);
    if (unit == null) unit = 0;
    this.playFrom(unit);
  }

  playFrom(unit: number) {
    this.ensureReading();
    this.engine.setUnits(this.reading!.units);
    this.engine.play(unit);
    this.anchor = this.reading!.docRanges[unit]?.from ?? null;
  }

  update(u: ViewUpdate) {
    if (!u.docChanged) return;
    if (this.anchor != null) this.anchor = u.changes.mapPos(this.anchor, 1);
    this.reading = null;
    this.readingComplete = false;
    if (this.engine.isActive) {
      if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
      this.rebuildTimer = setTimeout(() => {
        this.rebuildTimer = null;
        const reading = this.ensureReading();
        const current = this.anchor != null ? unitAtPos(reading, this.anchor) ?? unitForLine(reading, this.anchor, this.anchor) : null;
        this.engine.setUnits(reading.units, current);
      }, REBUILD_MS);
    }
  }

  destroy() {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.unsubscribe();
    // Stopping clears the highlight; there is no view to dispatch to any more.
    this.unsubscribeHighlight();
    this.engine.destroy();
    this.button.remove();
    this.view.scrollDOM.removeEventListener('mousemove', this.onMouseMove);
    this.view.scrollDOM.removeEventListener('mouseleave', this.onMouseLeave);
    this.view.scrollDOM.removeEventListener('wheel', this.onUserScroll);
    this.view.scrollDOM.removeEventListener('touchmove', this.onUserScroll);
    this.view.dom.removeEventListener('mousedown', this.onMouseDown, true);
    window.removeEventListener('mouseup', this.onMouseUp, true);
  }

  /** The sentences; `complete: false` accepts a partly parsed document (hovering). */
  private ensureReading(complete = true): MarkdownReading {
    if (!this.reading || (complete && !this.readingComplete)) {
      this.reading = buildMarkdownReading(this.view.state, complete);
      this.readingComplete = complete;
    }
    return this.reading;
  }

  private highlight(h: ReadAloudHighlight | null) {
    const reading = this.reading;
    if (!h || !reading) {
      this.dispatch({ sentence: null, word: null, hover: null });
      return;
    }
    const sentence = reading.docRanges[h.unit] ?? null;
    const word = h.word ? docRangeOf(reading, h.unit, h.word) : null;
    const prev = this.view.state.field(marksField).marks.sentence;
    const moved = !prev || !sentence || prev.from !== sentence.from;
    if (sentence) this.anchor = sentence.from;
    this.dispatch({ sentence, word, ...(moved ? { hover: null } : {}) });
    if (moved) this.scrollToCurrent(false);
  }

  private dispatch(marks: Partial<Marks>) {
    // Never inside an update cycle: highlights come from requestAnimationFrame.
    this.view.dispatch({ effects: setMarks.of(marks) });
  }

  private scrollToCurrent(force: boolean) {
    const snap = this.engine.getSnapshot();
    if (!force && snap.autoScrollPaused) return;
    const sentence = this.view.state.field(marksField).marks.sentence;
    if (!sentence) return;
    this.ownScrollUntil = Date.now() + 1000;
    // Keep the sentence in the middle half of the editor, as the platform keeps it centred.
    this.view.dispatch({
      effects: EditorView.scrollIntoView(sentence.from, { y: 'nearest', yMargin: this.view.scrollDOM.clientHeight / 4 }),
    });
  }

  private onUserScroll = () => {
    if (!this.engine.isPlaying || Date.now() < this.ownScrollUntil) return;
    if (!this.engine.getSnapshot().autoScrollPaused) this.engine.setAutoScrollPaused(true);
  };

  private onMouseMove = (e: MouseEvent) => {
    if (e.buttons || !this.available) return;
    const view = this.view;
    const block = view.lineBlockAtHeight(e.clientY - view.documentTop);
    const reading = this.ensureReading(this.engine.isActive);
    const unit = unitForLine(reading, block.from, block.to);
    this.placeButton(unit, block.from);
    // While playing, preview which sentence a click would jump to.
    if (this.engine.isPlaying) {
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
      const target = pos == null ? null : unitAtPos(reading, pos);
      const range = target == null || target === this.engine.getSnapshot().current ? null : reading.docRanges[target];
      const prev = view.state.field(marksField).marks.hover;
      if (prev?.from !== range?.from) this.dispatch({ hover: range });
      view.contentDOM.classList.toggle('cm-read-aloud-over-text', target != null);
    }
  };

  private onMouseLeave = () => {
    this.placeButton(null, 0);
    if (this.view.state.field(marksField).marks.hover) this.dispatch({ hover: null });
    this.view.contentDOM.classList.remove('cm-read-aloud-over-text');
  };

  private placeButton(unit: number | null, lineFrom: number) {
    this.buttonUnit = unit;
    if (unit == null) {
      this.button.style.display = 'none';
      return;
    }
    const coords = firstTextCoords(this.view, lineFrom);
    if (!coords) {
      this.button.style.display = 'none';
      return;
    }
    const scroller = this.view.scrollDOM.getBoundingClientRect();
    const content = this.view.contentDOM.getBoundingClientRect();
    // In the margin, 10px left of the text (line box + 6px; the line box
    // starts at the content's padding edge), level with its first line
    const padLeft = parseFloat(getComputedStyle(this.view.contentDOM).paddingLeft) || 0;
    const size = 22;
    const lineMid = (coords.top + coords.bottom) / 2;
    this.button.style.display = '';
    this.button.style.top = `${Math.round(lineMid - size / 2 - scroller.top + this.view.scrollDOM.scrollTop)}px`;
    this.button.style.left = `${Math.max(0, Math.round(content.left + padLeft + 6 - 10 - size - scroller.left + this.view.scrollDOM.scrollLeft))}px`;
  }

  private onMouseDown = (e: MouseEvent) => {
    this.press = null;
    if (!this.engine.isPlaying || e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as Element | null;
    if (!target || !this.view.contentDOM.contains(target)) return;
    if (target.closest('a, button, input, textarea, select, [role=button]')) return;
    const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
    const unit = pos == null ? null : unitAtPos(this.ensureReading(), pos);
    if (unit == null) return;
    // Playing: the click jumps; the cursor (and the syntax on its line) stays put.
    e.preventDefault();
    e.stopPropagation();
    this.press = { x: e.clientX, y: e.clientY, unit };
  };

  private onMouseUp = (e: MouseEvent) => {
    const press = this.press;
    this.press = null;
    if (!press) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_SLOP_PX) return;
    this.playFrom(press.unit);
  };
}

/**
 * Where a line's text starts: its first character drawn at full height, past
 * markup hidden at no size (a heading's #, a list's marker), else the line's
 * start
 */
function firstTextCoords(view: EditorView, lineFrom: number) {
  const line = view.state.doc.lineAt(lineFrom);
  for (let pos = lineFrom; pos < Math.min(line.to, lineFrom + 24); pos++) {
    const at = view.coordsAtPos(pos, 1);
    if (at && at.bottom - at.top > 4) return at;
  }
  return view.coordsAtPos(lineFrom, 1);
}

/** The line button's play mark: a small rounded triangle */
function playIcon(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M4 2.6c0-.6.6-.9 1.1-.6l5 3.4c.4.3.4.9 0 1.2l-5 3.4c-.5.3-1.1 0-1.1-.6Z');
  svg.appendChild(path);
  return svg;
}

const readAloudPlugin = ViewPlugin.fromClass(
  class {
    controller: ReadAloudController;
    constructor(view: EditorView) {
      this.controller = new ReadAloudController(view);
    }
    update(u: ViewUpdate) {
      this.controller.update(u);
    }
    destroy() {
      this.controller.destroy();
    }
  },
);

/** The read-aloud controller of an editor that has the extension. */
export function getReadAloud(view: EditorView | null): ReadAloudController | null {
  return view?.plugin(readAloudPlugin)?.controller ?? null;
}

const readAloudTheme = EditorView.baseTheme({
  // A soft blue for the sentence and a stronger one for the word, with dark values (index.css)
  '.cm-read-aloud-sentence': { backgroundColor: 'var(--lens-read-sentence, rgba(35, 131, 226, 0.14))', borderRadius: '2px' },
  '.cm-read-aloud-word': { backgroundColor: 'var(--lens-read-word, rgba(35, 131, 226, 0.32))', borderRadius: '2px' },
  '.cm-read-aloud-hover': { backgroundColor: 'rgba(0, 0, 0, 0.05)', borderRadius: '2px' },
  '.cm-content.cm-read-aloud-over-text': { cursor: 'pointer' },
  // Notion's block handle: a small grey square button that darkens on hover
  '.cm-read-aloud-line-play': {
    position: 'absolute',
    zIndex: '5',
    width: '22px',
    height: '22px',
    padding: '0',
    border: 'none',
    borderRadius: '6px',
    background: 'transparent',
    color: 'var(--lens-icon-secondary, #8e8b86)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'background-color 120ms, color 120ms',
    animation: 'cm-read-aloud-play-in 140ms ease-out',
  },
  '.cm-read-aloud-line-play:hover': {
    color: 'var(--lens-icon, #383836)',
    backgroundColor: 'var(--lens-hover-bg, rgba(55, 53, 47, 0.06))',
  },
  // The triangle a pixel right of centre, where it looks centred
  '.cm-read-aloud-line-play svg': { width: '12px', height: '12px', fill: 'currentColor', marginLeft: '1px' },
  '@keyframes cm-read-aloud-play-in': { from: { opacity: '0' } },
});

export function readAloud(): Extension {
  return [marksField, readAloudPlugin, readAloudTheme];
}
