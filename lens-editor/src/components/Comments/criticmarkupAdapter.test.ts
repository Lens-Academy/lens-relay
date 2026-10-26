// lens-editor/src/components/Comments/criticmarkupAdapter.test.ts
/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import * as Y from 'yjs';
import { pinInsertKey, useThreadsFromYText } from './criticmarkupAdapter';
import { insertCommentInYText, replyInYText } from '../../lib/ytext-comment-ops';

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

  it("with edit access, a non-author may delete (not edit) someone else's comment", () => {
    const { ytext } = makeDoc('Fixed text. ');
    insertWithMetadata(ytext, 12, 'Luc', 1716553200000, 'this needs fixing');

    const { result: noAccess } = renderHook(() => useThreadsFromYText(ytext, 'Andreas'));
    expect(noAccess.current.threads[0].root.canDelete).toBe(false);

    const { result } = renderHook(() => useThreadsFromYText(ytext, 'Andreas', true));
    const root = result.current.threads[0].root;
    expect(root.canModify).toBe(false);
    expect(root.canDelete).toBe(true);

    act(() => { result.current.callbacks.onDelete(root); });
    expect(ytext.toString()).toBe('Fixed text. ');
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
});

describe('a new comment while others edit', () => {
  it('lands where the form was opened, though text was typed above it meanwhile', () => {
    const { ytext } = makeDoc('alpha beta gamma');
    const { result } = renderHook(() => useThreadsFromYText(ytext, 'me', false));
    const key = pinInsertKey(ytext, String('alpha beta'.length)); // cursor after "beta"
    act(() => { ytext.insert(0, 'NEW LINE\n'); }); // a collaborator types above
    act(() => { result.current.callbacks.onAddComment!(key, 'hi'); });
    const text = ytext.toString();
    expect(text.startsWith('NEW LINE\nalpha beta{>>')).toBe(true);
    expect(text.endsWith('<<} gamma')).toBe(true);
  });
  it('highlights the text it is on, and returns the new thread key', () => {
    const { ytext } = makeDoc('alpha beta gamma');
    const { result } = renderHook(() => useThreadsFromYText(ytext, 'me', false));
    const key = pinInsertKey(ytext, String('alpha beta'.length), 'alpha '.length); // "beta" selected
    act(() => { ytext.insert(0, 'NEW '); }); // a collaborator types above
    let created: string | void = undefined;
    act(() => { created = result.current.callbacks.onAddComment!(key, 'hi'); });
    expect(ytext.toString().startsWith('NEW alpha {==beta==}{>>')).toBe(true);
    expect(created).toBe(String('NEW alpha {==beta==}'.length));
  });
  it('still accepts a plain offset key', () => {
    const { ytext } = makeDoc('ab');
    const { result } = renderHook(() => useThreadsFromYText(ytext, 'me', false));
    act(() => { result.current.callbacks.onAddComment!('1', 'x'); });
    expect(ytext.toString().startsWith('a{>>')).toBe(true);
  });
});

describe('a comment and the text it highlights go together', () => {
  function highlighted() {
    const { ytext } = makeDoc('We ship it soon.');
    // "ship it" highlighted, with a comment and a reply
    ytext.insert('We ship it'.length, '==}');
    ytext.insert('We '.length, '{==');
    const end = 'We {==ship it==}'.length;
    insertWithMetadata(ytext, end, 'ann', 1716553200000, 'why?');
    insertWithMetadata(ytext, ytext.toString().indexOf(' soon'), 'bo', 1716553300000, 'because');
    return ytext;
  }

  it('resolving removes the thread and the highlight, keeping the text', () => {
    const ytext = highlighted();
    const { result } = renderHook(() => useThreadsFromYText(ytext, 'me', true));
    act(() => { result.current.callbacks.onResolve(result.current.threads[0]); });
    expect(ytext.toString()).toBe('We ship it soon.');
  });

  it("deleting the thread's last comment removes the highlight; deleting a reply keeps it", () => {
    const ytext = highlighted();
    const { result } = renderHook(() => useThreadsFromYText(ytext, 'me', true));
    act(() => { result.current.callbacks.onDelete(result.current.threads[0].replies[0]); });
    expect(ytext.toString()).toContain('We {==ship it==}{>>');
    expect(ytext.toString()).toContain('@@why?<<} soon.');
    expect(ytext.toString()).not.toContain('because');
    act(() => { result.current.callbacks.onDelete(result.current.threads[0].root); });
    expect(ytext.toString()).toBe('We ship it soon.');
  });
});
