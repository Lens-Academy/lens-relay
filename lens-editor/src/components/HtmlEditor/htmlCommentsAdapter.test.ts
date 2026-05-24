/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import * as Y from 'yjs';
import {
  useThreadsFromHtmlYText,
  effectiveY,
  makeIframeScrollSource,
  type AnchorState,
} from './htmlCommentsAdapter';
import { addComment } from './comment-store';

function makeDoc() {
  const doc = new Y.Doc();
  const ytext = doc.getText('contents');
  ytext.insert(0, '<p>hello</p>');
  return ytext;
}

describe('effectiveY', () => {
  it('combines iframe top, rect y, and scroll delta', () => {
    // iframeTop + rect.y - (current - baseline) = 200 + 100 - (70 - 50) = 280
    expect(effectiveY({ y: 100, x: 0, w: 10, h: 10 }, 50, 70, 200)).toBe(280);
  });

  it('returns iframeTop + rect.y when scroll has not moved', () => {
    expect(effectiveY({ y: 50, x: 0, w: 10, h: 10 }, 0, 0, 100)).toBe(150);
  });
});

describe('useThreadsFromHtmlYText', () => {
  it('orphan when no rect for the id', () => {
    const ytext = makeDoc();
    addComment(ytext, 'test', { id: 'c1', author: 'a', ts: 't', body: 'hi', position: 12 });
    const anchorState: AnchorState = new Map();
    const { result } = renderHook(() => useThreadsFromHtmlYText(ytext, anchorState, 'a'));
    expect(result.current.threads).toHaveLength(1);
    expect(result.current.threads[0].orphan).toBe(true);
  });

  it('not orphan when rect present', () => {
    const ytext = makeDoc();
    addComment(ytext, 'test', { id: 'c1', author: 'a', ts: 't', body: 'hi', position: 12 });
    const anchorState: AnchorState = new Map([['c1', { y: 50, x: 0, w: 10, h: 10 }]]);
    const { result } = renderHook(() => useThreadsFromHtmlYText(ytext, anchorState, 'a'));
    expect(result.current.threads[0].orphan).toBe(false);
  });

  it('onEdit calls editMessage with the message id', () => {
    const ytext = makeDoc();
    addComment(ytext, 'test', { id: 'c1', author: 'a', ts: 't', body: 'hi', position: 12 });
    const anchorState: AnchorState = new Map();
    const { result } = renderHook(() => useThreadsFromHtmlYText(ytext, anchorState, 'a'));
    const msg = result.current.threads[0].root;
    act(() => { result.current.callbacks.onEdit(msg, 'edited'); });
    expect(ytext.toString()).toContain('"body":"edited"');
  });

  it('onReply appends a reply to the cluster', () => {
    const ytext = makeDoc();
    addComment(ytext, 'test', { id: 'c1', author: 'a', ts: 't', body: 'hi', position: 12 });
    const anchorState: AnchorState = new Map([['c1', { y: 50, x: 0, w: 10, h: 10 }]]);
    const { result } = renderHook(() => useThreadsFromHtmlYText(ytext, anchorState, 'alice'));
    const thread = result.current.threads[0];
    act(() => { result.current.callbacks.onReply(thread, 'reply body'); });
    expect(result.current.threads[0].replies).toHaveLength(1);
    expect(result.current.threads[0].replies[0].body).toBe('reply body');
    expect(result.current.threads[0].replies[0].author).toBe('alice');
  });

  it('re-projects on yText change', () => {
    const ytext = makeDoc();
    const anchorState: AnchorState = new Map();
    const { result } = renderHook(() => useThreadsFromHtmlYText(ytext, anchorState, 'a'));
    expect(result.current.threads).toHaveLength(0);
    act(() => {
      addComment(ytext, 'test', { id: 'c1', author: 'a', ts: 't', body: 'hi', position: 12 });
    });
    expect(result.current.threads).toHaveLength(1);
  });
});

describe('makeIframeScrollSource', () => {
  it('reads getters from the provided state function', () => {
    const state = { scrollTop: 30, scrollHeight: 1000, clientHeight: 500 };
    const src = makeIframeScrollSource(() => state);
    expect(src.getScrollTop()).toBe(30);
    expect(src.getScrollHeight()).toBe(1000);
    expect(src.getClientHeight()).toBe(500);
    state.scrollTop = 50;
    expect(src.getScrollTop()).toBe(50);
  });

  it('notify fires subscribers; unsubscribe stops them', () => {
    const src = makeIframeScrollSource(() => ({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }));
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = src.subscribe(a);
    src.subscribe(b);
    src.notify();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    unsubA();
    src.notify();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });
});
