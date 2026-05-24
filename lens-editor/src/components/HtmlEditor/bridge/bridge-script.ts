import {
  validateEnvelope,
  type Envelope,
  type BridgeToParent,
  type CommentRect,
  type CommentSummary,
  type Fingerprint,
  type ParentToBridge,
  type PreviewScrollState,
  type PreviewUiState,
} from './protocol';

// A) Monotonic layoutVersion bumped on each rebuildDots call
let layoutVersion = 0;
function bumpLayoutVersion(): void { layoutVersion++; }

export const OVERLAY_ROOT_ID = 'lens-comment-overlay-root';
const OVERLAY_ROOT_MARKER = 'v1';
const INLINE_MARKER_ATTRIBUTE = 'data-lens-inline-comment-marker';
const INLINE_MARKER_STYLE_ID = 'lens-comment-inline-marker-style';
const overlayRoots = new WeakMap<Document, HTMLDivElement>();
const BRIDGE_STATE_KEY = '__lensBridgeInstallState';

interface BridgeInstallState {
  cleanup: () => void;
}

type BridgeWindow = Window & typeof globalThis & {
  [BRIDGE_STATE_KEY]?: BridgeInstallState;
};

function isCommentSummary(value: unknown): value is CommentSummary {
  if (typeof value !== 'object' || value === null) return false;
  const summary = value as Partial<CommentSummary>;
  return typeof summary.id === 'string'
    && typeof summary.body === 'string'
    && typeof summary.replies === 'number';
}

function readCommentsFromInit(message: ParentToBridge): CommentSummary[] | null {
  if (message.type !== 'init') return null;
  return readCommentsPayload(message.payload);
}

function readCommentsPayload(payload: unknown): CommentSummary[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const comments = (payload as { comments?: unknown }).comments;
  if (!Array.isArray(comments) || !comments.every(isCommentSummary)) return null;
  return comments;
}

function readStringPayloadField(payload: unknown, field: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : null;
}

function isEmptyObjectPayload(payload: unknown): payload is Record<string, never> {
  return typeof payload === 'object'
    && payload !== null
    && !Array.isArray(payload)
    && Object.keys(payload).length === 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function captureUiState(doc: Document): PreviewUiState {
  const details = Array.from(doc.querySelectorAll('details')) as HTMLDetailsElement[];
  return {
    details: details
      .map((node, index) => ({ path: [index], open: node.open }))
      .filter(item => item.open),
  };
}

function isPreviewUiState(value: unknown): value is PreviewUiState {
  if (!isObject(value) || !Array.isArray(value.details)) return false;
  return value.details.every((item) => {
    if (!isObject(item) || !Array.isArray(item.path) || typeof item.open !== 'boolean') return false;
    return item.path.every(Number.isInteger);
  });
}

function restoreUiState(doc: Document, state: PreviewUiState): void {
  const details = Array.from(doc.querySelectorAll('details')) as HTMLDetailsElement[];
  for (const item of state.details) {
    const index = item.path[0];
    if (!Number.isInteger(index)) continue;
    const node = details[index];
    if (!node) continue;
    node.open = item.open;
  }
}

export interface FoundComment {
  id: string;
  node: Comment;
}

export function findCommentNodes(root: Document | Element): FoundComment[] {
  const out: FoundComment[] = [];
  const doc = root.ownerDocument ?? (root as Document);
  const view = doc.defaultView;
  const showComment = view?.NodeFilter.SHOW_COMMENT ?? NodeFilter.SHOW_COMMENT;
  const rootNode = root.nodeType === doc.DOCUMENT_NODE ? doc.body : root;
  const walker = doc.createTreeWalker(rootNode, showComment);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const data = (n as Comment).data;
    const m = data.match(/^lens-comment\s+(\{[\s\S]*\})$/);
    if (!m) continue;
    try {
      const payload = JSON.parse(m[1]) as { id?: string };
      if (payload.id) out.push({ id: payload.id, node: n as Comment });
    } catch {
      // skip
    }
  }
  return out;
}

