import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  findCommentNodes,
  findAnchorElement,
  renderDots,
  captureFingerprintAt,
  findProbe,
  installBridge,
} from './bridge-script';
import type { CommentSummary } from './protocol';

function setupBody(html: string): void {
  document.body.innerHTML = html;
}

function stubRenderedRect(el: Element, rect = { left: 10, top: 20, right: 110, bottom: 50, x: 10, y: 20, width: 100, height: 30 }): void {
  const domRect = { ...rect, toJSON: () => ({}) };
  el.getBoundingClientRect = () => domRect;
  el.getClientRects = () => [domRect] as unknown as DOMRectList;
}

function stubZeroRect(el: Element): void {
  const domRect = { left: 0, top: 0, right: 0, bottom: 0, x: 0, y: 0, width: 0, height: 0, toJSON: () => ({}) };
  el.getBoundingClientRect = () => domRect;
  el.getClientRects = () => [] as unknown as DOMRectList;
}

describe('findCommentNodes', () => {
  it('returns lens-comment comment nodes with parsed ids', () => {
    setupBody(
      '<p>before</p>' +
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->' +
      '<p>after</p>' +
      '<!--lens-comment {"id":"c2","author":"a","ts":"t","body":"y"}-->'
    );
    expect(findCommentNodes(document).map(n => n.id)).toEqual(['c1', 'c2']);
  });

  it('ignores reply markers (they do not get their own dot)', () => {
    setupBody(
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->' +
      '<!--lens-reply {"id":"r1","parent":"c1","author":"b","ts":"t","body":"y"}-->'
    );
    expect(findCommentNodes(document).map(n => n.id)).toEqual(['c1']);
  });

  it('ignores malformed lens-comment JSON markers', () => {
    setupBody(
      '<!--lens-comment {bad json}-->' +
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->'
    );
    expect(findCommentNodes(document).map(n => n.id)).toEqual(['c1']);
  });

  it('finds comment nodes inside a foreign iframe document', () => {
    setupBody('<iframe></iframe>');
    const frame = document.querySelector('iframe')!;
    const frameDoc = frame.contentDocument!;
    frameDoc.body.innerHTML = '<!--lens-comment {"id":"frame-c1","author":"a","ts":"t","body":"x"}--><p>frame</p>';

    expect(findCommentNodes(frameDoc).map(n => n.id)).toEqual(['frame-c1']);
  });
});

describe('findAnchorElement', () => {
  it('returns the next element sibling when one exists', () => {
    setupBody(
      '<p>before</p>' +
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->' +
      '<p id="target">after</p>'
    );
    stubRenderedRect(document.getElementById('target')!);
    const commentNode = document.body.childNodes[1] as Comment;
    expect(findAnchorElement(commentNode)?.id).toBe('target');
  });

  it('falls back to parent element when no next sibling', () => {
    setupBody('<div id="parent"><!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}--></div>');
    stubRenderedRect(document.getElementById('parent')!);
    const commentNode = document.getElementById('parent')!.childNodes[0] as Comment;
    expect(findAnchorElement(commentNode)?.id).toBe('parent');
  });

  it('skips non-render-usable sibling elements', () => {
    setupBody(
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->' +
      '<script></script>' +
      '<style></style>' +
      '<p hidden id="hidden">hidden</p>' +
      '<p id="target">after</p>'
    );
    const hidden = document.getElementById('hidden')!;
    const target = document.getElementById('target')!;
    stubZeroRect(hidden);
    stubRenderedRect(target);

    const commentNode = document.body.childNodes[0] as Comment;
    expect(findAnchorElement(commentNode)?.id).toBe('target');
  });

  it('skips display-none and visibility-hidden sibling elements', () => {
    setupBody(
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->' +
      '<p id="display-none" style="display:none">hidden</p>' +
      '<p id="visibility-hidden" style="visibility:hidden">hidden</p>' +
      '<p id="target">after</p>'
    );
    stubRenderedRect(document.getElementById('display-none')!);
    stubRenderedRect(document.getElementById('visibility-hidden')!);
    stubRenderedRect(document.getElementById('target')!);

    const commentNode = document.body.childNodes[0] as Comment;
    expect(findAnchorElement(commentNode)?.id).toBe('target');
  });
});

