/**
 * Read-aloud inside the preview frame. The parent plays the audio
 * (src/lib/read-aloud/engine.ts); this layer, running in the page:
 *
 * - walks the page's visible text into sentences and sends them to the
 *   parent, with a map back to DOM text nodes;
 * - highlights the sentence and word being heard (CSS Custom Highlight API,
 *   so the page's DOM is never touched) and scrolls along;
 * - shows a small play button before the paragraph under the pointer (in a
 *   shadow root after <body>, like the comment badges), which plays from there;
 * - while audio plays, turns a click on a sentence into "play from here".
 *   When it does not play, clicks reach the page as usual.
 *
 * The page shares this realm and can forge what we post; the parent treats
 * every tts message as a request from the page, never as proof of a click.
 */

import type { BridgeToParent, TtsUnit } from './protocol';
import { OVERLAY_ATTRIBUTE } from '../anchoring/text-index';
import { splitSentences, type CharRange } from '../../../lib/read-aloud/text';

export interface TtsLayerOptions {
  post: (message: BridgeToParent) => void;
  /** Comment mode owns clicks and hovering while it is on. */
  commentMode: () => boolean;
}

export interface TtsLayer {
  setState(state: { enabled: boolean; playing: boolean }): void;
  setHighlight(h: { unit: number | null; word: CharRange | null; follow: boolean }): void;
  /** Send the units, asking the parent to start at the first one in view. */
  sendUnits(start: boolean): void;
  cleanup(): void;
}

/** Elements whose text is never read. */
const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SELECT', 'OPTION', 'INPUT', 'BUTTON', 'IFRAME', 'OBJECT',
  'HEAD', 'TITLE', 'PRE', 'SVG', 'MATH', 'CANVAS', 'VIDEO', 'AUDIO', 'TABLE', 'SUP',
]);
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'DD', 'DETAILS', 'DIALOG', 'DIV', 'DL', 'DT', 'FIELDSET',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HGROUP', 'LI', 'MAIN',
  'NAV', 'OL', 'P', 'SECTION', 'SUMMARY', 'UL',
]);
const INTERACTIVE = 'a, button, input, select, textarea, label, summary, [role=button], [role=link], [contenteditable=""], [contenteditable=true], [onclick]';
const HOST_ATTRIBUTE = 'data-lens-tts-layer';
const STYLE_ID = 'lens-tts-highlight-style';
const MAX_UNITS = 5000;
const BLOCK_PAUSE_S = 0.3;

const HIGHLIGHT_CSS = `
::highlight(lens-tts-sentence) { background-color: #fde6c8; }
::highlight(lens-tts-word) { background-color: #e6b988; }
::highlight(lens-tts-hover) { background-color: rgba(0, 0, 0, 0.05); }
html.lens-tts-over-text, html.lens-tts-over-text * { cursor: pointer !important; }
`;

const SHADOW_CSS = `
.play { position: absolute; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 9999px;
  display: none; align-items: center; justify-content: center; cursor: pointer; pointer-events: auto;
  background: rgba(255, 255, 255, 0.9); color: #9ca3af; box-shadow: 0 0 0 1px rgba(0,0,0,0.06); }
.play:hover { color: #b87018; background: #fde6c8; }
.play svg { width: 11px; height: 11px; fill: currentColor; }
`;

interface Reading {
  flat: string;
  /** Per flat character: its text node and offset; null for a separator. */
  nodeOf: Array<Text | null>;
  offsetOf: Int32Array;
  units: TtsUnit[];
  starts: number[];
  ends: number[];
  /** The flat range of each block element that holds text. */
  blocks: Map<Element, { start: number; end: number }>;
  /** Flat index of each text node's first character. */
  firstIndex: Map<Text, number>;
}

type HighlightRegistry = Map<string, unknown>;
type HighlightCtor = new (...ranges: Range[]) => unknown;

