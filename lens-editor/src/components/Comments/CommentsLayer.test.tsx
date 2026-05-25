/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { createRef } from 'react';
import { CommentsLayer, type CommentsLayerHandle } from './CommentsLayer';
import type { ThreadView, MessageView, ScrollSource } from './types';

beforeEach(() => {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(cleanup);

function fakeScrollSource(initial: { scrollTop?: number; scrollHeight?: number; clientHeight?: number } = {}): ScrollSource & { fire(): void } {
  const subs = new Set<() => void>();
  return {
    getScrollTop: () => initial.scrollTop ?? 0,
    getScrollHeight: () => initial.scrollHeight ?? 1000,
    getClientHeight: () => initial.clientHeight ?? 500,
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    fire() { subs.forEach(fn => fn()); },
  };
}

function msg(over: Partial<MessageView> = {}): MessageView {
  return { id: 'alice|1', author: 'Alice', body: 'hi', timestamp: '1', canModify: true, ...over };
}

function thread(over: Partial<ThreadView> = {}): ThreadView {
  return { key: '100', root: msg(), replies: [], order: 1, orphan: false, ...over };
}

describe('CommentsLayer', () => {
  it('renders empty-state when there are no threads', () => {
    const ss = fakeScrollSource();
    render(
      <CommentsLayer
        threads={[]}
        resolveAnchorY={() => 0}
        getViewportRect={() => ({ top: 0, height: 800 })}
        scrollSource={ss}
        onReply={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()}
      />
    );
    expect(screen.getByText(/no comments yet/i)).toBeInTheDocument();
  });

  it('renders an anchored card with the resolver y', () => {
    const ss = fakeScrollSource();
    const { container } = render(
      <CommentsLayer
        threads={[thread()]}
        resolveAnchorY={() => 222}
        getViewportRect={() => ({ top: 0, height: 800 })}
        scrollSource={ss}
        onReply={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()}
      />
    );
    const wrapper = container.querySelector('[data-comment-thread="100"]') as HTMLElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper.style.top).toBe('222px');
  });

  it('orphans render alongside anchored cards, pinned to viewport.top', () => {
    const ss = fakeScrollSource();
    const o = thread({ key: 'uuid-1', orphan: true });
    const a = thread({ key: '200', orphan: false });
    render(
      <CommentsLayer
        threads={[a, o]}
        resolveAnchorY={() => 100}
        getViewportRect={() => ({ top: 50, height: 800 })}
        scrollSource={ss}
        onReply={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()}
      />
    );
    // Both render as positioned cards. Anchored pins to resolveAnchorY (100);
    // orphan pins to viewport.top (50). PAV may shift either if they collide,
    // but the orphan card must be rendered (no "Orphans" section header).
    const anchored = document.querySelector('[data-comment-thread="200"]') as HTMLElement;
    const orphan = document.querySelector('[data-comment-thread="uuid-1"]') as HTMLElement;
    expect(anchored).not.toBeNull();
    expect(orphan).not.toBeNull();
    expect(anchored.style.position).toBe('absolute');
    expect(orphan.style.position).toBe('absolute');
    expect(screen.queryByText(/orphans/i)).toBeNull();
  });

  it('imperative focusThread is idempotent', () => {
    const ss = fakeScrollSource();
    const ref = createRef<CommentsLayerHandle>();
    const onFocusChange = vi.fn();
    render(
      <CommentsLayer
        ref={ref}
        threads={[thread()]}
        resolveAnchorY={() => 100}
        getViewportRect={() => ({ top: 0, height: 800 })}
        scrollSource={ss}
        onFocusChange={onFocusChange}
        onReply={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()}
      />
    );
    act(() => { ref.current!.focusThread('100'); });
    expect(onFocusChange).toHaveBeenLastCalledWith('100');
    act(() => { ref.current!.focusThread('100'); });
    // Idempotent: second call same key should not toggle off. Last call still '100'.
    expect(onFocusChange).toHaveBeenLastCalledWith('100');
  });

  it('clicking the empty layer background clears focus', () => {
    const ss = fakeScrollSource();
    const ref = createRef<CommentsLayerHandle>();
    const onFocusChange = vi.fn();
    const { container } = render(
      <CommentsLayer
        ref={ref}
        threads={[thread()]}
        resolveAnchorY={() => 100}
        getViewportRect={() => ({ top: 0, height: 800 })}
        scrollSource={ss}
        onFocusChange={onFocusChange}
        onReply={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()}
      />
    );
    act(() => { ref.current!.focusThread('100'); });
    onFocusChange.mockClear();
    const layer = container.querySelector('.comments-layer') as HTMLElement;
    fireEvent.click(layer);
    expect(onFocusChange).toHaveBeenLastCalledWith(null);
  });
});
