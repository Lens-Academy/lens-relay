/**
 * The comment layer inside the preview frame: resolves each thread's anchor
 * against the page as rendered (after scripts run, and again whenever the DOM
 * changes), draws highlights and numbered badges without modifying the
 * page's DOM, and turns clicks and selections in Comment mode into anchors.
 *
 * Nothing here is inserted into <body>: highlights use the CSS Custom
 * Highlight API (with an overlay fallback), and badges live in a shadow root
 * attached to an element after <body>, so frameworks that own the body
 * (React, htm, d3) never see foreign nodes.
 */
import { buildTextIndex, isSkippedElement, OVERLAY_ATTRIBUTE, offsetOfPoint, rangeFor, type TextIndex } from '../anchoring/text-index';
import { clickSpan, describeElement, describeSpan, isPageContent, pinTarget } from '../anchoring/describe';
import { resolveAnchor, type Resolution } from '../anchoring/resolve';
import type { AnchorState, HtmlAnchor } from '../anchoring/types';
import type {
  AnchorCapture,
  BridgeToParent,
  CaptureVia,
  Rect,
  ThreadMark,
  ThreadPlacement,
} from './protocol';

const HOST_ATTRIBUTE = 'data-lens-comment-layer';
const HIGHLIGHT_STYLE_ID = 'lens-comment-highlight-style';
/** The DOM must be quiet this long before an orphan counts as gone. */
const SETTLE_MS = 700;
/** …or, for pages that animate forever, this long after loading. */
const MAX_SETTLE_MS = 5000;
const MUTATION_DEBOUNCE_MS = 120;
const SELECTION_DEBOUNCE_MS = 200;
const DRAFT_ID = '__draft__';

const HIGHLIGHTS = {
  open: 'lens-comment',
  guessed: 'lens-comment-guessed',
  focus: 'lens-comment-focus',
  resolved: 'lens-comment-resolved',
  draft: 'lens-comment-draft',
  hover: 'lens-comment-hover',
} as const;

const HIGHLIGHT_CSS = `
::highlight(${HIGHLIGHTS.open}) { background-color: rgba(250, 204, 21, 0.3); }
::highlight(${HIGHLIGHTS.guessed}) { background-color: rgba(251, 146, 60, 0.22); text-decoration: underline dotted rgba(234, 88, 12, 0.9); }
::highlight(${HIGHLIGHTS.focus}) { background-color: rgba(250, 204, 21, 0.65); }
::highlight(${HIGHLIGHTS.resolved}) { background-color: rgba(156, 163, 175, 0.22); }
::highlight(${HIGHLIGHTS.draft}) { background-color: rgba(59, 130, 246, 0.28); }
::highlight(${HIGHLIGHTS.hover}) { background-color: rgba(59, 130, 246, 0.16); }
html.lens-commenting, html.lens-commenting * { cursor: crosshair !important; }
`;

const SHADOW_CSS = `
:host { all: initial; }
.badge {
  position: absolute; box-sizing: border-box; min-width: 15px; height: 15px; padding: 0 4px; margin: 0;
  border-radius: 8px; border: 1px solid rgba(180, 83, 9, 0.35);
  background: #fde68a; color: #78350f; font: 700 9.5px/13px system-ui, -apple-system, sans-serif;
  text-align: center; cursor: pointer; pointer-events: auto; user-select: none;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18); transform: translate(1px, -40%);
}
.badge:hover { filter: brightness(0.95); transform: translate(1px, -40%) scale(1.12); }
.badge.resolved { background: #e5e7eb; border-color: #9ca3af; color: #4b5563; }
.badge.guessed { background: #ffedd5; border-style: dashed; border-color: #ea580c; color: #9a3412; }
.badge.focused { background: #f59e0b; border-color: #b45309; color: #fff; }
.badge.draft { background: #3b82f6; border-color: #1d4ed8; color: #fff; cursor: default; }
.badge.pin, .badge.pin:hover { transform: translate(-50%, -50%); min-width: 18px; height: 18px; font-size: 11px; line-height: 16px; border-radius: 9px; }
.box { position: absolute; box-sizing: border-box; pointer-events: none; border-radius: 3px; }
.box.focus { outline: 2px solid #f59e0b; outline-offset: 2px; }
.box.draft { outline: 2px solid #3b82f6; outline-offset: 2px; }
.box.hover { outline: 2px dashed rgba(59, 130, 246, 0.8); outline-offset: 2px; }
.mark { position: absolute; pointer-events: none; mix-blend-mode: multiply; }
.mark.open { background: rgba(250, 204, 21, 0.3); }
.mark.guessed { background: rgba(251, 146, 60, 0.22); }
.mark.focus { background: rgba(250, 204, 21, 0.65); }
.mark.resolved { background: rgba(156, 163, 175, 0.22); }
.mark.draft { background: rgba(59, 130, 246, 0.28); }
.mark.hover { background: rgba(59, 130, 246, 0.16); }
`;

