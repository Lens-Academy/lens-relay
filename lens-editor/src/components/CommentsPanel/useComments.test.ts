// src/components/CommentsPanel/useComments.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createCriticMarkupEditor } from '../../test/codemirror-helpers';
import { useComments } from './useComments';

describe('useComments', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    if (cleanup) cleanup();
  });

  it('returns empty threads when view is null', () => {
    const { result } = renderHook(() => useComments(null));
    expect(result.current).toEqual([]);
  });

  it('returns empty threads when no comments in document', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello {++world++} end',
      0
    );
    cleanup = c;

    const { result } = renderHook(() => useComments(view));
    expect(result.current).toEqual([]);
  });

  it('returns single thread with single comment', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello {>>my comment<<} end',
      0
    );
    cleanup = c;

    const { result } = renderHook(() => useComments(view));

    expect(result.current).toHaveLength(1);
    expect(result.current[0].comments).toHaveLength(1);
    expect(result.current[0].comments[0].content).toBe('my comment');
  });

  it('groups adjacent comments into single thread', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'text{>>first<<}{>>reply<<} more',
      0
    );
    cleanup = c;

    const { result } = renderHook(() => useComments(view));

    expect(result.current).toHaveLength(1);
    expect(result.current[0].comments).toHaveLength(2);
    expect(result.current[0].comments[0].content).toBe('first');
    expect(result.current[0].comments[1].content).toBe('reply');
  });

  it('separates non-adjacent comments into different threads', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'text{>>first<<} gap {>>second<<} end',
      0
    );
    cleanup = c;

    const { result } = renderHook(() => useComments(view));

    expect(result.current).toHaveLength(2);
    expect(result.current[0].comments[0].content).toBe('first');
    expect(result.current[1].comments[0].content).toBe('second');
  });

  it('extracts metadata from comments', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      '{>>{"author":"alice","timestamp":1234567890}@@my note<<}',
      0
    );
    cleanup = c;

    const { result } = renderHook(() => useComments(view));

    expect(result.current).toHaveLength(1);
    expect(result.current[0].comments[0].metadata?.author).toBe('alice');
    expect(result.current[0].comments[0].metadata?.timestamp).toBe(1234567890);
  });

  it('updates when re-rendered after document change', () => {
    const { view, cleanup: c } = createCriticMarkupEditor('hello world', 0);
    cleanup = c;

    const { result, rerender } = renderHook(() => useComments(view));

    // Initially no comments
    expect(result.current).toEqual([]);

    // Modify document to add a comment
    view.dispatch({
      changes: { from: 0, insert: '{>>new comment<<}' },
    });

    // Re-render (simulates parent stateVersion change)
    rerender();

    // Now should have the comment
    expect(result.current).toHaveLength(1);
    expect(result.current[0].comments[0].content).toBe('new comment');
  });
});
