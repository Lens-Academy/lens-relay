// lens-editor/src/components/Comments/criticmarkupAdapter.test.ts
/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import * as Y from 'yjs';
import { useThreadsFromYText } from './criticmarkupAdapter';

// `getCurrentAuthor` (used by buildCommentMarkup) reads from window.__currentUser
// in this codebase; check the function source if your test fixtures don't pick
// up the author. If there's a simpler test helper to set the author, use that.
// For these tests we'll insert manually shaped markup so we control the
// metadata exactly, since the production helper hardcodes Date.now() and may
// pull the author from a global.

function insertWithMetadata(ytext: Y.Text, pos: number, author: string, timestamp: number, content: string) {
  const meta = JSON.stringify({ author, timestamp });
  ytext.insert(pos, `{>>${meta}@@${content}<<}`);
}

function makeDoc(text: string = '') {
  const doc = new Y.Doc();
  const ytext = doc.getText('contents');
  if (text) ytext.insert(0, text);
  return { doc, ytext };
}

describe('useThreadsFromYText', () => {
  it('projects a single comment thread into a ThreadView', () => {
    const { ytext } = makeDoc('Hello ');
    insertWithMetadata(ytext, 6, 'alice', 1716553200000, 'world');

    const { result } = renderHook(() => useThreadsFromYText(ytext, 'alice'));
    expect(result.current.threads).toHaveLength(1);
    const t = result.current.threads[0];
    expect(t.root.author).toBe('alice');
    expect(t.root.body).toBe('world');
    expect(t.root.canModify).toBe(true);
    expect(t.orphan).toBe(false);
    expect(t.order).toBe(1);
  });

  it('canModify is false when the user is not the author', () => {
    const { ytext } = makeDoc();
    insertWithMetadata(ytext, 0, 'alice', 1716553200000, 'x');

    const { result } = renderHook(() => useThreadsFromYText(ytext, 'bob'));
    expect(result.current.threads[0].root.canModify).toBe(false);
  });

  it('onEdit operates on the live range after a remote offset shift', () => {
    const { ytext } = makeDoc('A');
    insertWithMetadata(ytext, 1, 'alice', 1716553200000, 'x');

    const { result, rerender } = renderHook(() => useThreadsFromYText(ytext, 'alice'));

    act(() => { ytext.insert(0, 'PREFIX '); });
    rerender();

    const msg = result.current.threads[0].root;
    act(() => { result.current.callbacks.onEdit(msg, 'edited'); });

    expect(ytext.toString()).toContain('@@edited<<}');
    expect(ytext.toString()).not.toContain('@@x<<}');
  });

  it('observes yText and re-projects on change', () => {
    const { ytext } = makeDoc();
    const { result } = renderHook(() => useThreadsFromYText(ytext, 'alice'));
    expect(result.current.threads).toHaveLength(0);

    act(() => { insertWithMetadata(ytext, 0, 'alice', 1716553200000, 'hi'); });
    expect(result.current.threads).toHaveLength(1);
  });

  it('onReply appends to the thread', () => {
    const { ytext } = makeDoc();
    insertWithMetadata(ytext, 0, 'alice', 1716553200000, 'hi');

    const { result } = renderHook(() => useThreadsFromYText(ytext, 'alice'));
    const thread = result.current.threads[0];

    act(() => { result.current.callbacks.onReply(thread, 'reply-body'); });

    // After the reply, the thread should have two comments. Re-render to pick up
    // the new parse.
    expect(result.current.threads[0].replies).toHaveLength(1);
    expect(result.current.threads[0].replies[0].body).toBe('reply-body');
  });

  it('canModify is false for the author when the viewer lacks edit access', () => {
    const { ytext } = makeDoc();
    insertWithMetadata(ytext, 0, 'alice', 1716553200000, 'x');

    const { result } = renderHook(() => useThreadsFromYText(ytext, 'alice', false));
    expect(result.current.threads[0].root.canModify).toBe(false);
  });

  it('onResolve lets a non-author mark a thread resolved, and exposes who resolved it', () => {
    const { ytext } = makeDoc();
    insertWithMetadata(ytext, 0, 'alice', 1716553200000, 'please fix');

    // bob (not the author) has edit access and resolves it.
    const { result } = renderHook(() => useThreadsFromYText(ytext, 'bob'));
    expect(result.current.threads[0].resolved).toBeUndefined();

    act(() => { result.current.callbacks.onResolve(result.current.threads[0]); });

    expect(result.current.threads[0].resolved).toBeDefined();
    expect(result.current.threads[0].resolved?.by).toBe('bob');
    // Body and author of the original comment are preserved.
    expect(result.current.threads[0].root.body).toBe('please fix');
    expect(result.current.threads[0].root.author).toBe('alice');
  });

  it('resolving a headerless comment does not make the resolver its author or editor', () => {
    const { ytext } = makeDoc();
    // A hand-written comment with no author metadata.
    ytext.insert(0, 'Hi {>>please fix<<} end');

    const { result } = renderHook(() => useThreadsFromYText(ytext, 'bob'));
    expect(result.current.threads[0].root.author).toBe('unknown');
    expect(result.current.threads[0].root.canModify).toBe(false);

    act(() => { result.current.callbacks.onResolve(result.current.threads[0]); });

    // Still not bob's comment after bob resolves it.
    expect(result.current.threads[0].resolved?.by).toBe('bob');
    expect(result.current.threads[0].root.author).toBe('unknown');
    expect(result.current.threads[0].root.canModify).toBe(false);
  });

  it('replying to a resolved thread reopens it (HTML-editor parity)', () => {
    const { ytext } = makeDoc();
    insertWithMetadata(ytext, 0, 'alice', 1716553200000, 'please fix');

    const { result } = renderHook(() => useThreadsFromYText(ytext, 'bob'));
    act(() => { result.current.callbacks.onResolve(result.current.threads[0]); });
    expect(result.current.threads[0].resolved).toBeDefined();

    act(() => { result.current.callbacks.onReply(result.current.threads[0], 'this is still wrong'); });

    expect(result.current.threads[0].resolved).toBeUndefined();
    expect(result.current.threads[0].replies.at(-1)?.body).toBe('this is still wrong');
  });

  it('onReopen clears the resolved state', () => {
    const { ytext } = makeDoc();
    insertWithMetadata(ytext, 0, 'alice', 1716553200000, 'please fix');

    const { result } = renderHook(() => useThreadsFromYText(ytext, 'bob'));
    act(() => { result.current.callbacks.onResolve(result.current.threads[0]); });
    expect(result.current.threads[0].resolved).toBeDefined();

    act(() => { result.current.callbacks.onReopen(result.current.threads[0]); });
    expect(result.current.threads[0].resolved).toBeUndefined();
  });
});
