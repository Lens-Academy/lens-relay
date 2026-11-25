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

  it('imperative toggleFocus toggles focus on/off for the same key', () => {
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
    act(() => { ref.current!.toggleFocus('100'); });
    expect(onFocusChange).toHaveBeenLastCalledWith('100');
    act(() => { ref.current!.toggleFocus('100'); });
    expect(onFocusChange).toHaveBeenLastCalledWith(null);
    act(() => { ref.current!.toggleFocus('100'); });
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

describe('a reply being written while others edit', () => {
  it('keeps its card open and its reply when the thread moves because text was typed above it', () => {
    const ss = fakeScrollSource();
    const props = {
      resolveAnchorY: () => 100,
      getViewportRect: () => ({ top: 0, height: 800 }),
      scrollSource: ss,
      onReply: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(),
    };
    const { rerender } = render(<CommentsLayer threads={[thread({ key: '100' })]} {...props} />);
    // Opening the card brings its reply bar
    fireEvent.click(screen.getByText('hi'));
    const box = screen.getByPlaceholderText(/reply…/i);
    fireEvent.change(box, { target: { value: 'half-written' } });

    rerender(<CommentsLayer threads={[thread({ key: '109' })]} {...props} />);

    expect(screen.getByPlaceholderText(/reply…/i)).toHaveValue('half-written');
  });
});

describe('opening and closing a thread', () => {
  const props = () => ({
    resolveAnchorY: () => 100,
    getViewportRect: () => ({ top: 0, height: 800 }),
    scrollSource: fakeScrollSource(),
    onReply: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(),
  });
  const isOpen = () => document.querySelector('.lens-comment-card.is-open') != null;

  it('keeps a thread opened by the handle open when it moves, though the handle was made before the page had threads', () => {
    const p = props();
    const ref = createRef<CommentsLayerHandle>();
    const { rerender } = render(<CommentsLayer ref={ref} threads={[]} {...p} />);
    rerender(<CommentsLayer ref={ref} threads={[thread({ key: '100' })]} {...p} />);
    act(() => ref.current!.focusThread('100'));
    expect(isOpen()).toBe(true);

    // Someone types above it, and another thread now starts where it was
    rerender(<CommentsLayer ref={ref} threads={[thread({ key: '100', root: msg({ id: 'bob|2' }) }), thread({ key: '101' })]} {...p} />);

    expect(document.querySelector('[data-comment-thread="101"] .is-open')).not.toBeNull();
  });

  it('closes the open thread on Escape, but not on an Escape in a field', () => {
    const ref = createRef<CommentsLayerHandle>();
    render(<CommentsLayer ref={ref} threads={[thread()]} {...props()} />);
    act(() => ref.current!.focusThread('100'));

    fireEvent.keyDown(screen.getByPlaceholderText(/reply…/i), { key: 'Escape' });
    expect(isOpen()).toBe(true);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(isOpen()).toBe(false);
  });

  it('closes the open thread by clearFocus (a click in other text)', () => {
    const onFocusChange = vi.fn();
    const ref = createRef<CommentsLayerHandle>();
    render(<CommentsLayer ref={ref} threads={[thread()]} onFocusChange={onFocusChange} {...props()} />);
    act(() => ref.current!.focusThread('100'));
    act(() => ref.current!.clearFocus());
    expect(isOpen()).toBe(false);
    expect(onFocusChange).toHaveBeenLastCalledWith(null);
  });

  it('offers a new comment closed unsent again in the next new comment', () => {
    const ref = createRef<CommentsLayerHandle>();
    render(<CommentsLayer ref={ref} threads={[thread()]} getInsertKey={() => '5'} onAddComment={vi.fn()} {...props()} />);
    act(() => ref.current!.openAddForm());
    const box = screen.getByPlaceholderText(/add a comment…/i);
    fireEvent.change(box, { target: { value: 'half a thought' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByPlaceholderText(/add a comment…/i)).toBeNull();

    act(() => ref.current!.openAddForm());
    expect(screen.getByPlaceholderText(/add a comment…/i)).toHaveValue('half a thought');
  });
});
