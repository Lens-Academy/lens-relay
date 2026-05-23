import type { CommentSummary, Fingerprint } from './protocol';

export const OVERLAY_ROOT_ID = 'lens-comment-overlay-root';
const OVERLAY_ROOT_MARKER = 'v1';
const overlayRoots = new WeakMap<Document, HTMLDivElement>();

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

  let root: HTMLDivElement;
  root = doc.createElement('div');
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
