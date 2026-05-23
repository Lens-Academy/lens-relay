import { validateEnvelope, type Envelope, type BridgeToParent, type CommentSummary, type Fingerprint, type ParentToBridge } from './protocol';

export const OVERLAY_ROOT_ID = 'lens-comment-overlay-root';
const OVERLAY_ROOT_MARKER = 'v1';
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

export function renderDots(doc: Document, comments: CommentSummary[]): { found: string[]; orphaned: string[] } {
  const root = ensureOverlayRoot(doc);
  const presentNodes = findCommentNodes(doc);
  const byId = new Map(presentNodes.map(c => [c.id, c]));
  const found: string[] = [];
  const orphaned: string[] = [];
  root.innerHTML = '';
  for (const summary of comments) {
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
  }
  return { found, orphaned };
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

  function postToParent(message: BridgeToParent): void {
    const env: Envelope<BridgeToParent> = { nonce: nonce ?? '', message };
    (parent.postMessage as (msg: unknown, targetOrigin?: string) => void)(env, '*');
  }

  function getBody(): HTMLElement | null {
    return doc.body;
  }

  const dotClickListener = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof win.Element)) return;
    const dot = target.closest<HTMLElement>('.lens-comment-dot');
    if (!dot || dotRoot?.contains(dot) !== true) return;
    event.stopPropagation();
    const id = dot.dataset.commentId;
    if (id) postToParent({ type: 'dot-clicked', payload: { id } });
  };

  function wireDotRoot(): void {
    const root = getOwnedOverlayRoot(doc);
    if (root === dotRoot) return;
    dotRoot?.removeEventListener('click', dotClickListener);
    dotRoot = root;
    dotRoot?.addEventListener('click', dotClickListener);
  }

  function rebuildDots(comments: CommentSummary[]): void {
    suppressRenderMutations = true;
    const result = renderDots(doc, comments);
    postToParent({ type: 'comments-rendered', payload: result });
    wireDotRoot();
  }

  function rebuildDotsWhenBodyReady(comments: CommentSummary[]): void {
    if (!getBody()) {
      pendingBodyRender = true;
      return;
    }
    pendingBodyRender = false;
    rebuildDots(comments);
  }

  postToParent({ type: 'ready', payload: {} });

  let lastComments: CommentSummary[] = [];

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
    if (ownedOverlayRoot?.contains(target)) return;
    event.preventDefault();
    event.stopPropagation();
    clickToPlaceArmed = false;
    {
      const body = getBody();
      if (body) body.style.cursor = previousCursor ?? '';
    }
    previousCursor = null;
    const fingerprint = captureFingerprintAt(target, event.clientX, event.clientY, 0);
    postToParent({ type: 'click-captured', payload: { fingerprint } });
  };
  win.addEventListener('click', clickListener, true);

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

  const cleanup = (): void => {
    win.removeEventListener('message', messageListener);
    win.removeEventListener('click', clickListener, true);
    doc.removeEventListener('DOMContentLoaded', domReadyListener);
    dotRoot?.removeEventListener('click', dotClickListener);
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