export function installTtsLayer(win: Window & typeof globalThis, options: TtsLayerOptions): TtsLayer {
  const doc = win.document;
  const registry = (win.CSS as unknown as { highlights?: HighlightRegistry } | undefined)?.highlights;
  const Highlight = (win as unknown as { Highlight?: HighlightCtor }).Highlight;
  const canHighlight = !!registry && typeof Highlight === 'function';

  let enabled = false;
  let playing = false;
  let reading: Reading | null = null;
  let observer: MutationObserver | null = null;
  let current: { unit: number | null; word: CharRange | null } = { unit: null, word: null };
  let hoverUnit: number | null = null;
  let buttonUnit: number | null = null;
  let pointerFrame: number | null = null;
  let pointer: { x: number; y: number } | null = null;
  let ownScrollUntil = 0;
  let unitsTimer: number | null = null;

  // ---- reading ----------------------------------------------------------

  const displayCache = new WeakMap<Element, boolean>();
  /** Does the element start a new line (block-level, as rendered)? */
  function isBlock(el: Element): boolean {
    let block = displayCache.get(el);
    if (block === undefined) {
      const display = win.getComputedStyle(el).display;
      // An empty value (no layout, e.g. in tests) falls back to the tag.
      block = display
        ? !(display.startsWith('inline') || display === 'contents' || display === 'none')
        : BLOCK_TAGS.has(el.tagName.toUpperCase());
      displayCache.set(el, block);
    }
    return block;
  }

  function skipped(el: Element): boolean {
    if (SKIP_TAGS.has(el.tagName.toUpperCase()) || el.hasAttribute(OVERLAY_ATTRIBUTE)) return true;
    if (el.getAttribute('aria-hidden') === 'true' || (el as HTMLElement).hidden) return true;
    if (el.classList.contains('katex')) return true;
    const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
    return check ? !check.call(el, { visibilityProperty: true }) : false;
  }

  function blockOf(node: Node): Element {
    let el = node.parentElement;
    while (el && el !== doc.body && !isBlock(el)) el = el.parentElement;
    return el ?? doc.body;
  }

  function build(): Reading {
    const chars: string[] = [];
    const nodeOf: Array<Text | null> = [];
    const offsets: number[] = [];
    const blocks = new Map<Element, { start: number; end: number }>();
    const firstIndex = new Map<Text, number>();
    const blockStarts: number[] = [];
    let lastBlock: Element | null = null;
    const root = doc.body;
    if (root) {
      const walker = doc.createTreeWalker(root, 0x1 | 0x4, {
        acceptNode(node) {
          if (node.nodeType === 1 && skipped(node as Element)) return 2; // FILTER_REJECT
          return node.nodeType === 3 ? 1 : 3; // text: accept; element: skip itself, walk children
        },
      });
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node as Text;
        const value = text.data;
        if (!/\S/.test(value)) {
          if (chars.length && chars[chars.length - 1] !== ' ' && chars[chars.length - 1] !== '\n') {
            chars.push(' ');
            nodeOf.push(null);
            offsets.push(-1);
          }
          continue;
        }
        const block = blockOf(text);
        if (block !== lastBlock) {
          if (chars.length && chars[chars.length - 1] === ' ') {
            chars.pop(); nodeOf.pop(); offsets.pop();
          }
          if (chars.length) {
            chars.push('\n'); nodeOf.push(null); offsets.push(-1);
          }
          blockStarts.push(chars.length);
          lastBlock = block;
        }
        firstIndex.set(text, chars.length);
        for (let i = 0; i < value.length; i++) {
          const c = value[i];
          if (/\s/.test(c)) {
            const prev = chars[chars.length - 1];
            if (prev === undefined || prev === ' ' || prev === '\n') continue;
            chars.push(' ');
          } else {
            chars.push(c);
          }
          nodeOf.push(text);
          offsets.push(i);
        }
        const span = blocks.get(block);
        if (span) span.end = chars.length;
        else blocks.set(block, { start: blockStarts[blockStarts.length - 1], end: chars.length });
      }
    }
    const flat = chars.join('');
    const units: TtsUnit[] = [];
    const starts: number[] = [];
    const ends: number[] = [];
    let b = -1;
    for (const s of splitSentences(flat)) {
      if (units.length >= MAX_UNITS) break;
      let newBlock = false;
      while (b + 1 < blockStarts.length && blockStarts[b + 1] <= s.start) {
        b++;
        newBlock = true;
      }
      units.push({ text: flat.slice(s.start, s.end), pauseBefore: newBlock ? BLOCK_PAUSE_S : 0 });
      starts.push(s.start);
      ends.push(s.end);
    }
    return { flat, nodeOf, offsetOf: Int32Array.from(offsets), units, starts, ends, blocks, firstIndex };
  }

  function ensureReading(): Reading {
    if (!reading) {
      reading = build();
      watch();
    }
    return reading;
  }

  function watch() {
    if (observer || !doc.body) return;
    observer = new win.MutationObserver(records => {
      const ours = records.every(r => {
        const target = r.target.nodeType === 1 ? r.target as Element : r.target.parentElement;
        return !!target?.closest?.(`[${OVERLAY_ATTRIBUTE}]`);
      });
      if (ours) return;
      reading = null;
      // While listening, keep the parent's sentences in step with the page.
      if (playing) scheduleUnits();
    });
    // Not class or style: animated pages change those constantly, and the walk is the whole page.
    observer.observe(doc.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden'] });
  }

  function scheduleUnits() {
    if (unitsTimer !== null) return;
    unitsTimer = win.setTimeout(() => {
      unitsTimer = null;
      options.post({ type: 'tts-units', payload: { units: ensureReading().units } });
    }, 300);
  }

  function rangeOf(r: Reading, start: number, end: number): Range | null {
    let s = start;
    let e = end - 1;
    while (s <= e && !r.nodeOf[s]) s++;
    while (e >= s && !r.nodeOf[e]) e--;
    if (s > e) return null;
    const startNode = r.nodeOf[s]!;
    const endNode = r.nodeOf[e]!;
    if (!startNode.isConnected || !endNode.isConnected) return null;
    const range = doc.createRange();
    try {
      range.setStart(startNode, r.offsetOf[s]);
      range.setEnd(endNode, r.offsetOf[e] + 1);
    } catch {
      return null;
    }
    return range;
  }

  function unitRange(unit: number, word: CharRange | null = null): Range | null {
    const r = ensureReading();
    const base = r.starts[unit];
    if (base === undefined) return null;
    return word ? rangeOf(r, base + word.start, base + word.end) : rangeOf(r, base, r.ends[unit]);
  }

  /** The unit holding flat offset `at`, or the next one after it. */
  function unitAt(r: Reading, at: number, exact: boolean): number | null {
    let lo = 0;
    let hi = r.units.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (r.ends[mid] <= at) lo = mid + 1;
      else hi = mid;
    }
    if (lo >= r.units.length) return null;
    if (exact && r.starts[lo] > at) return null;
    return lo;
  }

  function caretAt(x: number, y: number): { node: Node; offset: number } | null {
    const d = doc as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    const pos = d.caretPositionFromPoint?.(x, y);
    if (pos) return { node: pos.offsetNode, offset: pos.offset };
    const range = doc.caretRangeFromPoint?.(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }

  /** The unit under the pointer, if the pointer is over its text. */
  function unitAtPoint(x: number, y: number): number | null {
    const caret = caretAt(x, y);
    if (!caret || caret.node.nodeType !== 3) return null;
    const node = caret.node as Text;
    const probe = doc.createRange();
    const from = Math.max(0, Math.min(caret.offset, node.length) - 1);
    probe.setStart(node, from);
    probe.setEnd(node, Math.min(node.length, from + 2));
    const over = Array.from(probe.getClientRects()).some(rect => (
      x >= rect.left - 3 && x <= rect.right + 3 && y >= rect.top - 3 && y <= rect.bottom + 3
    ));
    if (!over) return null;
    const r = ensureReading();
    // The flat index of this node's character nearest the caret.
    const first = r.firstIndex.get(node);
    if (first === undefined) return null;
    let i = first;
    while (i + 1 < r.nodeOf.length && r.nodeOf[i + 1] === node && r.offsetOf[i] < from) i++;
    return unitAt(r, i, true);
  }

  // ---- drawing -----------------------------------------------------------

  function ensureStyle() {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.setAttribute(OVERLAY_ATTRIBUTE, '');
    style.textContent = HIGHLIGHT_CSS;
    (doc.head ?? doc.documentElement)?.appendChild(style);
  }

  function setHighlightRanges(name: string, range: Range | null) {
    if (!canHighlight) return;
    if (range) registry!.set(name, new Highlight!(range));
    else registry!.delete(name);
  }

  function draw() {
    ensureStyle();
    const { unit, word } = current;
    setHighlightRanges('lens-tts-sentence', unit === null ? null : unitRange(unit));
    setHighlightRanges('lens-tts-word', unit === null || !word ? null : unitRange(unit, word));
    setHighlightRanges('lens-tts-hover', hoverUnit === null || hoverUnit === unit ? null : unitRange(hoverUnit));
  }

  function follow() {
    if (current.unit === null) return;
    const range = unitRange(current.unit);
    if (!range) return;
    const rect = range.getBoundingClientRect();
    const h = win.innerHeight;
    // Keep the sentence in the middle half of the page.
    if (rect.top >= h * 0.25 && rect.bottom <= h * 0.75) return;
    ownScrollUntil = Date.now() + 1000;
    win.scrollBy({ top: rect.top - h * 0.4, behavior: 'smooth' });
  }

  // ---- hover button ------------------------------------------------------

  let host: HTMLElement | null = null;
  let button: HTMLButtonElement | null = null;

  function ensureButton(): HTMLButtonElement | null {
    if (button && host?.isConnected) return button;
    const root = doc.documentElement;
    if (!root) return null;
    host = doc.createElement('div');
    host.setAttribute(HOST_ATTRIBUTE, '');
    host.setAttribute(OVERLAY_ATTRIBUTE, '');
    host.style.cssText = 'position:absolute !important;top:0 !important;left:0 !important;width:0 !important;'
      + 'height:0 !important;margin:0 !important;padding:0 !important;border:0 !important;'
      + 'z-index:2147483646 !important;pointer-events:none !important;display:block !important;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = SHADOW_CSS;
    button = doc.createElement('button');
    button.type = 'button';
    button.className = 'play';
    button.title = 'Read aloud from here';
    button.setAttribute('aria-label', 'Read aloud from here');
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
    button.addEventListener('mousedown', e => e.preventDefault());
    button.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      if (buttonUnit !== null) playFrom(buttonUnit);
    });
    shadow.append(style, button);
    root.appendChild(host);
    return button;
  }

  /** Page coordinates of the shown button's row: from the button to the block's right edge. */
  let buttonRow: { left: number; right: number; top: number; bottom: number } | null = null;

  function hideButton() {
    buttonUnit = null;
    buttonRow = null;
    if (button) button.style.display = 'none';
  }

  /** Show the play button before the block under (x, y). */
  function placeButton(x: number, y: number, target: Element | null) {
    if (!enabled || options.commentMode() || !target || target.closest(`[${HOST_ATTRIBUTE}]`)) {
      if (!target?.closest(`[${HOST_ATTRIBUTE}]`)) hideButton();
      return;
    }
    const r = ensureReading();
    // The nearest block with text, walking up from the element under the pointer.
    let el: Element | null = target;
    let span: { start: number; end: number } | undefined;
    while (el && !(span = r.blocks.get(el))) el = el.parentElement;
    if (!el || !span) {
      // On the way from the text to the button the pointer crosses margin
      // that belongs to no block: keep the button while it stays in the row.
      const px = x + win.scrollX;
      const py = y + win.scrollY;
      const row = buttonRow;
      if (!row || px < row.left || px > row.right || py < row.top || py > row.bottom) hideButton();
      return;
    }
    const unit = unitAt(r, span.start, false);
    const firstLine = unit === null ? null : rangeOf(r, r.starts[unit], Math.min(r.ends[unit], r.starts[unit] + 1));
    const rect = firstLine?.getClientRects()[0];
    const box = el.getBoundingClientRect();
    if (unit === null || !rect || y < box.top || y > box.bottom) {
      hideButton();
      return;
    }
    const b = ensureButton();
    if (!b) return;
    buttonUnit = unit;
    // Clear of list markers, which sit outside the item's box.
    const marker = win.getComputedStyle(el).display === 'list-item' ? 18 : 0;
    const left = Math.max(2, Math.min(rect.left, box.left) - 28 - marker);
    b.style.left = `${left + win.scrollX}px`;
    b.style.top = `${(rect.top + rect.bottom) / 2 - 11 + win.scrollY}px`;
    b.style.display = 'flex';
    buttonRow = {
      left: left + win.scrollX - 4,
      right: box.right + win.scrollX,
      top: box.top + win.scrollY,
      bottom: box.bottom + win.scrollY,
    };
  }

  // ---- events ------------------------------------------------------------

  function playFrom(unit: number) {
    options.post({ type: 'tts-units', payload: { units: ensureReading().units, play: unit } });
  }

  function onPointerMove(event: PointerEvent) {
    pointer = { x: event.clientX, y: event.clientY };
    if (pointerFrame !== null) return;
    pointerFrame = win.requestAnimationFrame(() => {
      pointerFrame = null;
      if (!pointer || !enabled) return;
      const { x, y } = pointer;
      const target = doc.elementFromPoint(x, y);
      placeButton(x, y, target);
      if (playing && !options.commentMode()) {
        const unit = target?.closest(INTERACTIVE) ? null : unitAtPoint(x, y);
        doc.documentElement.classList.toggle('lens-tts-over-text', unit !== null);
        if (unit !== hoverUnit) {
          hoverUnit = unit;
          draw();
        }
      }
    });
  }

  function onPointerLeave() {
    pointer = null;
    hideButton();
    doc.documentElement.classList.remove('lens-tts-over-text');
    if (hoverUnit !== null) {
      hoverUnit = null;
      draw();
    }
  }

  let press: { x: number; y: number } | null = null;
  function onPointerDown(event: PointerEvent) {
    press = { x: event.clientX, y: event.clientY };
  }

  function onClick(event: MouseEvent) {
    if (!playing || options.commentMode() || event.button !== 0) return;
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) return;
    const target = event.target as Element | null;
    if (!target || target.closest(INTERACTIVE) || target.closest(`[${HOST_ATTRIBUTE}]`)) return;
    if (!win.getSelection()?.isCollapsed) return;
    const unit = unitAtPoint(event.clientX, event.clientY);
    if (unit === null) return;
    // Playing: the click jumps; the page does not see it.
    event.preventDefault();
    event.stopPropagation();
    playFrom(unit);
  }

  function onUserScroll() {
    if (!playing || Date.now() < ownScrollUntil) return;
    options.post({ type: 'tts-user-scrolled', payload: {} });
  }

  doc.addEventListener('pointermove', onPointerMove, true);
  doc.documentElement?.addEventListener('pointerleave', onPointerLeave);
  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('click', onClick, true);
  win.addEventListener('wheel', onUserScroll, { passive: true });
  win.addEventListener('touchmove', onUserScroll, { passive: true });

  return {
    setState(state) {
      const wasPlaying = playing;
      enabled = state.enabled;
      playing = state.playing;
      if (!enabled) hideButton();
      if (!playing) {
        doc.documentElement.classList.remove('lens-tts-over-text');
        if (hoverUnit !== null) {
          hoverUnit = null;
          draw();
        }
      }
      // A fresh frame (the page re-rendered while listening): hand the parent
      // this page's sentences so it can carry on.
      if (playing && !wasPlaying) scheduleUnits();
    },
    setHighlight(h) {
      const moved = h.unit !== current.unit;
      current = { unit: h.unit, word: h.word };
      draw();
      if (h.follow && (moved || h.unit === null)) follow();
    },
    sendUnits(start) {
      const r = ensureReading();
      let play: number | undefined;
      if (start) {
        // The first sentence whose text is in view.
        play = 0;
        for (let i = 0; i < r.units.length; i++) {
          const rect = unitRange(i)?.getBoundingClientRect();
          if (rect && rect.bottom > 0) {
            play = i;
            break;
          }
        }
      }
      options.post({ type: 'tts-units', payload: { units: r.units, ...(play !== undefined ? { play } : {}) } });
    },
    cleanup() {
      doc.removeEventListener('pointermove', onPointerMove, true);
      doc.documentElement?.removeEventListener('pointerleave', onPointerLeave);
      doc.removeEventListener('pointerdown', onPointerDown, true);
      doc.removeEventListener('click', onClick, true);
      win.removeEventListener('wheel', onUserScroll);
      win.removeEventListener('touchmove', onUserScroll);
      observer?.disconnect();
      if (pointerFrame !== null) win.cancelAnimationFrame(pointerFrame);
      if (unitsTimer !== null) win.clearTimeout(unitsTimer);
      for (const name of ['lens-tts-sentence', 'lens-tts-word', 'lens-tts-hover']) registry?.delete(name);
      host?.remove();
      doc.getElementById(STYLE_ID)?.remove();
    },
  };
}