function isUsableRenderedElement(el: Element): boolean {
  if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return false;
  if (el.hasAttribute('hidden')) return false;

  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (style?.display === 'none' || style?.visibility === 'hidden') return false;

  const rect = el.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

function isSkippableTextContainer(el: Element | null): boolean {
  if (!el) return true;
  return el.tagName === 'SCRIPT'
    || el.tagName === 'STYLE'
    || el.tagName === 'TEXTAREA'
    || el.tagName === 'TITLE'
    || el.hasAttribute('data-lens-overlay')
    || el.hasAttribute(INLINE_MARKER_ATTRIBUTE);
}

function ensureInlineMarkerStyle(doc: Document): void {
  if (doc.getElementById(INLINE_MARKER_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = INLINE_MARKER_STYLE_ID;
  style.textContent = `
.lens-comment-inline-marker[${INLINE_MARKER_ATTRIBUTE}="true"] {
  appearance: none !important;
  box-sizing: border-box !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  vertical-align: middle !important;
  width: 1.15em !important;
  height: 1.15em !important;
  margin: 0 4px !important;
  padding: 0 !important;
  border: 2px solid #7c2d12 !important;
  border-radius: 999px !important;
  background: #dc2626 !important;
  color: white !important;
  font-family: Arial, sans-serif !important;
  font-size: 0.75em !important;
  font-weight: 700 !important;
  line-height: 1 !important;
  cursor: pointer !important;
  box-shadow: 0 0 0 2px white, 0 1px 3px rgba(0,0,0,0.35) !important;
  user-select: none !important;
}
.lens-comment-inline-marker[${INLINE_MARKER_ATTRIBUTE}="true"]:focus {
  outline: 2px solid #2563eb !important;
  outline-offset: 1px !important;
}
`;
  (doc.head ?? doc.documentElement).appendChild(style);
}

function makeInlineMarker(doc: Document, summary: CommentSummary): HTMLElement {
  const marker = doc.createElement('button');
  marker.className = 'lens-comment-inline-marker';
  marker.dataset.commentId = summary.id;
  marker.setAttribute(INLINE_MARKER_ATTRIBUTE, 'true');
  marker.setAttribute('type', 'button');
  marker.setAttribute('role', 'button');
  marker.tabIndex = 0;
  marker.setAttribute('aria-label', `Comment: ${summary.body.slice(0, 60)}`);
  marker.textContent = '!';
  return marker;
}

function renderInlineMarkers(doc: Document, comments: CommentSummary[]): Set<string> {
  ensureInlineMarkerStyle(doc);
  const byId = new Map(comments.map(comment => [comment.id, comment]));
  const found = new Set<string>();
  for (const existing of Array.from(doc.querySelectorAll<HTMLElement>(`[${INLINE_MARKER_ATTRIBUTE}="true"]`))) {
    const id = existing.dataset.commentId;
    if (id && byId.has(id)) found.add(id);
  }

  const view = doc.defaultView;
  const showText = view?.NodeFilter.SHOW_TEXT ?? NodeFilter.SHOW_TEXT;
  const walker = doc.createTreeWalker(doc.body, showText, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (isSkippableTextContainer(parent)) return NodeFilter.FILTER_REJECT;
      return node.textContent?.includes('[[@comment:') === true
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
  }

  const anchorPattern = /\[\[@comment:([^\]]+)\]\]/g;
  for (const node of nodes) {
    const text = node.textContent ?? '';
    anchorPattern.lastIndex = 0;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let changed = false;
    const fragment = doc.createDocumentFragment();
    while ((match = anchorPattern.exec(text)) !== null) {
      const summary = byId.get(match[1]);
      if (!summary) continue;
      if (match.index > lastIndex) fragment.append(text.slice(lastIndex, match.index));
      fragment.append(makeInlineMarker(doc, summary));
      found.add(summary.id);
      lastIndex = match.index + match[0].length;
      changed = true;
    }
    if (!changed) continue;
    if (lastIndex < text.length) fragment.append(text.slice(lastIndex));
    node.replaceWith(fragment);
  }
  return found;
}

export function findAnchorElement(commentNode: Comment): Element | null {
  const elementNode = commentNode.ownerDocument.defaultView?.Node.ELEMENT_NODE ?? Node.ELEMENT_NODE;
  let sib: Node | null = commentNode.nextSibling;
  while (sib) {
    if (sib.nodeType === elementNode && isUsableRenderedElement(sib as Element)) return sib as Element;
    sib = sib.nextSibling;
  }
  const parent = commentNode.parentElement;
  return parent && isUsableRenderedElement(parent) ? parent : null;
}

function ensureOverlayRoot(doc: Document): HTMLDivElement {
  const existing = overlayRoots.get(doc);
  if (existing?.ownerDocument === doc && existing.isConnected) return existing;

  const root = doc.createElement('div');
  let id = OVERLAY_ROOT_ID;
  for (let i = 1; doc.getElementById(id); i++) {
    id = `${OVERLAY_ROOT_ID}-${i}`;
  }
  root.id = id;
  root.setAttribute('data-lens-overlay', 'true');
  root.setAttribute('data-lens-overlay-root', OVERLAY_ROOT_MARKER);
  root.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483647;';
  doc.body.appendChild(root);
  overlayRoots.set(doc, root);
  return root;
}

function getOwnedOverlayRoot(doc: Document): HTMLDivElement | null {
  const existing = overlayRoots.get(doc);
  return existing?.ownerDocument === doc && existing.isConnected ? existing : null;
}

function removeOwnedOverlayRoot(doc: Document): void {
  const existing = overlayRoots.get(doc);
  existing?.remove();
  overlayRoots.delete(doc);
}

export function renderDots(doc: Document, comments: CommentSummary[]): { found: string[]; orphaned: string[]; rects: CommentRect[] } {
  const root = ensureOverlayRoot(doc);
  const inlineFound = renderInlineMarkers(doc, comments);
  const presentNodes = findCommentNodes(doc);
  const byId = new Map(presentNodes.map(c => [c.id, c]));
  const found: string[] = [];
  const orphaned: string[] = [];
  const rects: CommentRect[] = [];
  root.innerHTML = '';
  for (const summary of comments) {
    if (inlineFound.has(summary.id)) {
      found.push(summary.id);
      // Inline-matched comments: no separate anchor — omit from rects array
      continue;
    }
    const present = byId.get(summary.id);
    if (!present) { orphaned.push(summary.id); continue; }
    const anchor = findAnchorElement(present.node);
    if (!anchor) { orphaned.push(summary.id); continue; }
    const rect = anchor.getBoundingClientRect();
    const dot = doc.createElement('div');
    dot.className = 'lens-comment-dot';
    dot.dataset.commentId = summary.id;
    dot.setAttribute('data-lens-overlay', 'true');
    dot.style.cssText = `position:absolute;left:${rect.right - 8}px;top:${rect.top - 4}px;width:16px;height:16px;background:#fbbf24;border-radius:50%;pointer-events:auto;cursor:pointer;font-size:11px;line-height:16px;text-align:center;`;
    dot.textContent = '💬';
    dot.setAttribute('aria-label', `Comment: ${summary.body.slice(0, 60)}`);
    root.appendChild(dot);
    found.push(summary.id);
    rects.push({ id: summary.id, x: rect.x, y: rect.y, w: rect.width, h: rect.height });
  }
  return { found, orphaned, rects };
}

function describeAncestors(el: Element): Array<{ tag: string; index: number }> {
  const out: Array<{ tag: string; index: number }> = [];
  let cur: Element | null = el;
  while (cur && cur.tagName !== 'BODY') {
    const parent: Element | null = cur.parentElement;
    if (!parent) break;
    let index = 0;
    for (const sib of Array.from(parent.children)) {
      if (sib.tagName === cur.tagName) {
        if (sib === cur) break;
        index++;
      }
    }
    out.unshift({ tag: cur.tagName.toLowerCase(), index });
    cur = parent;
  }
  return out;
}

export function captureFingerprintAt(target: Element, clickX: number, clickY: number, charOffset: number): Fingerprint {
  const text = target.textContent ?? '';
  const before = text.slice(Math.max(0, charOffset - 30), charOffset);
  const after = text.slice(charOffset, charOffset + 30);
  const rect = target.getBoundingClientRect();
  return {
    before,
    after,
    tag: target.tagName.toLowerCase(),
    ancestorPath: describeAncestors(target),
    clickRect: { x: clickX, y: clickY, w: rect.width, h: rect.height },
  };
}

function textOffsetWithin(target: Element, node: Node, offset: number): number | null {
  const doc = target.ownerDocument;
  const view = doc.defaultView;
  if (!view || !target.contains(node)) return null;
  if (node.nodeType === view.Node.TEXT_NODE) {
    let total = 0;
    const walker = doc.createTreeWalker(target, view.NodeFilter.SHOW_TEXT);
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      if (current === node) return total + Math.max(0, Math.min(offset, current.textContent?.length ?? 0));
      total += current.textContent?.length ?? 0;
    }
    return null;
  }

  let total = 0;
  const children = Array.from(node.childNodes).slice(0, Math.max(0, offset));
  for (const child of children) total += child.textContent?.length ?? 0;
  return total;
}

function caretTextOffsetAtPoint(doc: Document, target: Element, x: number, y: number): number | null {
  const caretRangeFromPoint = doc.caretRangeFromPoint?.bind(doc);
  const range = caretRangeFromPoint?.(x, y);
  if (range) return textOffsetWithin(target, range.startContainer, range.startOffset);

  const caretPositionFromPoint = (
    doc as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    }
  ).caretPositionFromPoint?.bind(doc);
  const position = caretPositionFromPoint?.(x, y);
  if (!position) return null;
  return textOffsetWithin(target, position.offsetNode, position.offset);
}