describe('renderDots', () => {
  beforeEach(() => {
    setupBody('<p>before</p><!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}--><p id="t">after</p>');
    stubRenderedRect(document.getElementById('t')!);
  });

  it('creates an overlay root and one dot per comment, returns found/orphaned ids', () => {
    const summaries: CommentSummary[] = [{ id: 'c1', body: 'x', replies: 0 }];
    const result = renderDots(document, summaries);
    expect(result).toEqual({ found: ['c1'], orphaned: [] });
    const root = document.querySelector('[data-lens-overlay="true"]');
    expect(root).not.toBeNull();
    expect(root!.querySelectorAll('.lens-comment-dot')).toHaveLength(1);
  });

  it('reports orphaned ids for comments whose marker is missing from DOM', () => {
    const summaries: CommentSummary[] = [
      { id: 'c1', body: 'x', replies: 0 },
      { id: 'gone', body: 'y', replies: 0 },
    ];
    expect(renderDots(document, summaries)).toEqual({ found: ['c1'], orphaned: ['gone'] });
  });

  it('reuses overlay root across calls (idempotent)', () => {
    renderDots(document, [{ id: 'c1', body: 'x', replies: 0 }]);
    renderDots(document, [{ id: 'c1', body: 'x', replies: 0 }]);
    expect(document.querySelectorAll('#lens-comment-overlay-root')).toHaveLength(1);
  });

  it('does not clear a user element that collides with the overlay root id', () => {
    setupBody(
      '<div id="lens-comment-overlay-root">user content</div>' +
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->' +
      '<p id="t">after</p>'
    );
    stubRenderedRect(document.getElementById('t')!);

    renderDots(document, [{ id: 'c1', body: 'x', replies: 0 }]);
    renderDots(document, [{ id: 'c1', body: 'x', replies: 0 }]);

    const userRoot = document.getElementById('lens-comment-overlay-root')!;
    expect(userRoot.textContent).toBe('user content');
    const lensRoots = document.querySelectorAll('[data-lens-overlay="true"]:not(.lens-comment-dot)');
    expect(lensRoots).toHaveLength(1);
    const lensRoot = lensRoots[0];
    expect(lensRoot.querySelectorAll('.lens-comment-dot')).toHaveLength(1);
  });

  it('does not trust spoofed broad overlay markers as root ownership', () => {
    setupBody(
      '<div id="lens-comment-overlay-root" data-lens-overlay="true">user content</div>' +
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->' +
      '<p id="t">after</p>'
    );
    stubRenderedRect(document.getElementById('t')!);

    renderDots(document, [{ id: 'c1', body: 'x', replies: 0 }]);

    const userRoot = document.getElementById('lens-comment-overlay-root')!;
    expect(userRoot.textContent).toBe('user content');
    expect(userRoot.hasAttribute('data-lens-overlay-root')).toBe(false);
    const lensRoots = document.querySelectorAll('[data-lens-overlay-root="v1"]');
    expect(lensRoots).toHaveLength(1);
    expect(lensRoots[0].id).not.toBe('lens-comment-overlay-root');
    expect(lensRoots[0].querySelectorAll('.lens-comment-dot')).toHaveLength(1);
  });

  it('does not trust spoofed root-only overlay markers as root ownership', () => {
    setupBody(
      '<div id="lens-comment-overlay-root" data-lens-overlay-root="v1">user content</div>' +
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->' +
      '<p id="t">after</p>'
    );
    stubRenderedRect(document.getElementById('t')!);

    renderDots(document, [{ id: 'c1', body: 'x', replies: 0 }]);

    const userRoot = document.getElementById('lens-comment-overlay-root')!;
    expect(userRoot.textContent).toBe('user content');
    const lensRoots = document.querySelectorAll('[data-lens-overlay="true"]:not(.lens-comment-dot)');
    expect(lensRoots).toHaveLength(1);
    expect(lensRoots[0].id).not.toBe('lens-comment-overlay-root');
    expect(lensRoots[0].querySelectorAll('.lens-comment-dot')).toHaveLength(1);
  });

  it('creates a new owned overlay root if the previous owned root was removed', () => {
    renderDots(document, [{ id: 'c1', body: 'x', replies: 0 }]);
    const firstRoot = document.querySelector('[data-lens-overlay-root="v1"]')!;
    firstRoot.remove();

    renderDots(document, [{ id: 'c1', body: 'x', replies: 0 }]);

    const roots = document.querySelectorAll('[data-lens-overlay-root="v1"]');
    expect(roots).toHaveLength(1);
    expect(roots[0]).not.toBe(firstRoot);
    expect(roots[0].querySelectorAll('.lens-comment-dot')).toHaveLength(1);
  });
});

