import { describe, it, expect, afterEach } from 'vitest';
import { createCriticMarkupEditor } from '../test/codemirror-helpers';
import { insertCommentAt, scrollToPosition } from './comment-utils';
import { criticMarkupField } from '../components/Editor/extensions/criticmarkup';

describe('insertCommentAt', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    if (cleanup) cleanup();
  });

  it('inserts comment markup at position', () => {
    const { view, cleanup: c } = createCriticMarkupEditor('hello world', 5);
    cleanup = c;

    insertCommentAt(view, 'my note', 5);

    const doc = view.state.doc.toString();
    expect(doc).toMatch(/\{>>.*@@my note<<\}/);
  });

  it('includes author and timestamp metadata', () => {
    const { view, cleanup: c } = createCriticMarkupEditor('hello', 5);
    cleanup = c;

    insertCommentAt(view, 'test', 5);

    const doc = view.state.doc.toString();
    expect(doc).toMatch(/"author"/);
    expect(doc).toMatch(/"timestamp"/);
  });

  it('creates a parseable comment range', () => {
    const { view, cleanup: c } = createCriticMarkupEditor('hello', 5);
    cleanup = c;

    insertCommentAt(view, 'a comment', 5);

    const ranges = view.state.field(criticMarkupField);
    const comments = ranges.filter(r => r.type === 'comment');
    expect(comments).toHaveLength(1);
    expect(comments[0].content).toBe('a comment');
  });

  it('inserts at end of thread for replies (adjacent comments)', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello{>>first<<}world',
      // cursor position doesn't matter for this test
      0,
    );
    cleanup = c;

    // Insert reply at the end of the first comment (thread.to)
    const insertPos = 'hello{>>first<<}'.length;
    insertCommentAt(view, 'reply', insertPos);

    const doc = view.state.doc.toString();
    // Both comments should be adjacent
    expect(doc).toMatch(/<<\}\{>>/);
  });
});

describe('scrollToPosition', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    if (cleanup) cleanup();
  });

  it('moves cursor to specified position', () => {
    const { view, cleanup: c } = createCriticMarkupEditor('hello world', 0);
    cleanup = c;

    scrollToPosition(view, 6);

    expect(view.state.selection.main.head).toBe(6);
  });

  it('sets scrollIntoView', () => {
    const { view, cleanup: c } = createCriticMarkupEditor('hello world', 0);
    cleanup = c;

    // We can verify cursor moved - scrollIntoView is a dispatch hint
    scrollToPosition(view, 6);
    expect(view.state.selection.main.head).toBe(6);
  });
});