function rangeStartTextOffset(target: Element, range: Range): number | null {
  return textOffsetWithin(target, range.startContainer, range.startOffset);
}

export function findProbe(doc: Document, token: string): { x: number; y: number; w: number; h: number } | null {
  if (!doc.body) return null;
  const showComment = doc.defaultView?.NodeFilter.SHOW_COMMENT ?? NodeFilter.SHOW_COMMENT;
  const walker = doc.createTreeWalker(doc.body, showComment);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if ((n as Comment).data === `lens-probe ${token}`) {
      const anchor = findAnchorElement(n as Comment);
      if (!anchor) return null;
      const rect = anchor.getBoundingClientRect();
      return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
    }
  }
  return null;
}

export function installBridge(win: Window & typeof globalThis): () => void {
  const bridgeWin = win as BridgeWindow;
  bridgeWin[BRIDGE_STATE_KEY]?.cleanup();

  const parent = win.parent;
  let nonce: string | null = null;
  let clickToPlaceArmed = false;
  let previousCursor: string | null = null;
  const doc = win.document;
  let dotRoot: HTMLDivElement | null = null;
  let pendingBodyRender = false;
  let selectionTimer: number | null = null;

  function postToParent(message: BridgeToParent): void {
    const env: Envelope<BridgeToParent> = { nonce: nonce ?? '', message };
    (parent.postMessage as (msg: unknown, targetOrigin?: string) => void)(env, '*');
  }

  function getBody(): HTMLElement | null {
    return doc.body;
  }

  function findInlineMarker(target: Element): HTMLElement | null {
    return target.closest<HTMLElement>(`.lens-comment-inline-marker[${INLINE_MARKER_ATTRIBUTE}="true"]`);
  }

  const markerClickListener = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof win.Element)) return;
    const dot = target.closest<HTMLElement>('.lens-comment-dot');
    const inlineMarker = findInlineMarker(target);
    const marker = dotRoot?.contains(dot) === true ? dot : inlineMarker;
    if (!marker) return;
    event.stopPropagation();
    const id = marker.dataset.commentId;
    if (id) postToParent({ type: 'dot-clicked', payload: { id } });
  };

  const markerKeyListener = (event: KeyboardEvent): void => {
    const target = event.target;
    if (!(target instanceof win.Element)) return;
    const marker = findInlineMarker(target);
    if (!marker) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    const id = marker.dataset.commentId;
    if (id) postToParent({ type: 'dot-clicked', payload: { id } });
  };

  function wireDotRoot(): void {
    const root = getOwnedOverlayRoot(doc);
    if (root === dotRoot) return;
    dotRoot?.removeEventListener('click', markerClickListener);
    dotRoot = root;
    dotRoot?.addEventListener('click', markerClickListener);
  }

  // E) Focus state for set-focused-comment
  let lastFocusedId: string | null = null;
  function applyFocusToDots(): void {
    const root = getOwnedOverlayRoot(doc);
    if (!root) return;
    root.querySelectorAll('[data-comment-focused]').forEach(el => {
      delete (el as HTMLElement).dataset.commentFocused;
    });
    if (lastFocusedId != null) {
      root.querySelectorAll<HTMLElement>('.lens-comment-dot').forEach(el => {
        if (el.dataset.commentId === lastFocusedId) el.dataset.commentFocused = '';
      });
    }
  }

  // C) rebuildDots posts the extended payload
  function rebuildDots(comments: CommentSummary[]): void {
    suppressRenderMutations = true;
    bumpLayoutVersion();
    const result = renderDots(doc, comments);
    const baselineScrollY = win.scrollY;
    postToParent({
      type: 'comments-rendered',
      payload: {
        found: result.found,
        orphaned: result.orphaned,
        rects: result.rects,
        baselineScrollY,
        layoutVersion,
      },
    });
    wireDotRoot();
    applyFocusToDots();
  }

  function rebuildDotsWhenBodyReady(comments: CommentSummary[]): void {
    if (!getBody() || doc.readyState === 'loading') {
      pendingBodyRender = true;
      return;
    }
    pendingBodyRender = false;
    rebuildDots(comments);
  }

  postToParent({ type: 'ready', payload: {} });

  let lastComments: CommentSummary[] = [];
  let scrollFrame: number | null = null;
  let restoreFrame: number | null = null;
  function readScrollState(): PreviewScrollState {
    const root = doc.documentElement;
    const body = doc.body;
    const scrollHeight = Math.max(
      root?.scrollHeight ?? 0,
      body?.scrollHeight ?? 0,
    );
    const scrollWidth = Math.max(
      root?.scrollWidth ?? 0,
      body?.scrollWidth ?? 0,
    );
    const viewportWidth = win.visualViewport?.width ?? win.innerWidth;
    const clientWidth = Number.isFinite(viewportWidth) && viewportWidth > 0
      ? viewportWidth
      : root?.clientWidth ?? 0;
    const viewportHeight = win.visualViewport?.height ?? win.innerHeight;
    const clientHeight = Number.isFinite(viewportHeight) && viewportHeight > 0
      ? viewportHeight
      : root?.clientHeight ?? 0;
    return {
      x: win.scrollX,
      y: win.scrollY,
      scrollWidth,
      clientWidth,
      scrollHeight,
      clientHeight,
      layoutVersion,
    };
  }
  const postScrollState = (): void => {
    postToParent({ type: 'scroll-state', payload: readScrollState() });
  };
  const scheduleScrollState = (): void => {
    if (scrollFrame !== null) return;
    scrollFrame = win.requestAnimationFrame(() => {
      scrollFrame = null;
      postScrollState();
    });
  };
  function restoreAfterStableLayout(readTarget: () => { x: number; y: number }): void {
    if (restoreFrame !== null) {
      win.cancelAnimationFrame(restoreFrame);
      restoreFrame = null;
    }
    let attempts = 0;
    let lastMaxY = -1;
    let stableFrames = 0;
    const step = (): void => {
      restoreFrame = null;
      attempts += 1;
      const state = readScrollState();
      const maxY = Math.max(0, state.scrollHeight - state.clientHeight);
      if (!getBody()) {
        restoreFrame = win.requestAnimationFrame(step);
        return;
      }
      if (maxY === lastMaxY) stableFrames += 1;
      else stableFrames = 0;
      lastMaxY = maxY;
      if (stableFrames < 2 && attempts < 20) {
        restoreFrame = win.requestAnimationFrame(step);
        return;
      }
      const target = readTarget();
      win.scrollTo(target.x, target.y);
      postScrollState();
    };
    restoreFrame = win.requestAnimationFrame(step);
  }
  function restoreScrollRatio(xRatio: number, yRatio: number): void {
    restoreAfterStableLayout(() => {
      const state = readScrollState();
      const maxX = Math.max(0, state.scrollWidth - state.clientWidth);
      const maxY = Math.max(0, state.scrollHeight - state.clientHeight);
      return {
        x: xRatio <= 0 ? 0 : xRatio * maxX,
        y: Math.max(0, Math.min(maxY, yRatio * maxY)),
      };
    });
  }
  function restoreScrollPosition(x: number, y: number): void {
    restoreAfterStableLayout(() => ({ x, y }));
  }

  const messageListener = (event: MessageEvent): void => {
    if (event.source !== parent) return;
    const data = event.data as Envelope<ParentToBridge>;
    if (nonce === null) {
      if (!data || typeof data !== 'object') return;
      const msg = data.message;
      if (!msg || msg.type !== 'init') return;
      if (typeof data.nonce !== 'string' || data.nonce.length === 0) return;
      const comments = readCommentsFromInit(msg);
      if (!comments) return;
      nonce = data.nonce;
      lastComments = comments;
      rebuildDotsWhenBodyReady(lastComments);
      return;
    }

    const msg = validateEnvelope<ParentToBridge>(data, nonce);
    if (!msg) return;
    switch (msg.type) {
      case 'enable-click-to-place':
        if (!isEmptyObjectPayload(msg.payload)) return;
        {
          const body = getBody();
          if (!clickToPlaceArmed) previousCursor = body?.style.cursor ?? null;
          clickToPlaceArmed = true;
          if (body) body.style.cursor = 'crosshair';
        }
        break;
      case 'disable-click-to-place':
        if (!isEmptyObjectPayload(msg.payload)) return;
        if (!clickToPlaceArmed) return;
        clickToPlaceArmed = false;
        {
          const body = getBody();
          if (body) body.style.cursor = previousCursor ?? '';
        }
        previousCursor = null;
        break;
      case 'set-comments': {
        const comments = readCommentsPayload(msg.payload);
        if (!comments) return;
        lastComments = comments;
        rebuildDotsWhenBodyReady(lastComments);
        break;
      }
      case 'highlight-comment': {
        const id = readStringPayloadField(msg.payload, 'id');
        if (!id) return;
        const el = Array.from(getOwnedOverlayRoot(doc)?.querySelectorAll<HTMLElement>('.lens-comment-dot') ?? [])
          .find(dot => dot.dataset.commentId === id);
        if (el) {
          el.animate?.(
            [{ transform: 'scale(1)' }, { transform: 'scale(1.5)' }, { transform: 'scale(1)' }],
            { duration: 400 },
          );
        }
        break;
      }
      case 'find-probe': {
        const token = readStringPayloadField(msg.payload, 'token');
        if (!token) return;
        const rect = getBody() ? findProbe(doc, token) : null;
        postToParent({ type: 'probe-found', payload: { token, rect } });
        break;
      }
      case 'restore-scroll': {
        if (!isObject(msg.payload)) return;
        const x = msg.payload.x;
        const y = msg.payload.y;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        restoreScrollPosition(x, y);
        break;
      }
      case 'restore-scroll-ratio': {
        if (!isObject(msg.payload)) return;
        const xRatio = msg.payload.xRatio;
        const yRatio = msg.payload.yRatio;
        if (!Number.isFinite(xRatio) || !Number.isFinite(yRatio)) return;
        restoreScrollRatio(Math.max(0, Math.min(1, xRatio)), Math.max(0, Math.min(1, yRatio)));
        break;
      }
      case 'capture-ui-state':
        if (!isEmptyObjectPayload(msg.payload)) return;
        postToParent({ type: 'ui-state', payload: captureUiState(doc) });
        break;
      case 'restore-ui-state':
        if (!isPreviewUiState(msg.payload)) return;
        restoreUiState(doc, msg.payload);
        break;
      case 'set-focused-comment': {
        const id = msg.payload?.id;
        if (id !== null && typeof id !== 'string') return;
        lastFocusedId = id;
        applyFocusToDots();
        break;
      }
      case 'init':
        break;
    }
  };
  win.addEventListener('message', messageListener);

  const clickListener = (event: MouseEvent): void => {
    if (!clickToPlaceArmed) return;
    const target = event.target;
    if (!(target instanceof win.Element)) return;
    const ownedOverlayRoot = getOwnedOverlayRoot(doc);
    if (ownedOverlayRoot?.contains(target) || findInlineMarker(target)) return;
    event.preventDefault();
    event.stopPropagation();
    clickToPlaceArmed = false;
    {
      const body = getBody();
      if (body) body.style.cursor = previousCursor ?? '';
    }
    previousCursor = null;
    const charOffset = caretTextOffsetAtPoint(doc, target, event.clientX, event.clientY) ?? 0;
    const fingerprint = captureFingerprintAt(target, event.clientX, event.clientY, charOffset);
    postToParent({ type: 'click-captured', payload: { fingerprint } });
  };
  win.addEventListener('click', clickListener, true);
  win.addEventListener('click', markerClickListener, true);
  win.addEventListener('keydown', markerKeyListener, true);

  const contextMenuListener = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof win.Element)) return;
    const ownedOverlayRoot = getOwnedOverlayRoot(doc);
    if (ownedOverlayRoot?.contains(target)) return;
    event.preventDefault();
    const charOffset = caretTextOffsetAtPoint(doc, target, event.clientX, event.clientY) ?? 0;
    const fingerprint = captureFingerprintAt(target, event.clientX, event.clientY, charOffset);
    postToParent({
      type: 'placement-requested',
      payload: {
        trigger: 'contextmenu',
        fingerprint,
        point: { x: event.clientX, y: event.clientY },
        scroll: { x: win.scrollX, y: win.scrollY },
      },
    });
  };
  win.addEventListener('contextmenu', contextMenuListener, true);

  function elementFromSelection(selection: Selection): Element | null {
    const node = selection.anchorNode;
    if (!node) return null;
    return node.nodeType === win.Node.ELEMENT_NODE
      ? node as Element
      : node.parentElement;
  }

  function rangeIntersectsOwnedOverlay(range: Range, root: Element | null): boolean {
    if (!root) return false;
    return root.contains(range.commonAncestorContainer);
  }

  const selectionListener = (event: MouseEvent): void => {
    const eventTarget = event.target;
    if (!(eventTarget instanceof win.Element)) return;
    const ownedOverlayRoot = getOwnedOverlayRoot(doc);
    if (ownedOverlayRoot?.contains(eventTarget)) return;
    if (selectionTimer !== null) win.clearTimeout(selectionTimer);
    selectionTimer = win.setTimeout(() => {
      selectionTimer = null;
      const selection = win.getSelection();
      if (!selection || selection.toString().trim() === '' || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const target = elementFromSelection(selection);
      if (!target) return;
      const currentOverlayRoot = getOwnedOverlayRoot(doc);
      if (currentOverlayRoot?.contains(target) || rangeIntersectsOwnedOverlay(range, currentOverlayRoot)) return;
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const charOffset = rangeStartTextOffset(target, range) ?? 0;
      const fingerprint = captureFingerprintAt(target, x, y, charOffset);
      postToParent({
        type: 'placement-requested',
        payload: {
          trigger: 'selection',
          fingerprint,
          point: { x, y },
          scroll: { x: win.scrollX, y: win.scrollY },
        },
      });
    }, 0);
  };
  win.addEventListener('mouseup', selectionListener);

  win.addEventListener('scroll', scheduleScrollState);

  let pending = false;
  let suppressRenderMutations = false;
  let pendingTimer: number | null = null;
  function isOwnedOverlayNode(node: Node): boolean {
    const root = getOwnedOverlayRoot(doc) ?? dotRoot;
    return root !== null && (node === root || root.contains(node));
  }
  function isRenderOwnedMutation(record: MutationRecord): boolean {
    const addedNodes = Array.from(record.addedNodes);
    const removedNodes = Array.from(record.removedNodes);
    if (isOwnedOverlayNode(record.target)) return true;
    if (removedNodes.length > 0) return false;
    return addedNodes.length > 0 && addedNodes.every(isOwnedOverlayNode);
  }
  function isMeaningfulMutation(record: MutationRecord): boolean {
    const addedNodes = Array.from(record.addedNodes);
    const removedNodes = Array.from(record.removedNodes);
    if (addedNodes.length > 0 && addedNodes.some(node => !isOwnedOverlayNode(node))) return true;
    if (isOwnedOverlayNode(record.target)) return false;
    if (removedNodes.length > 0) return removedNodes.some(node => !isOwnedOverlayNode(node) || node === dotRoot);
    if (addedNodes.length > 0) return false;
    return !isOwnedOverlayNode(record.target);
  }
  const observer = new win.MutationObserver((records) => {
    if (nonce === null) return;
    if (suppressRenderMutations && records.every(isRenderOwnedMutation)) {
      suppressRenderMutations = false;
      return;
    }
    suppressRenderMutations = false;
    const meaningful = records.some(isMeaningfulMutation);
    if (!meaningful) return;
    if (pending) return;
    pending = true;
    pendingTimer = win.setTimeout(() => {
      pending = false;
      pendingTimer = null;
      rebuildDotsWhenBodyReady(lastComments);
    }, 100);
  });
  let observerStarted = false;
  function setupBodyDependentWork(): void {
    const body = getBody();
    if (!body) return;
    if (!observerStarted) {
      observer.observe(body, { childList: true, subtree: true });
      observerStarted = true;
    }
    if (clickToPlaceArmed) {
      if (previousCursor === null) previousCursor = body.style.cursor;
      body.style.cursor = 'crosshair';
    }
    if (pendingBodyRender) rebuildDotsWhenBodyReady(lastComments);
  }
  const domReadyListener = (): void => setupBodyDependentWork();
  doc.addEventListener('DOMContentLoaded', domReadyListener);
  setupBodyDependentWork();

  // F) Re-emit triggers for layout-only changes

  // ResizeObserver on body for font/image-load reflow and CSS-only geometry changes
  const bodyResizeObserver = new win.ResizeObserver(() => {
    if (nonce !== null) rebuildDotsWhenBodyReady(lastComments);
  });
  const bodyForObserve = getBody();
  if (bodyForObserve) bodyResizeObserver.observe(bodyForObserve);

  // <details> toggle (capture phase — toggle does not bubble)
  const toggleListener = (e: Event): void => {
    if ((e.target as HTMLElement | null)?.tagName === 'DETAILS') {
      if (nonce !== null) rebuildDotsWhenBodyReady(lastComments);
    }
  };
  doc.addEventListener('toggle', toggleListener, true);

  // Iframe resize
  const resizeListener = (): void => {
    if (nonce !== null) rebuildDotsWhenBodyReady(lastComments);
  };
  win.addEventListener('resize', resizeListener);

  const cleanup = (): void => {
    win.removeEventListener('message', messageListener);
    win.removeEventListener('click', clickListener, true);
    win.removeEventListener('click', markerClickListener, true);
    win.removeEventListener('keydown', markerKeyListener, true);
    win.removeEventListener('contextmenu', contextMenuListener, true);
    win.removeEventListener('mouseup', selectionListener);
    win.removeEventListener('scroll', scheduleScrollState);
    win.removeEventListener('resize', resizeListener);
    bodyResizeObserver.disconnect();
    doc.removeEventListener('toggle', toggleListener, true);
    if (scrollFrame !== null) {
      win.cancelAnimationFrame(scrollFrame);
      scrollFrame = null;
    }
    if (restoreFrame !== null) {
      win.cancelAnimationFrame(restoreFrame);
      restoreFrame = null;
    }
    if (selectionTimer !== null) {
      win.clearTimeout(selectionTimer);
      selectionTimer = null;
    }
    doc.removeEventListener('DOMContentLoaded', domReadyListener);
    dotRoot?.removeEventListener('click', markerClickListener);
    dotRoot = null;
    removeOwnedOverlayRoot(doc);
    observer.disconnect();
    if (pendingTimer !== null) {
      win.clearTimeout(pendingTimer);
      pendingTimer = null;
      pending = false;
    }
    const isCurrentInstall = bridgeWin[BRIDGE_STATE_KEY]?.cleanup === cleanup;
    if (clickToPlaceArmed && isCurrentInstall) {
      const body = getBody();
      if (body) body.style.cursor = previousCursor ?? '';
    }
    previousCursor = null;
    if (isCurrentInstall) {
      delete bridgeWin[BRIDGE_STATE_KEY];
    }
  };
  bridgeWin[BRIDGE_STATE_KEY] = { cleanup };
  return cleanup;
}