interface Placed {
  mark: ThreadMark | null;
  resolution: Resolution;
  state: AnchorState;
  range: Range | null;
  element: Element | null;
}

type HighlightCtor = new (...ranges: Range[]) => unknown;
interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

export interface CommentLayerOptions {
  post: (message: BridgeToParent) => void;
  layoutVersion: () => number;
  bumpLayoutVersion: () => void;
}

export interface CommentLayer {
  setThreads(threads: ThreadMark[]): void;
  setDraft(anchor: HtmlAnchor | null): void;
  setFocused(id: string | null, reveal: boolean): void;
  setCommentMode(on: boolean): void;
  captureSelection(): void;
  describeLegacy(ids: string[]): void;
  describeCurrent(id: string): void;
  /** Start resolving (after the parent's init: until then nobody listens). */
  start(): void;
  cleanup(): void;
}

function toRect(r: DOMRect | { left: number; top: number; width: number; height: number }): Rect {
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

function roundRect(r: Rect | null): string {
  return r ? `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)}` : '-';
}

export function installCommentLayer(win: Window & typeof globalThis, options: CommentLayerOptions): CommentLayer {
  const doc = win.document;
  let started = false;
  let threads: ThreadMark[] = [];
  let threadsKey = '';
  let draft: HtmlAnchor | null = null;
  let focusedId: string | null = null;
  let commentMode = false;
  let placed = new Map<string, Placed>();
  let draftPlaced: Placed | null = null;
  let hover: { range: Range | null; element: Element | null } | null = null;
  let lastMutationAt = Date.now();
  // The text index is rebuilt only after the DOM changed (hover and capture
  // ask for it on every pointer move).
  let cachedIndex: TextIndex | null = null;
  const pageIndex = (): TextIndex => {
    cachedIndex ??= buildTextIndex(doc.body);
    return cachedIndex;
  };
  // Threads whose drifted anchor this page load already offered for refresh:
  // text that keeps changing (a clock, per-viewer content) must not turn into
  // a stream of writes.
  const refreshOffered = new Set<string>();
  const installedAt = Date.now();
  let lastPostedKey = '';
  let resolveTimer: number | null = null;
  let settleTimer: number | null = null;
  let drawFrame: number | null = null;
  let hoverFrame: number | null = null;
  let selectionTimer: number | null = null;
  let selectionReported = false;
  let suppressClick = false;
  let pendingPointer: { x: number; y: number } | null = null;

  const registry = (win.CSS as unknown as { highlights?: HighlightRegistry } | undefined)?.highlights;
  const Highlight = (win as unknown as { Highlight?: HighlightCtor }).Highlight;
  const nativeHighlights = !!registry && typeof Highlight === 'function';

  // ---- overlay host (after <body>, shadow-rooted) ----------------------
  let host: HTMLElement | null = null;
  let shadow: ShadowRoot | null = null;
  let layer: HTMLElement | null = null;

  function ensureHost(): HTMLElement | null {
    if (host?.isConnected && layer) return layer;
    const root = doc.documentElement;
    if (!root) return null;
    host = doc.createElement('div');
    host.setAttribute(HOST_ATTRIBUTE, '');
    host.setAttribute(OVERLAY_ATTRIBUTE, '');
    host.style.cssText = 'position:absolute !important;top:0 !important;left:0 !important;width:0 !important;'
      + 'height:0 !important;margin:0 !important;padding:0 !important;border:0 !important;'
      + 'z-index:2147483647 !important;pointer-events:none !important;display:block !important;';
    shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : null;
    const style = doc.createElement('style');
    style.textContent = SHADOW_CSS;
    layer = doc.createElement('div');
    (shadow ?? host).append(style, layer);
    root.appendChild(host);
    layer.addEventListener('click', onBadgeClick);
    return layer;
  }

  function ensureHighlightStyle(): void {
    if (doc.getElementById(HIGHLIGHT_STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = HIGHLIGHT_STYLE_ID;
    style.setAttribute(OVERLAY_ATTRIBUTE, '');
    style.textContent = HIGHLIGHT_CSS;
    (doc.head ?? doc.documentElement)?.appendChild(style);
  }

  function onBadgeClick(event: Event): void {
    const target = event.target as HTMLElement | null;
    const id = target?.closest?.('[data-thread]')?.getAttribute('data-thread');
    if (!id || id === DRAFT_ID) return;
    event.stopPropagation();
    options.post({ type: 'thread-clicked', payload: { id } });
  }

  // ---- resolution -----------------------------------------------------
  /** The DOM has been quiet long enough to trust what it shows. */
  function isQuiet(): boolean {
    const now = Date.now();
    return doc.readyState === 'complete' && now - lastMutationAt >= SETTLE_MS && now - installedAt >= SETTLE_MS;
  }

  function isSettled(): boolean {
    const now = Date.now();
    if (now - installedAt >= MAX_SETTLE_MS) return true; // a page that never stops changing
    return doc.readyState === 'complete' && now - lastMutationAt >= SETTLE_MS && now - installedAt >= SETTLE_MS;
  }

  function visibleRect(range: Range | null, element: Element | null): { rect: Rect | null; hidden: boolean } {
    const rects = range ? Array.from(range.getClientRects()) : element ? Array.from(element.getClientRects()) : [];
    const box = rects.find(r => r.width > 0 || r.height > 0);
    const startEl = range
      ? (range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement)
      : element;
    const style = startEl ? win.getComputedStyle(startEl) : null;
    if (box && style?.visibility !== 'hidden') {
      const whole = range ? range.getBoundingClientRect() : element!.getBoundingClientRect();
      return { rect: toRect(whole.width || whole.height ? whole : box), hidden: false };
    }
    // Not visible: place the card by the nearest visible ancestor.
    for (let cur = startEl?.parentElement ?? null; cur && cur !== doc.documentElement; cur = cur.parentElement) {
      const r = cur.getBoundingClientRect();
      if ((r.width > 0 || r.height > 0) && win.getComputedStyle(cur).visibility !== 'hidden') {
        return { rect: toRect({ left: r.left, top: r.top, width: r.width, height: 0 }), hidden: true };
      }
    }
    return { rect: null, hidden: true };
  }

  function place(mark: ThreadMark | null, anchor: HtmlAnchor, index: TextIndex): Placed {
    const resolution = resolveAnchor(doc, index, anchor);
    let range: Range | null = null;
    let element: Element | null = null;
    if (resolution.kind === 'text') range = rangeFor(index, resolution.start, resolution.end);
    else if (resolution.kind === 'element') element = resolution.element;
    let state: AnchorState = resolution.state;
    if (state !== 'orphaned' && !range && !element) state = 'orphaned';
    return { mark, resolution, state, range, element };
  }

  function placementOf(id: string, p: Placed, index: TextIndex): ThreadPlacement {
    if (p.state === 'orphaned') return { id, state: 'orphaned', rect: null, textOffset: null };
    const visible = visibleRect(p.range, p.element);
    const hidden = visible.hidden;
    let rect = visible.rect;
    // A pin sits at a point of its element: cards line up with the badge,
    // not with the top of a possibly huge element.
    if (!hidden && p.element && rect && p.mark?.anchor.kind === 'element') {
      const pt = pointIn(p.element, p.mark.anchor.point);
      rect = { x: pt.x - 8, y: pt.y - 8, w: 16, h: 16 };
    }
    const state: AnchorState = hidden ? 'hidden' : p.state;
    const res = p.resolution;
    let textOffset: number | null = null;
    let currentQuote: string | undefined;
    let refreshed: HtmlAnchor | undefined;
    // Offer a fresh anchor for a confidently found but drifted target, once
    // per page load and only when the page is quiet.
    const mayRefresh = res.kind !== 'none' && res.drifted && res.state === 'anchored' && !refreshOffered.has(id) && isQuiet();
    if (res.kind === 'text') {
      textOffset = res.start;
      if (res.drifted || res.state === 'guessed') currentQuote = index.text.slice(res.start, res.end);
      if (mayRefresh && res.context >= 0.75) refreshed = describeSpan(index, res.start, res.end, win.innerWidth) ?? undefined;
    } else if (res.kind === 'element' && p.element) {
      const range = doc.createRange();
      range.selectNode(p.element);
      textOffset = offsetOfPoint(index, range.startContainer, range.startOffset);
      if (mayRefresh && p.mark?.anchor.kind === 'element') {
        refreshed = describeElement(p.element, pointIn(p.element, p.mark.anchor.point), win.innerWidth);
      }
    }
    if (refreshed) refreshOffered.add(id);
    return {
      id,
      state,
      rect,
      textOffset,
      ...(currentQuote !== undefined ? { currentQuote } : {}),
      ...(refreshed ? { refreshed } : {}),
    };
  }

  function pointIn(el: Element, pct: { x: number; y: number }): { x: number; y: number } {
    const r = el.getBoundingClientRect();
    return { x: r.left + (r.width * pct.x) / 100, y: r.top + (r.height * pct.y) / 100 };
  }

  function resolveAll(): void {
    resolveTimer = null;
    if (!started || !doc.body) return;
    const index = pageIndex();
    const next = new Map<string, Placed>();
    for (const mark of threads) next.set(mark.id, place(mark, mark.anchor, index));
    placed = next;
    draftPlaced = draft ? place(null, draft, index) : null;
    const settled = isSettled();
    const placements = threads.map(mark => placementOf(mark.id, placed.get(mark.id)!, index));
    const draftPlacement = draftPlaced ? placementOf(DRAFT_ID, draftPlaced, index) : null;
    const key = JSON.stringify({
      settled,
      p: [...placements, ...(draftPlacement ? [draftPlacement] : [])].map(p => [
        p.id, p.state, roundRect(p.rect), p.textOffset, p.currentQuote ?? '', p.refreshed ? 1 : 0,
      ]),
      y: Math.round(win.scrollY),
    });
    draw();
    if (key !== lastPostedKey) {
      lastPostedKey = key;
      // Scroll messages echo this version; it changes only with what the
      // parent was told, or the parent would drop every later scroll.
      options.bumpLayoutVersion();
      options.post({
        type: 'threads-resolved',
        payload: {
          placements,
          draft: draftPlacement,
          baselineScrollY: win.scrollY,
          layoutVersion: options.layoutVersion(),
          settled,
        },
      });
    }
    if (!settled) scheduleSettleCheck();
  }

  /** Throttled, not debounced: a page that mutates constantly (a clock, an
   *  animation) must still get its comments placed. */
  let resolveDue = 0;
  function scheduleResolve(delay = MUTATION_DEBOUNCE_MS): void {
    if (!started) return;
    const due = Date.now() + delay;
    if (resolveTimer !== null) {
      if (due >= resolveDue) return;
      win.clearTimeout(resolveTimer);
    }
    resolveDue = due;
    resolveTimer = win.setTimeout(resolveAll, delay);
  }

  function scheduleSettleCheck(): void {
    if (settleTimer !== null) return;
    const wait = Math.max(50, SETTLE_MS - (Date.now() - lastMutationAt));
    settleTimer = win.setTimeout(() => {
      settleTimer = null;
      if (isSettled()) resolveAll();
      else scheduleSettleCheck();
    }, wait);
  }

  // ---- drawing --------------------------------------------------------
  function scheduleDraw(): void {
    if (drawFrame !== null) return;
    drawFrame = win.requestAnimationFrame(() => {
      drawFrame = null;
      draw();
    });
  }

  function draw(): void {
    const root = ensureHost();
    if (!root) return;
    if (nativeHighlights) ensureHighlightStyle();
    const groups: Record<keyof typeof HIGHLIGHTS, Range[]> = { open: [], guessed: [], focus: [], resolved: [], draft: [], hover: [] };
    const boxes: Array<{ cls: string; rect: DOMRect }> = [];
    const badges: Array<{ id: string; label: string; cls: string; x: number; y: number }> = [];
    const sx = win.scrollX;
    const sy = win.scrollY;

    for (const [id, p] of placed) {
      if (!p.mark || p.state === 'orphaned') continue;
      const focused = id === focusedId;
      // Resolved threads are only sent while "Show resolved" is on: grey.
      const group = focused ? 'focus' : p.mark.resolved ? 'resolved' : p.state === 'guessed' ? 'guessed' : 'open';
      const cls = `${focused ? 'focused' : ''} ${p.state === 'guessed' ? 'guessed' : ''} ${p.mark.resolved ? 'resolved' : ''}`.trim();
      if (p.range) {
        groups[group].push(p.range);
        const rects = Array.from(p.range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
        const last = rects[rects.length - 1];
        if (last) badges.push({ id, label: String(p.mark.order), cls, x: last.right + sx, y: last.top + sy });
      } else if (p.element) {
        const r = p.element.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const anchor = p.mark.anchor;
        const pt = anchor.kind === 'element' ? anchor.point : { x: 50, y: 50 };
        badges.push({
          id, label: String(p.mark.order), cls: `pin ${cls}`,
          x: r.left + (r.width * pt.x) / 100 + sx, y: r.top + (r.height * pt.y) / 100 + sy,
        });
        if (focused) boxes.push({ cls: 'focus', rect: r });
      }
    }
    if (draftPlaced && draftPlaced.state !== 'orphaned') {
      if (draftPlaced.range) {
        groups.draft.push(draftPlaced.range);
        const rects = Array.from(draftPlaced.range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
        const last = rects[rects.length - 1];
        if (last) badges.push({ id: DRAFT_ID, label: '+', cls: 'draft', x: last.right + sx, y: last.top + sy });
      } else if (draftPlaced.element) {
        const r = draftPlaced.element.getBoundingClientRect();
        boxes.push({ cls: 'draft', rect: r });
        const pt = draft?.kind === 'element' ? draft.point : { x: 50, y: 50 };
        badges.push({ id: DRAFT_ID, label: '+', cls: 'pin draft', x: r.left + (r.width * pt.x) / 100 + sx, y: r.top + (r.height * pt.y) / 100 + sy });
      }
    }
    if (hover?.range) groups.hover.push(hover.range);
    else if (hover?.element) boxes.push({ cls: 'hover', rect: hover.element.getBoundingClientRect() });

    const frag = doc.createDocumentFragment();
    if (nativeHighlights) {
      for (const [key, name] of Object.entries(HIGHLIGHTS) as Array<[keyof typeof HIGHLIGHTS, string]>) {
        if (groups[key].length > 0) registry!.set(name, new Highlight!(...groups[key]));
        else registry!.delete(name);
      }
    } else {
      for (const [key, ranges] of Object.entries(groups) as Array<[keyof typeof HIGHLIGHTS, Range[]]>) {
        for (const range of ranges) {
          for (const r of Array.from(range.getClientRects())) {
            if (r.width === 0 || r.height === 0) continue;
            const mark = doc.createElement('div');
            mark.className = `mark ${key}`;
            mark.style.cssText = `left:${r.left + sx}px;top:${r.top + sy}px;width:${r.width}px;height:${r.height}px;`;
            frag.appendChild(mark);
          }
        }
      }
    }
    for (const box of boxes) {
      const el = doc.createElement('div');
      el.className = `box ${box.cls}`;
      el.style.cssText = `left:${box.rect.left + sx}px;top:${box.rect.top + sy}px;width:${box.rect.width}px;height:${box.rect.height}px;`;
      frag.appendChild(el);
    }
    // Keep badges inside the page width: one past the right edge would make
    // the page scroll sideways (and be reported as too wide).
    const maxX = sx + (doc.documentElement?.clientWidth || win.innerWidth) - 20;
    const taken: Array<{ x: number; y: number }> = [];
    for (const badge of badges) {
      badge.x = Math.min(badge.x, maxX);
      // Several threads on one target: line their badges up side by side.
      while (taken.some(t => Math.abs(t.x - badge.x) < 16 && Math.abs(t.y - badge.y) < 12)) badge.x += 17;
      taken.push({ x: badge.x, y: badge.y });
      const el = doc.createElement(badge.id === DRAFT_ID ? 'span' : 'button');
      el.className = `badge ${badge.cls}`;
      el.setAttribute('data-thread', badge.id);
      if (badge.id !== DRAFT_ID) {
        el.setAttribute('type', 'button');
        el.setAttribute('aria-label', `Comment ${badge.label}`);
      }
      el.textContent = badge.label;
      el.style.left = `${badge.x}px`;
      el.style.top = `${badge.y}px`;
      frag.appendChild(el);
    }
    root.replaceChildren(frag);
  }

  // ---- capture --------------------------------------------------------
  function caretAt(x: number, y: number): { node: Node; offset: number } | null {
    const d = doc as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    const pos = d.caretPositionFromPoint?.(x, y);
    if (pos) return { node: pos.offsetNode, offset: pos.offset };
    const range = doc.caretRangeFromPoint?.(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }

  /** Is (x, y) actually over the text near `offset` (not blank space beside
   *  it, where caret APIs still return the closest text)? */
  function overText(node: Text, offset: number, x: number, y: number): boolean {
    const range = doc.createRange();
    const from = Math.max(0, Math.min(offset, node.length) - 1);
    range.setStart(node, from);
    range.setEnd(node, Math.min(node.length, from + 2));
    const slack = 3;
    return Array.from(range.getClientRects()).some(r => (
      x >= r.left - slack && x <= r.right + slack && y >= r.top - slack && y <= r.bottom + slack
    ));
  }

  interface Target {
    anchor: HtmlAnchor;
    rect: Rect;
    via: CaptureVia;
    range: Range | null;
    element: Element | null;
  }

  /** Media, controls and modest boxes can be pinned; a click on the blank
   *  space of a large layout container (main, a page wrapper) pins nothing. */
  function isPinnable(el: Element): boolean {
    if (/^(img|svg|canvas|video|audio|picture|iframe|object|embed|button|a|input|select|textarea|label|summary)$/i.test(el.tagName)) return true;
    const r = el.getBoundingClientRect();
    const viewport = win.innerWidth * win.innerHeight;
    return r.width * r.height <= viewport * 0.25;
  }

  function targetAt(x: number, y: number): Target | null {
    const hit = doc.elementFromPoint(x, y);
    if (!hit || hit === host || !isPageContent(hit)) return null;
    const caret = caretAt(x, y);
    if (caret && caret.node.nodeType === 3 && overText(caret.node as Text, caret.offset, x, y)) {
      const parent = caret.node.parentElement;
      if (parent && isPageContent(parent) && !isSkippedElement(parent)) {
        const index = pageIndex();
        let at = offsetOfPoint(index, caret.node, caret.offset);
        if (at >= index.text.length) at = index.text.length - 1;
        const span = at >= 0 ? clickSpan(index, at) : null;
        const anchor = span ? describeSpan(index, span.start, span.end, win.innerWidth) : null;
        const range = span ? rangeFor(index, span.start, span.end) : null;
        if (anchor && range) return { anchor, rect: toRect(range.getBoundingClientRect()), via: 'click', range, element: null };
      }
    }
    const element = pinTarget(hit);
    if (!isPinnable(element)) return null;
    return {
      anchor: describeElement(element, { x, y }, win.innerWidth),
      rect: toRect(element.getBoundingClientRect()),
      via: 'element',
      range: null,
      element,
    };
  }

  function selectionTarget(): Target | null {
    const selection = win.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const el = container.nodeType === 1 ? container as Element : container.parentElement;
    if (!el || !isPageContent(el)) return null;
    const index = pageIndex();
    const start = offsetOfPoint(index, range.startContainer, range.startOffset);
    const end = offsetOfPoint(index, range.endContainer, range.endOffset);
    const anchor = describeSpan(index, start, end, win.innerWidth);
    if (!anchor || anchor.kind !== 'text') return null;
    const span = rangeFor(index, anchor.position.start, anchor.position.end);
    return { anchor, rect: toRect((span ?? range).getBoundingClientRect()), via: 'selection', range: span, element: null };
  }

  function warningFor(anchor: HtmlAnchor): string | undefined {
    if (anchor.kind === 'text' && anchor.ordinal !== undefined) {
      return 'This text repeats on the page with nothing unique around it, so the comment may jump to another copy '
        + 'if the page changes. Commenting on a longer passage, or giving the section an id, keeps it in place.';
    }
    return undefined;
  }

  function emitCapture(target: Target): void {
    const warning = warningFor(target.anchor);
    const payload: AnchorCapture = { anchor: target.anchor, rect: target.rect, via: target.via, ...(warning ? { warning } : {}) };
    hover = null;
    win.getSelection()?.removeAllRanges();
    options.post({ type: 'anchor-captured', payload });
    scheduleDraw();
  }

  // ---- comment-mode input interception -------------------------------
  function inOverlay(target: EventTarget | null): boolean {
    return !!host && target instanceof win.Node && (target === host || host.contains(target));
  }

  const swallow = (event: Event): void => {
    if (!commentMode || inOverlay(event.target)) return;
    event.stopImmediatePropagation();
    // Text selection needs mousedown's default action, but controls must not
    // open (a <select>'s menu opens on mousedown) or take focus.
    const target = event.target instanceof win.Element ? event.target : null;
    if ((event.type === 'mousedown' || event.type === 'pointerdown' || event.type === 'touchstart')
      && target?.closest('select, input, textarea, button, label, summary, [contenteditable=""], [contenteditable="true"]')) {
      event.preventDefault();
    }
  };

  const onPointerMove = (event: PointerEvent | MouseEvent): void => {
    if (!commentMode) return;
    pendingPointer = { x: event.clientX, y: event.clientY };
    if (hoverFrame !== null) return;
    hoverFrame = win.requestAnimationFrame(() => {
      hoverFrame = null;
      if (!pendingPointer || !commentMode) return;
      const selection = win.getSelection();
      if (selection && !selection.isCollapsed) return; // dragging a selection
      const target = targetAt(pendingPointer.x, pendingPointer.y);
      hover = target ? { range: target.range, element: target.element } : null;
      draw();
    });
  };

  const onMouseUp = (event: MouseEvent): void => {
    if (!commentMode || inOverlay(event.target)) return;
    event.stopImmediatePropagation();
    const target = selectionTarget();
    if (!target) return;
    suppressClick = true;
    win.setTimeout(() => { suppressClick = false; }, 0);
    emitCapture(target);
  };

  const onClick = (event: MouseEvent): void => {
    if (commentMode && !inOverlay(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (suppressClick) { suppressClick = false; return; }
      const target = selectionTarget() ?? targetAt(event.clientX, event.clientY);
      if (target) emitCapture(target);
      return;
    }
    if (!commentMode && !inOverlay(event.target)) clickOnHighlight(event.clientX, event.clientY);
  };

  /** Outside Comment mode a click on highlighted text focuses its thread
   *  (the page still gets the click). */
  function clickOnHighlight(x: number, y: number): void {
    const selection = win.getSelection();
    if (selection && !selection.isCollapsed) return;
    const caret = caretAt(x, y);
    if (!caret || caret.node.nodeType !== 3 || !overText(caret.node as Text, caret.offset, x, y)) return;
    for (const [id, p] of placed) {
      if (!p.range || p.mark?.resolved || p.state === 'orphaned') continue;
      try {
        if (p.range.isPointInRange(caret.node, caret.offset)) {
          options.post({ type: 'thread-clicked', payload: { id } });
          return;
        }
      } catch {
        // Point in another document fragment; not ours.
      }
    }
  }

  /** `C` toggles Comment mode from inside the page too (focus often sits in
   *  the frame), unless the user is typing or the page used the key. The
   *  page's handlers may run after this one, so look once dispatch is over. */
  const onShortcutKey = (event: KeyboardEvent): void => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
    if (event.key !== 'c' && event.key !== 'C') return;
    const target = event.target instanceof win.Element ? event.target : null;
    if (target?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
    win.setTimeout(() => {
      if (!event.defaultPrevented) options.post({ type: 'shortcut', payload: { key: 'c' } });
    }, 0);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!commentMode) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      options.post({ type: 'comment-mode-exit', payload: {} });
    }
  };

  const onSelectionChange = (): void => {
    if (selectionTimer !== null) win.clearTimeout(selectionTimer);
    selectionTimer = win.setTimeout(reportSelection, SELECTION_DEBOUNCE_MS);
  };

  function reportSelection(): void {
    selectionTimer = null;
    if (!started) return;
    const selection = win.getSelection();
    const range = selection && selection.rangeCount > 0 && !selection.isCollapsed ? selection.getRangeAt(0) : null;
    const container = range?.commonAncestorContainer ?? null;
    const el = container ? (container.nodeType === 1 ? container as Element : container.parentElement) : null;
    const usable = !!range && !!el && isPageContent(el) && range.toString().trim().length > 0;
    if (usable) {
      selectionReported = true;
      options.post({ type: 'selection-changed', payload: { rect: toRect(range!.getBoundingClientRect()) } });
    } else if (selectionReported) {
      selectionReported = false;
      options.post({ type: 'selection-changed', payload: { rect: null } });
    }
  }

  // ---- page observation -----------------------------------------------
  const observer = new win.MutationObserver(records => {
    if (records.every(r => inOverlay(r.target))) return;
    lastMutationAt = Date.now();
    cachedIndex = null;
    scheduleResolve();
  });
  let observing = false;
  function observeBody(): void {
    if (observing || !doc.body) return;
    observer.observe(doc.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['id', 'class', 'style', 'hidden', 'open', 'data-lens-id'] });
    observing = true;
  }
  const resizeObserver = new win.ResizeObserver(() => scheduleResolve(30));
  const onResize = () => scheduleResolve(30);
  const onToggle = () => scheduleResolve(30);
  const onScroll = (event: Event) => {
    // Nested scroll containers move highlights without a window scroll.
    if (event.target !== doc && event.target !== win) scheduleResolve(30);
    else if (selectionReported) onSelectionChange();
  };
  const onLoad = () => {
    lastMutationAt = Date.now();
    cachedIndex = null;
    observeBody();
    scheduleResolve(30);
  };
  const onFonts = () => scheduleResolve(30);

  win.addEventListener('click', onClick, true);
  win.addEventListener('mouseup', onMouseUp, true);
  for (const type of ['mousedown', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'dblclick', 'auxclick', 'contextmenu']) {
    win.addEventListener(type, swallow, true);
  }
  win.addEventListener('pointermove', onPointerMove, true);
  win.addEventListener('keydown', onKeyDown, true);
  win.addEventListener('keydown', onShortcutKey);
  win.addEventListener('resize', onResize);
  win.addEventListener('load', onLoad);
  doc.addEventListener('selectionchange', onSelectionChange);
  doc.addEventListener('toggle', onToggle, true);
  doc.addEventListener('scroll', onScroll, true);
  doc.addEventListener('DOMContentLoaded', onLoad);
  doc.fonts?.addEventListener?.('loadingdone', onFonts);

  function startObservers(): void {
    observeBody();
    if (doc.body) resizeObserver.observe(doc.body);
  }

  function markKey(list: ThreadMark[]): string {
    return JSON.stringify(list.map(t => [t.id, t.anchor, t.resolved]));
  }

  function revealFocused(): void {
    const p = focusedId ? placed.get(focusedId) : null;
    if (!p || p.state === 'orphaned') return;
    let rect: { top: number; bottom: number } | null = p.range?.getBoundingClientRect() ?? null;
    if (!rect && p.element && p.mark?.anchor.kind === 'element') {
      const pt = pointIn(p.element, p.mark.anchor.point);
      rect = { top: pt.y - 10, bottom: pt.y + 10 };
    }
    if (!rect) return;
    if (rect.top >= 0 && rect.bottom <= win.innerHeight) return;
    if (p.range) {
      p.range.startContainer.parentElement?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    } else {
      win.scrollTo({ top: win.scrollY + rect.top - win.innerHeight / 2, behavior: 'smooth' });
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      cachedIndex = null;
      startObservers();
      scheduleResolve(0);
    },
    setThreads(next) {
      const key = markKey(next);
      threads = next;
      if (key === threadsKey) {
        // Only badge numbers changed.
        for (const mark of next) {
          const p = placed.get(mark.id);
          if (p) p.mark = mark;
        }
        scheduleDraw();
        return;
      }
      threadsKey = key;
      scheduleResolve(0);
    },
    setDraft(anchor) {
      draft = anchor;
      scheduleResolve(0);
    },
    setFocused(id, reveal) {
      focusedId = id;
      draw();
      if (reveal) revealFocused();
    },
    setCommentMode(on) {
      commentMode = on;
      doc.documentElement?.classList.toggle('lens-commenting', on);
      if (on) ensureHighlightStyle();
      if (!on) hover = null;
      scheduleDraw();
    },
    captureSelection() {
      const target = selectionTarget();
      if (target) emitCapture(target);
    },
    describeLegacy(ids) {
      const anchors: Record<string, HtmlAnchor | null> = {};
      const index = doc.body ? pageIndex() : null;
      const wanted = new Set(ids);
      const found = new Map<string, Comment>();
      if (doc.body) {
        const walker = doc.createTreeWalker(doc.body, 0x80 /* SHOW_COMMENT */);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const m = (n as Comment).data.match(/^lens-comment\s+(\{[\s\S]*\})$/);
          if (!m) continue;
          try {
            const id = (JSON.parse(m[1]) as { id?: unknown }).id;
            if (typeof id === 'string' && wanted.has(id) && !found.has(id)) found.set(id, n as Comment);
          } catch {
            // not a marker
          }
        }
      }
      for (const id of ids) {
        const node = found.get(id);
        anchors[id] = null;
        if (!node || !index || !node.parentNode || index.text.length === 0) continue;
        const parent = node.parentNode;
        const at = offsetOfPoint(index, parent, Array.prototype.indexOf.call(parent.childNodes, node) + 1);
        const span = clickSpan(index, Math.min(at, index.text.length - 1));
        anchors[id] = span ? describeSpan(index, span.start, span.end) : null;
      }
      options.post({ type: 'legacy-described', payload: { anchors } });
    },
    describeCurrent(id) {
      const mark = threads.find(t => t.id === id);
      let anchor: HtmlAnchor | null = null;
      if (mark && doc.body) {
        // Resolve again: the page may have changed since the card was drawn.
        const index = pageIndex();
        const res = resolveAnchor(doc, index, mark.anchor);
        if (res.kind === 'text') anchor = describeSpan(index, res.start, res.end, win.innerWidth);
        else if (res.kind === 'element' && mark.anchor.kind === 'element') {
          anchor = describeElement(res.element, pointIn(res.element, mark.anchor.point), win.innerWidth);
        }
      }
      options.post({ type: 'current-described', payload: { id, anchor } });
    },
    cleanup() {
      started = false;
      win.removeEventListener('click', onClick, true);
      win.removeEventListener('mouseup', onMouseUp, true);
      for (const type of ['mousedown', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'dblclick', 'auxclick', 'contextmenu']) {
        win.removeEventListener(type, swallow, true);
      }
      win.removeEventListener('pointermove', onPointerMove, true);
      win.removeEventListener('keydown', onKeyDown, true);
      win.removeEventListener('keydown', onShortcutKey);
      win.removeEventListener('resize', onResize);
      win.removeEventListener('load', onLoad);
      doc.removeEventListener('selectionchange', onSelectionChange);
      doc.removeEventListener('toggle', onToggle, true);
      doc.removeEventListener('scroll', onScroll, true);
      doc.removeEventListener('DOMContentLoaded', onLoad);
      doc.fonts?.removeEventListener?.('loadingdone', onFonts);
      observer.disconnect();
      resizeObserver.disconnect();
      for (const timer of [resolveTimer, settleTimer, selectionTimer]) if (timer !== null) win.clearTimeout(timer);
      for (const frame of [drawFrame, hoverFrame]) if (frame !== null) win.cancelAnimationFrame(frame);
      if (nativeHighlights) for (const name of Object.values(HIGHLIGHTS)) registry!.delete(name);
      doc.getElementById(HIGHLIGHT_STYLE_ID)?.remove();
      doc.documentElement?.classList.remove('lens-commenting');
      host?.remove();
      host = null;
      layer = null;
      shadow = null;
    },
  };
}