describe('captureFingerprintAt', () => {
  it('reports tag, ancestor path, before/after text for a given target', () => {
    setupBody('<body><main><p id="t">Hello world here</p></main></body>');
    const target = document.getElementById('t')!;
    const fp = captureFingerprintAt(target, 0, 0, 5);
    expect(fp.tag).toBe('p');
    expect(fp.before.endsWith('Hello')).toBe(true);
    expect(fp.after.startsWith(' world')).toBe(true);
    expect(fp.ancestorPath.map(a => a.tag)).toContain('main');
  });

  it('reports click rect dimensions from the target bounding rect', () => {
    setupBody('<p id="t">Hello world here</p>');
    const target = document.getElementById('t')!;
    stubRenderedRect(target, { left: 5, top: 6, right: 55, bottom: 26, x: 5, y: 6, width: 50, height: 20 });

    const fp = captureFingerprintAt(target, 7, 9, 5);

    expect(fp.clickRect).toEqual({ x: 7, y: 9, w: 50, h: 20 });
  });
});

describe('installBridge placement and scroll handling', () => {
  it('captures right-click placement requests with point and scroll', () => {
    setupBody('<p id="target">Hello world</p>');
    window.scrollTo(0, 120);
    const target = document.getElementById('target')!;
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      left: 5, top: 10, right: 105, bottom: 30, width: 100, height: 20,
      x: 5, y: 10, toJSON() {},
    } as DOMRect);

    const fp = captureFingerprintAt(target, 15, 20, 0);
    expect(fp.after).toContain('Hello');

    const cleanup = installBridge(window);
    const posted: unknown[] = [];
    vi.spyOn(window.parent, 'postMessage').mockImplementation((msg: unknown) => {
      posted.push(msg);
    });

    window.dispatchEvent(new MessageEvent('message', {
      source: window.parent,
      data: { nonce: 'N', message: { type: 'init', payload: { comments: [] } } },
    }));
    target.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 15,
      clientY: 20,
    }));

    expect(posted).toContainEqual({
      nonce: 'N',
      message: {
        type: 'placement-requested',
        payload: expect.objectContaining({
          trigger: 'contextmenu',
          fingerprint: fp,
          point: { x: 15, y: 20 },
          scroll: { x: 0, y: 120 },
        }),
      },
    });
    cleanup();
  });

  it('restores scroll when parent sends restore-scroll', () => {
    setupBody('<p>scroll me</p>');
    const cleanup = installBridge(window);
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});

    window.dispatchEvent(new MessageEvent('message', {
      source: window.parent,
      data: { nonce: 'N', message: { type: 'init', payload: { comments: [] } } },
    }));
    window.dispatchEvent(new MessageEvent('message', {
      source: window.parent,
      data: { nonce: 'N', message: { type: 'restore-scroll', payload: { x: 3, y: 140 } } },
    }));

    expect(scrollTo).toHaveBeenCalledWith(3, 140);
    cleanup();
  });
});

describe('findProbe', () => {
  it('returns the bounding rect of the nearest rendered neighbor', () => {
    setupBody('<p id="x">A</p><!--lens-probe TOKEN--><p id="y">B</p>');
    stubRenderedRect(document.getElementById('y')!);
    const rect = findProbe(document, 'TOKEN');
    expect(rect).not.toBeNull();
  });

  it('skips hidden non-rendered neighbors and returns the visible rect', () => {
    setupBody('<!--lens-probe TOKEN--><p hidden id="hidden">hidden</p><p id="visible">B</p>');
    const hidden = document.getElementById('hidden')!;
    const visible = document.getElementById('visible')!;
    stubZeroRect(hidden);
    stubRenderedRect(visible, { left: 12, top: 34, right: 68, bottom: 54, x: 12, y: 34, width: 56, height: 20 });

    expect(findProbe(document, 'TOKEN')).toEqual({ x: 12, y: 34, w: 56, h: 20 });
  });

  it('returns null when token not found', () => {
    setupBody('<p>nothing here</p>');
    expect(findProbe(document, 'TOKEN')).toBeNull();
  });
});
