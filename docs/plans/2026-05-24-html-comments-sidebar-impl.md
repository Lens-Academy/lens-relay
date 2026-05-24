# HTML Comments Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the HTML preview's comment UI onto the shared `Comments/CommentsLayer` sidebar used by the markdown/edu editors, while keeping the in-iframe icons and click-to-place flow.

**Architecture:** Refactor `CommentsLayer` + `CommentCard` to be source-agnostic by introducing a normalized `ThreadView` shape and a `ScrollSource` abstraction. Each editor provides a small adapter (criticmarkup for md/edu, HTML for the preview) that produces `ThreadView[]` and wires storage callbacks. Bridge protocol gains rect emission + scroll-baseline tracking so the HTML adapter can resolve UUIDs to screen-y without a DOM scrollable.

**Tech Stack:** React 19, TypeScript, Yjs (Y.Text), CodeMirror 6, Vitest, happy-dom. Tailwind for styling.

**Design doc:** `docs/plans/2026-05-24-html-comments-sidebar-plan.md` — read this first for full architectural rationale. This plan is the executable counterpart.

---

## Pre-flight

- [ ] Confirm working dir is clean (`jj st` shows no changes)
- [ ] Run baseline test sweep: `cd lens-editor && npm test -- --run` — note current pass count so regressions are visible

Per task: every task ends with `jj st` then `jj describe -m "<msg>"` then `jj new` (start fresh change). Do not use `jj commit` — `jj describe` + `jj new` is the workflow for this repo (see `~/.claude/CLAUDE.md`).

---

## Task 1: Shared `Comments/types.ts`

Foundation types. No behavior change, no callers yet.

**Files:**
- Create: `lens-editor/src/components/Comments/types.ts`
- Test: `lens-editor/src/components/Comments/types.test.ts`

- [ ] **Step 1: Write the type-shape test**

```ts
// lens-editor/src/components/Comments/types.test.ts
import { describe, it, expectTypeOf } from 'vitest';
import type { ThreadKey, MessageView, ThreadView } from './types';

describe('Comments types', () => {
  it('ThreadKey is a string alias', () => {
    expectTypeOf<ThreadKey>().toEqualTypeOf<string>();
  });

  it('MessageView shape', () => {
    const m: MessageView = {
      id: 'msg-1',
      author: 'alice',
      body: 'hi',
      timestamp: '2026-05-24T00:00:00Z',
      canModify: true,
    };
    expectTypeOf(m.id).toEqualTypeOf<string>();
  });

  it('ThreadView shape', () => {
    const t: ThreadView = {
      key: '100',
      root: { id: 'r', author: 'a', body: 'b', timestamp: 't', canModify: false },
      replies: [],
      order: 1,
      orphan: false,
    };
    expectTypeOf(t.orphan).toEqualTypeOf<boolean>();
  });
});
```

- [ ] **Step 2: Create the types file**

```ts
// lens-editor/src/components/Comments/types.ts
export type ThreadKey = string;

export interface MessageView {
  /** Stable identity that survives offset shifts. Used as React key and as a
   *  handle the layer hands back to callbacks; never decoded by the layer. */
  id: string;
  author: string;
  body: string;
  timestamp: string;
  canModify: boolean;
}

export interface ThreadView {
  key: ThreadKey;
  root: MessageView;
  replies: MessageView[];
  /** 1..N display index; matches inline-badge numbering in the prose. */
  order: number;
  /** Anchor unresolvable in the current render (no on-screen position). */
  orphan: boolean;
}

export interface ScrollSource {
  getScrollTop(): number;
  getScrollHeight(): number;
  getClientHeight(): number;
  subscribe(onChange: () => void): () => void;
}
```

- [ ] **Step 3: Run the test**

```bash
cd lens-editor && npx vitest run src/components/Comments/types.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
jj describe -m "comments: shared ThreadView/MessageView/ScrollSource types" && jj new
```

---

## Task 2: `useScrollSource` adapter (DOM-backed)

Add the DOM-backed `ScrollSource` implementation that markdown/edu will use. Pure addition — no consumer yet.

**Files:**
- Create: `lens-editor/src/components/Comments/useScrollSource.ts`
- Test: `lens-editor/src/components/Comments/useScrollSource.test.ts`

- [ ] **Step 1: Write the test**

```ts
// lens-editor/src/components/Comments/useScrollSource.test.ts
/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRef, useEffect } from 'react';
import { useScrollSource } from './useScrollSource';

function HookHarness({ el, onSource }: { el: HTMLElement; onSource: (s: ReturnType<typeof useScrollSource>) => void }) {
  const ref = useRef<HTMLElement | null>(el);
  const source = useScrollSource(ref);
  useEffect(() => { onSource(source); }, [source, onSource]);
  return null;
}

describe('useScrollSource', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads scrollTop/scrollHeight/clientHeight from the element', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollTop', { get: () => 42, configurable: true });
    Object.defineProperty(el, 'scrollHeight', { get: () => 1000, configurable: true });
    Object.defineProperty(el, 'clientHeight', { get: () => 500, configurable: true });

    let src: { getScrollTop: () => number; getScrollHeight: () => number; getClientHeight: () => number } | null = null;
    const ref = { current: el } as React.RefObject<HTMLElement | null>;
    const { result } = renderHook(() => useScrollSource(ref));
    src = result.current;

    expect(src!.getScrollTop()).toBe(42);
    expect(src!.getScrollHeight()).toBe(1000);
    expect(src!.getClientHeight()).toBe(500);
  });

  it('fires subscribers on scroll', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const ref = { current: el } as React.RefObject<HTMLElement | null>;
    const { result } = renderHook(() => useScrollSource(ref));

    const cb = vi.fn();
    const unsub = result.current.subscribe(cb);

    act(() => { el.dispatchEvent(new Event('scroll')); });
    expect(cb).toHaveBeenCalledTimes(1);

    unsub();
    act(() => { el.dispatchEvent(new Event('scroll')); });
    expect(cb).toHaveBeenCalledTimes(1);
    el.remove();
  });

  it('returns 0 values when ref is null', () => {
    const ref = { current: null } as React.RefObject<HTMLElement | null>;
    const { result } = renderHook(() => useScrollSource(ref));
    expect(result.current.getScrollTop()).toBe(0);
    expect(result.current.getScrollHeight()).toBe(0);
    expect(result.current.getClientHeight()).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd lens-editor && npx vitest run src/components/Comments/useScrollSource.test.ts
```

Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Implement**

```ts
// lens-editor/src/components/Comments/useScrollSource.ts
import { useEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import type { ScrollSource } from './types';

/** ScrollSource backed by a real scrollable DOM element. The returned object
 *  is stable for the lifetime of the hook; getters re-read live values, and
 *  subscribers fanout from a single underlying scroll + ResizeObserver wiring. */
export function useScrollSource(ref: RefObject<HTMLElement | null>): ScrollSource {
  const subsRef = useRef(new Set<() => void>());

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const fire = () => { subsRef.current.forEach(fn => fn()); };
    el.addEventListener('scroll', fire, { passive: true });
    const ro = new ResizeObserver(fire);
    ro.observe(el);

    return () => {
      el.removeEventListener('scroll', fire);
      ro.disconnect();
    };
  }, [ref]);

  return useMemo<ScrollSource>(() => ({
    getScrollTop: () => ref.current?.scrollTop ?? 0,
    getScrollHeight: () => ref.current?.scrollHeight ?? 0,
    getClientHeight: () => ref.current?.clientHeight ?? 0,
    subscribe(onChange) {
      subsRef.current.add(onChange);
      return () => { subsRef.current.delete(onChange); };
    },
  }), [ref]);
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd lens-editor && npx vitest run src/components/Comments/useScrollSource.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
jj describe -m "comments: useScrollSource hook backed by a real DOM element" && jj new
```

---

## Task 3: Refactor `CommentsLayer` internal scroll reads to use `ScrollSource`

No API change yet — adapter pattern internally. CommentsLayer still accepts `scrollContainerRef`; internally we wrap it with `useScrollSource` and convert four read sites + one subscription.

**Files:**
- Modify: `lens-editor/src/components/Comments/CommentsLayer.tsx` (internal only — props unchanged)

- [ ] **Step 1: Confirm existing tests pass before changes**

```bash
cd lens-editor && npx vitest run src/components/Comments/CommentsLayer.test.tsx
```

Expected: PASS (baseline).

- [ ] **Step 2: Refactor — at the top of the component, derive a ScrollSource**

Edit `CommentsLayer.tsx`. After the existing prop destructuring (~line 84):

```ts
import { useScrollSource } from './useScrollSource';

// inside the component, just after destructuring:
const scrollSource = useScrollSource(scrollContainerRef);
```

- [ ] **Step 3: Replace the scroll subscribe useEffect (L191-213)**

Current:
```ts
useEffect(() => {
  const container = scrollContainerRef.current;
  if (!container) return;
  let rafId: number | null = null;
  const bump = () => { if (rafId != null) return; rafId = requestAnimationFrame(() => { rafId = null; setLayoutTick((t) => t + 1); }); };
  container.addEventListener('scroll', bump, { passive: true });
  const ro = new ResizeObserver(bump);
  ro.observe(container);
  return () => { container.removeEventListener('scroll', bump); ro.disconnect(); if (rafId != null) cancelAnimationFrame(rafId); };
}, [scrollContainerRef]);
```

Replace with:
```ts
useEffect(() => {
  let rafId: number | null = null;
  const bump = () => { if (rafId != null) return; rafId = requestAnimationFrame(() => { rafId = null; setLayoutTick((t) => t + 1); }); };
  const unsub = scrollSource.subscribe(bump);
  return () => { unsub(); if (rafId != null) cancelAnimationFrame(rafId); };
}, [scrollSource]);
```

- [ ] **Step 4: Replace direct scroll reads at L278-281**

Current:
```ts
const sc = scrollContainerRef.current;
const scrollTop = sc?.scrollTop ?? 0;
const scrollMax = sc ? Math.max(0, sc.scrollHeight - sc.clientHeight) : 0;
```

Replace with:
```ts
const scrollTop = scrollSource.getScrollTop();
const scrollMax = Math.max(0, scrollSource.getScrollHeight() - scrollSource.getClientHeight());
```

- [ ] **Step 5: Run all CommentsLayer tests**

```bash
cd lens-editor && npx vitest run src/components/Comments/
```

Expected: PASS — internal refactor only, no observable change.

- [ ] **Step 6: Commit**

```bash
jj describe -m "comments: route CommentsLayer scroll reads through ScrollSource (internal refactor)" && jj new
```

---

## Task 4: Markdown adapter — `useThreadsFromYText`

Produces `ThreadView[]` + bound callbacks from a `Y.Text`. Per-parse closures (not an id→state map) avoid the offset-shift stale-id race called out in the design doc.

**Files:**
- Create: `lens-editor/src/components/Comments/criticmarkupAdapter.ts`
- Test: `lens-editor/src/components/Comments/criticmarkupAdapter.test.ts`

- [ ] **Step 1: Write the test**

```ts
// lens-editor/src/components/Comments/criticmarkupAdapter.test.ts
/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import * as Y from 'yjs';
import { useThreadsFromYText } from './criticmarkupAdapter';

function makeDoc(text: string) {
  const doc = new Y.Doc();
  const ytext = doc.getText('contents');
  ytext.insert(0, text);
  return { doc, ytext };
}

describe('useThreadsFromYText', () => {
  it('projects a single comment thread into a ThreadView', () => {
    const { ytext } = makeDoc(
      'Hello {>>world<< | author=alice timestamp=2026-05-24T00:00:00Z}'
    );
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
    const { ytext } = makeDoc(
      'Hi {>>x<< | author=alice timestamp=2026-05-24T00:00:00Z}'
    );
    const { result } = renderHook(() => useThreadsFromYText(ytext, 'bob'));
    expect(result.current.threads[0].root.canModify).toBe(false);
  });

  it('onEdit operates on the live range after a remote offset shift', () => {
    const { ytext } = makeDoc(
      'A{>>x<< | author=alice timestamp=2026-05-24T00:00:00Z}'
    );
    const { result, rerender } = renderHook(() => useThreadsFromYText(ytext, 'alice'));

    // Remote insertion before the comment shifts the range.
    act(() => { ytext.insert(0, 'PREFIX '); });
    rerender();

    const msg = result.current.threads[0].root;
    act(() => { result.current.callbacks.onEdit(msg, 'edited'); });

    expect(ytext.toString()).toContain('{>>edited<<');
    expect(ytext.toString()).not.toContain('{>>x<<');
  });

  it('observes yText and re-projects on change', () => {
    const { ytext } = makeDoc('');
    const { result } = renderHook(() => useThreadsFromYText(ytext, 'alice'));
    expect(result.current.threads).toHaveLength(0);

    act(() => { ytext.insert(0, '{>>hi<< | author=alice timestamp=t}'); });
    expect(result.current.threads).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the adapter**

```ts
// lens-editor/src/components/Comments/criticmarkupAdapter.ts
import { useMemo, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';
import type { ThreadView, MessageView, ThreadKey } from './types';
import { useCommentsFromText, decodeCommentContent } from '../../lib/criticmarkup-parser';
import type { CommentThread, CriticMarkupRange } from '../../lib/criticmarkup-parser';
import {
  insertCommentInYText,
  replyInYText,
  editRangeContentInYText,
  deleteRangeInYText,
} from '../../lib/ytext-comment-ops';

interface AdapterCallbacks {
  onReply: (thread: ThreadView, body: string) => void;
  onEdit: (message: MessageView, newBody: string) => void;
  onDelete: (message: MessageView) => void;
  onAddComment: (key: ThreadKey, body: string) => void;
}

interface AdapterResult {
  threads: ThreadView[];
  callbacks: AdapterCallbacks;
}

function messageIdFor(range: CriticMarkupRange): string {
  // Author+timestamp is stable across offset shifts; the criticmarkup parser
  // already extracts these into metadata. Falls back to from-position for
  // pathological cases where metadata is missing.
  const a = range.metadata?.author ?? '';
  const t = range.metadata?.timestamp ?? '';
  return a && t ? `${a}|${t}` : `pos:${range.from}`;
}

function projectThread(
  thread: CommentThread,
  order: number,
  currentUser: string,
): { view: ThreadView; rangeByMessageId: Map<string, CriticMarkupRange> } {
  const rangeByMessageId = new Map<string, CriticMarkupRange>();

  const toMessage = (range: CriticMarkupRange): MessageView => {
    const id = messageIdFor(range);
    rangeByMessageId.set(id, range);
    return {
      id,
      author: range.metadata?.author ?? 'unknown',
      body: decodeCommentContent(range.content),
      timestamp: range.metadata?.timestamp ?? '',
      canModify: range.metadata?.author === currentUser,
    };
  };

  const root = toMessage(thread.comments[0]);
  const replies = thread.comments.slice(1).map(toMessage);

  return {
    view: {
      key: String(thread.from),
      root,
      replies,
      order,
      orphan: false, // criticmarkup is always in-band
    },
    rangeByMessageId,
  };
}

export function useThreadsFromYText(yText: Y.Text, currentUserName: string): AdapterResult {
  // Re-render on every yText change. useCommentsFromText already does this;
  // we use its output and wrap it with our own projection.
  const rawThreads = useCommentsFromText(yText).filter(
    (t) => t.comments[0]?.type === 'comment',
  );

  return useMemo<AdapterResult>(() => {
    const rangeByMessageId = new Map<string, CriticMarkupRange>();
    const threadByKey = new Map<ThreadKey, CommentThread>();

    const views: ThreadView[] = rawThreads.map((thread, i) => {
      threadByKey.set(String(thread.from), thread);
      const { view, rangeByMessageId: map } = projectThread(thread, i + 1, currentUserName);
      map.forEach((r, id) => rangeByMessageId.set(id, r));
      return view;
    });

    const callbacks: AdapterCallbacks = {
      onReply(thread, body) {
        const live = threadByKey.get(thread.key);
        if (!live) return;
        replyInYText(yText, body, live.to);
      },
      onEdit(message, body) {
        const range = rangeByMessageId.get(message.id);
        if (!range) return;
        editRangeContentInYText(yText, range, body);
      },
      onDelete(message) {
        const range = rangeByMessageId.get(message.id);
        if (!range) return;
        deleteRangeInYText(yText, range);
      },
      onAddComment(key, body) {
        const pos = Number(key);
        if (!Number.isFinite(pos)) return;
        insertCommentInYText(yText, body, pos);
      },
    };

    return { threads: views, callbacks };
  }, [rawThreads, yText, currentUserName]);
}
```

> **Note:** if `useCommentsFromText` doesn't already accept a `Y.Text` directly (the existing code accepts a string), the adapter needs an internal `useSyncExternalStore` to observe the yText and re-call `useCommentsFromText(yText.toString())`. Read `lens-editor/src/components/Comments/useCommentsFromText.ts` first to confirm; if it accepts a string, change the line to:
> ```ts
> const rawThreads = useCommentsFromText(yText.toString()).filter(...);
> ```
> and add a `useSyncExternalStore` subscription on `yText.observe`.

- [ ] **Step 4: Run the adapter test**

```bash
cd lens-editor && npx vitest run src/components/Comments/criticmarkupAdapter.test.ts
```

Expected: PASS. If the metadata format in the test fixture doesn't match the parser, read `lens-editor/src/lib/criticmarkup-parser.test.ts` for a canonical input and adapt the fixtures.

- [ ] **Step 5: Commit**

```bash
jj describe -m "comments: criticmarkup adapter producing ThreadView[] with per-parse closures" && jj new
```

---

## Task 5: Refactor `CommentCard` to consume `ThreadView`/`MessageView`

This is a full prop-shape change. The card becomes data-source-agnostic.

**Files:**
- Modify: `lens-editor/src/components/Comments/CommentCard.tsx`
- Modify: `lens-editor/src/components/Comments/CommentCard.test.tsx`

- [ ] **Step 1: Rewrite the test fixtures**

```tsx
// lens-editor/src/components/Comments/CommentCard.test.tsx
/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, within } from '@testing-library/react';
import { CommentCard } from './CommentCard';
import type { ThreadView, MessageView } from './types';

function makeMessage(over: Partial<MessageView> = {}): MessageView {
  return {
    id: 'm-1',
    author: 'alice',
    body: 'hi',
    timestamp: '2026-05-24T00:00:00Z',
    canModify: true,
    ...over,
  };
}

function makeThread(over: Partial<ThreadView> = {}): ThreadView {
  return {
    key: '100',
    root: makeMessage(),
    replies: [],
    order: 1,
    orphan: false,
    ...over,
  };
}

describe('CommentCard', () => {
  afterEach(cleanup);

  it('renders the root author, body, and badge number', () => {
    const t = makeThread();
    const { getByText } = render(
      <CommentCard
        thread={t}
        number={1}
        focused={false}
        currentUserName="alice"
        onFocus={vi.fn()}
        onReply={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    expect(getByText('alice')).toBeTruthy();
    expect(getByText('hi')).toBeTruthy();
    expect(getByText('1')).toBeTruthy();
  });

  it('shows Edit/Delete only when message.canModify is true', () => {
    const t = makeThread({ root: makeMessage({ canModify: false }) });
    const { queryByLabelText } = render(
      <CommentCard
        thread={t}
        focused={false}
        currentUserName="bob"
        onFocus={vi.fn()}
        onReply={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    expect(queryByLabelText('Edit')).toBeNull();
    expect(queryByLabelText('Delete')).toBeNull();
  });

  it('Edit click submits via onEdit with the message value', () => {
    const t = makeThread();
    const onEdit = vi.fn();
    const { getByLabelText, getByDisplayValue } = render(
      <CommentCard
        thread={t}
        focused
        currentUserName="alice"
        onFocus={vi.fn()}
        onReply={vi.fn()}
        onEdit={onEdit}
        onDelete={vi.fn()}
      />
    );
    fireEvent.click(getByLabelText('Edit'));
    const ta = getByDisplayValue('hi') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'updated' } });
    fireEvent.click(getByLabelText('Save'));
    expect(onEdit).toHaveBeenCalledWith(t.root, 'updated');
  });

  it('Reply submit calls onReply(thread, body)', () => {
    const t = makeThread();
    const onReply = vi.fn();
    const { getByLabelText, getByPlaceholderText } = render(
      <CommentCard
        thread={t}
        focused
        currentUserName="alice"
        onFocus={vi.fn()}
        onReply={onReply}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    fireEvent.click(getByLabelText('Reply'));
    fireEvent.change(getByPlaceholderText('Reply…'), { target: { value: 'thanks' } });
    fireEvent.click(getByLabelText('Send reply'));
    expect(onReply).toHaveBeenCalledWith(t, 'thanks');
  });

  it('Delete calls onDelete with the message value', () => {
    const t = makeThread();
    const onDelete = vi.fn();
    const { getByLabelText, getByText } = render(
      <CommentCard
        thread={t}
        focused
        currentUserName="alice"
        onFocus={vi.fn()}
        onReply={vi.fn()}
        onEdit={vi.fn()}
        onDelete={onDelete}
      />
    );
    fireEvent.click(getByLabelText('Delete'));
    // Confirm dialog
    fireEvent.click(getByText('Delete'));
    expect(onDelete).toHaveBeenCalledWith(t.root);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL — old prop signatures.

- [ ] **Step 3: Refactor `CommentCard.tsx`**

Read the existing file end-to-end first. Replace `CommentThread`/`CriticMarkupRange`-coupled code with `ThreadView`/`MessageView`. Key signature changes:

```ts
export interface CommentCardProps {
  thread: ThreadView;
  number?: number;
  focused: boolean;
  currentUserName: string;
  onFocus: (key: string) => void;
  onReply: (thread: ThreadView, body: string) => void;
  onEdit: (message: MessageView, newBody: string) => void;
  onDelete: (message: MessageView) => void;
}
```

Substitution map:
- `thread.comments[0]` → `thread.root`
- `thread.comments.slice(1)` → `thread.replies`
- `onReply(thread.to, content)` → `onReply(thread, content)`
- `reply-${reply.from}-${idx}` → `reply.id` (React key)
- `comment.metadata?.author` → `msg.author`
- `comment.metadata?.timestamp` → `msg.timestamp`
- `decodeCommentContent(comment.content)` → `msg.body` (already decoded by adapter)
- `onEdit(rangeIndex, newBody)` → `onEdit(msg, newBody)`
- `onDelete(rangeIndex)` → `onDelete(msg)`
- Owner check `metadata.author === currentUserName` → `msg.canModify`
- `onFocus(thread.from)` → `onFocus(thread.key)`

Drop the `decodeCommentContent` and `CriticMarkupRange` imports.

- [ ] **Step 4: Run the CommentCard tests**

```bash
cd lens-editor && npx vitest run src/components/Comments/CommentCard.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
jj describe -m "comments: CommentCard accepts ThreadView/MessageView (source-agnostic props)" && jj new
```

---

## Task 6: Refactor `CommentsLayer` to consume `threads: ThreadView[]` + callbacks

API change. Drops the `yText` dependency from the layer. Updates both callers (`Layout/EditorArea.tsx`, `EduEditor/EduEditor.tsx`) in the same commit so the build stays green.

**Files:**
- Modify: `lens-editor/src/components/Comments/CommentsLayer.tsx`
- Modify: `lens-editor/src/components/Comments/CommentsLayer.test.tsx`
- Modify: `lens-editor/src/components/Layout/EditorArea.tsx`
- Modify: `lens-editor/src/components/EduEditor/EduEditor.tsx`

- [ ] **Step 1: Rewrite `CommentsLayer.test.tsx` fixtures to pass `ThreadView[]` directly**

Read existing tests, then convert helpers from yText fixtures to:

```ts
import type { ThreadView } from './types';

function thread(over: Partial<ThreadView> = {}): ThreadView {
  return {
    key: '100',
    root: { id: 'm', author: 'a', body: 'b', timestamp: 't', canModify: true },
    replies: [],
    order: 1,
    orphan: false,
    ...over,
  };
}
```

Then refactor each test's `render(<CommentsLayer …/>)` to pass `threads`, `scrollSource` (a fake), `resolveAnchorY`, `getViewportRect`, and the new callbacks.

Fake scrollSource for tests:
```ts
const subs = new Set<() => void>();
const scrollSource = {
  getScrollTop: () => 0,
  getScrollHeight: () => 1000,
  getClientHeight: () => 500,
  subscribe: (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; },
};
```

Add new test cases:
- Anchored thread renders with positioned wrapper at `resolveAnchorY` result.
- Orphan thread renders in the orphan section (not absolutely positioned).
- `onFocusChange(key)` fires when card clicked.
- Imperative handle's `focusThread(key)` sets focus class via `editorRootRef`.

- [ ] **Step 2: Refactor `CommentsLayer.tsx` props + internals**

Replace prop types per design doc Task block:
```ts
export interface CommentsLayerProps {
  threads: ThreadView[];
  resolveAnchorY: (key: ThreadKey) => number | null;
  getViewportRect: () => { top: number; height: number };
  scrollSource: ScrollSource;
  editorRootRef?: RefObject<HTMLElement | null>;
  currentUserName: string;
  onFocusChange?: (key: ThreadKey | null) => void;
  onReply: (thread: ThreadView, body: string) => void;
  onEdit: (message: MessageView, newBody: string) => void;
  onDelete: (message: MessageView) => void;
  getInsertKey?: () => ThreadKey | null;
  onAddComment?: (key: ThreadKey, body: string) => void;
}

export interface CommentsLayerHandle {
  /** Idempotent set (not toggle). Focusing same key twice is a no-op. */
  focusThread(key: ThreadKey): void;
  openAddForm(): void;
}
```

Internal changes:
- Drop `useCommentsFromText` and yText observe — `threads` is already projected.
- `cardHeightsRef: Map<ThreadKey, number>`, `observersRef: Map<ThreadKey, ResizeObserver>`, `focusedThreadKey: ThreadKey | null`.
- `threadKeys = threads.map(t => t.key).join(',')` (stable dep).
- Layout/PAV input uses `t.key` instead of `t.from`; `resolveAnchorY(t.key)` instead of `mapper(thread.from)`.
- **Idempotent focus**: `focusThread(key)` sets `focusedThreadKey === key ? focusedThreadKey : key` — no toggle (toggle still applies to user clicks via `onFocus`, which still toggles).
- Wire `onFocusChange` next to every `setFocusedThreadKey` call.
- Class toggle effect at L130-141 uses `[data-comment-from="<key>"]` keyed by ThreadKey string.

Add the **orphan section** (anchored + sticky layout):
- Split `threads` into `anchored = threads.filter(t => !t.orphan)` and `orphans = threads.filter(t => t.orphan)`.
- Only `anchored` go through the layoutItems / weighted-PAV.
- Container restructure:
  ```tsx
  <div ref={layerRef} className="comments-layer flex flex-col h-full overflow-y-auto" onClick={…}>
    <div className="comments-sidebar__anchored sticky top-0 self-start w-full" style={{ height: getViewportRect().height, position: 'sticky' }}>
      {/* + Add button, pending form, anchored absolute-positioned cards */}
    </div>
    {orphans.length > 0 && (
      <div className="comments-sidebar__orphans px-2 py-3 border-t border-gray-100">
        <div className="text-xs font-medium text-gray-500 mb-2">Orphans</div>
        {orphans.map(t => (
          <div key={t.key} className="mb-2">
            <CommentCard thread={t} … />
          </div>
        ))}
      </div>
    )}
  </div>
  ```
- The anchored region's height should be the viewport height (from `getViewportRect()`) so PAV's layout space matches the visible editor area.

`handleAddSubmit` now calls `onAddComment(key, body)` instead of `insertCommentInYText` directly. Drop the `ytext-comment-ops` imports.

- [ ] **Step 3: Update `Layout/EditorArea.tsx`**

Replace the yText-driven `<CommentsLayer …/>` mount with adapter-driven:

```tsx
import { useThreadsFromYText } from '../Comments/criticmarkupAdapter';
import { useScrollSource } from '../Comments/useScrollSource';

// inside the component, near other state:
const { threads, callbacks } = useThreadsFromYText(yText, displayName ?? 'anonymous');
const scrollSource = useScrollSource(scrollContainerRef);

// mount:
<CommentsLayer
  ref={commentsLayerRef}
  threads={threads}
  resolveAnchorY={resolveAnchorY}
  getViewportRect={getViewportRect}
  scrollSource={scrollSource}
  editorRootRef={editorRootRef}
  currentUserName={displayName ?? 'anonymous'}
  onReply={callbacks.onReply}
  onEdit={callbacks.onEdit}
  onDelete={callbacks.onDelete}
  onAddComment={callbacks.onAddComment}
  getInsertKey={() => editorView ? String(editorView.state.selection.main.head) : null}
/>
```

- [ ] **Step 4: Update `EduEditor/EduEditor.tsx`**

Same pattern. Edu's `resolveAnchorY(offset: number)` becomes `resolveAnchorY(key: ThreadKey)`; wrap to parse the key:
```ts
const resolveAnchorYByKey = useCallback((key: ThreadKey) => {
  const n = Number(key);
  return Number.isFinite(n) ? originalResolveAnchorY(n) : null;
}, [originalResolveAnchorY]);
```

- [ ] **Step 5: Run all tests**

```bash
cd lens-editor && npx vitest run src/components/Comments/ src/components/Layout/ src/components/EduEditor/
```

Expected: PASS. If integration tests in `EditorArea.test.tsx` use yText fixtures, update them analogously.

- [ ] **Step 6: Commit**

```bash
jj describe -m "comments: CommentsLayer accepts ThreadView[]+callbacks; markdown/edu use adapter" && jj new
```

---

## Task 7: Bridge protocol extension — rects + `layoutVersion` + `setFocusedComment`

Schema-only change first. Wire up the bridge script in the next task.

**Files:**
- Modify: `lens-editor/src/components/HtmlEditor/bridge/protocol.ts`
- Modify: `lens-editor/src/components/HtmlEditor/bridge/protocol.test.ts` (or add one if missing)

- [ ] **Step 1: Add the protocol test**

```ts
// lens-editor/src/components/HtmlEditor/bridge/protocol.test.ts
import { describe, it, expect } from 'vitest';
import { validateEnvelope } from './protocol';

describe('protocol: commentsRendered with rects', () => {
  it('accepts rects + baselineScrollY + layoutVersion', () => {
    const env = {
      nonce: 'x',
      message: {
        type: 'commentsRendered',
        payload: {
          found: ['a'],
          orphaned: ['b'],
          rects: [{ id: 'a', y: 100, x: 0, w: 12, h: 12 }],
          baselineScrollY: 50,
          layoutVersion: 3,
        },
      },
    };
    expect(validateEnvelope(env)).toBe(true);
  });

  it('rejects rects with missing fields', () => {
    const env = {
      nonce: 'x',
      message: {
        type: 'commentsRendered',
        payload: {
          found: ['a'],
          orphaned: [],
          rects: [{ id: 'a' }],
          baselineScrollY: 0,
          layoutVersion: 0,
        },
      },
    };
    expect(validateEnvelope(env)).toBe(false);
  });
});

describe('protocol: setFocusedComment', () => {
  it('accepts { id: string } and { id: null }', () => {
    for (const id of ['abc', null]) {
      const env = { nonce: 'x', message: { type: 'setFocusedComment', payload: { id } } };
      expect(validateEnvelope(env)).toBe(true);
    }
  });
});

describe('protocol: scrollState carries layoutVersion', () => {
  it('accepts layoutVersion', () => {
    const env = {
      nonce: 'x',
      message: {
        type: 'scrollState',
        payload: { x: 0, y: 0, layoutVersion: 1 },
      },
    };
    expect(validateEnvelope(env)).toBe(true);
  });
});
```

- [ ] **Step 2: Extend `protocol.ts`**

Update `CommentsRenderedPayload`:
```ts
interface CommentRect { id: string; y: number; x: number; w: number; h: number }
interface CommentsRenderedPayload {
  found: string[];
  orphaned: string[];
  rects: CommentRect[];
  baselineScrollY: number;
  layoutVersion: number;
}
```

Add `setFocusedComment` to `ParentToBridge`:
```ts
| { type: 'setFocusedComment'; payload: { id: string | null } }
```

Update `PreviewScrollState` / `scrollState` payload to include `layoutVersion: number`.

Validator needs corresponding `isCommentRect`, `isCommentsRenderedPayload`, `isSetFocusedCommentPayload`, scrollState update.

- [ ] **Step 3: Run protocol tests**

```bash
cd lens-editor && npx vitest run src/components/HtmlEditor/bridge/protocol.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
jj describe -m "bridge: extend protocol with rects/layoutVersion/setFocusedComment" && jj new
```

---

## Task 8: Bridge script — emit rects, re-emit on layout-only changes, handle `setFocusedComment`

**Files:**
- Modify: `lens-editor/src/components/HtmlEditor/bridge/bridge-script.ts`
- Modify: bridge script tests (whatever exists under `bridge/`)

- [ ] **Step 1: Add tests for the new behaviors**

(Sketch — tailor to whatever harness `bridge/` already has.)
```ts
describe('bridge-script', () => {
  it('emits rects in commentsRendered', () => {
    // mount bridge in a fake iframe doc with two anchors, assert commentsRendered.rects[*]
  });

  it('re-emits commentsRendered on ResizeObserver(body)', () => {
    // resize body, expect a second commentsRendered with bumped layoutVersion
  });

  it('re-emits commentsRendered on <details> toggle', () => {
    // toggle a <details>, expect re-emit with bumped layoutVersion
  });

  it('scrollState includes the latest layoutVersion', () => {
    // emit a commentsRendered with v=5, then trigger scroll-state, assert v=5
  });

  it('setFocusedComment toggles data-comment-focused and survives rebuildDots', () => {
    // parent->bridge setFocusedComment{id:'a'}; assert data-attr present
    // trigger rebuildDots; assert data-attr still applied to the matching icon
    // setFocusedComment{id:null}; assert no element has the attr
  });
});
```

- [ ] **Step 2: Implementation**

In `bridge-script.ts`:

a) Maintain a monotonic counter:
```ts
let layoutVersion = 0;
function bumpLayoutVersion() { layoutVersion++; }
```

b) In `renderDots` (or after it computes anchor rects), capture each rect:
```ts
const rects = anchorIds.map(id => {
  const el = dotEls.get(id);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { id, x: r.left, y: r.top, w: r.width, h: r.height };
}).filter(Boolean);
```

c) Emit with `baselineScrollY: window.scrollY` (or the iframe's scroll equivalent) and `layoutVersion` after bumping it.

d) Add layout-only re-emit triggers:
```ts
const bodyRO = new ResizeObserver(() => { bumpLayoutVersion(); rebuildDots(); });
bodyRO.observe(document.body);

document.addEventListener('toggle', (e) => {
  if ((e.target as HTMLElement).tagName === 'DETAILS') { bumpLayoutVersion(); rebuildDots(); }
}, true);

window.addEventListener('resize', () => { bumpLayoutVersion(); rebuildDots(); });
```

e) `scroll-state` payload includes `layoutVersion`.

f) Handle `setFocusedComment`:
```ts
let lastFocusedId: string | null = null;
function applyFocusToDots() {
  for (const el of document.querySelectorAll('[data-comment-icon][data-comment-focused]')) {
    delete (el as HTMLElement).dataset.commentFocused;
  }
  if (lastFocusedId) {
    const el = dotEls.get(lastFocusedId);
    if (el) el.dataset.commentFocused = '';
  }
}
// In the parent->bridge handler:
if (msg.type === 'setFocusedComment') { lastFocusedId = msg.payload.id; applyFocusToDots(); }
// At the end of rebuildDots:
applyFocusToDots();
```

- [ ] **Step 3: Run bridge tests**

```bash
cd lens-editor && npx vitest run src/components/HtmlEditor/bridge/
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
jj describe -m "bridge: emit rects+layoutVersion; re-emit on layout events; setFocusedComment" && jj new
```

---

## Task 9: HTML adapter — `useThreadsFromHtmlYText` and `useIframeScrollSource`

**Files:**
- Create: `lens-editor/src/components/HtmlEditor/htmlCommentsAdapter.ts`
- Test: `lens-editor/src/components/HtmlEditor/htmlCommentsAdapter.test.ts`

- [ ] **Step 1: Write the test**

```ts
// lens-editor/src/components/HtmlEditor/htmlCommentsAdapter.test.ts
/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import * as Y from 'yjs';
import {
  useThreadsFromHtmlYText,
  effectiveY,
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
  it('subtracts scroll delta from rect y, then adds iframe top', () => {
    const y = effectiveY({ y: 100, x: 0, w: 10, h: 10 }, 50, 70, 200);
    // iframeTop + rect.y - (current - baseline) = 200 + 100 - (70 - 50)
    expect(y).toBe(280);
  });
});

describe('useThreadsFromHtmlYText', () => {
  it('orphan when no rect for the id', () => {
    const ytext = makeDoc();
    addComment(ytext, 'test', { id: 'c1', author: 'a', ts: 't', body: 'hi', position: 12 });
    const anchorState: AnchorState = new Map();
    const { result } = renderHook(() => useThreadsFromHtmlYText(ytext, anchorState, 'a'));
    expect(result.current.threads[0].orphan).toBe(true);
  });

  it('not orphan when rect present', () => {
    const ytext = makeDoc();
    addComment(ytext, 'test', { id: 'c1', author: 'a', ts: 't', body: 'hi', position: 12 });
    const anchorState: AnchorState = new Map([['c1', { y: 50, x: 0, w: 10, h: 10 }]]);
    const { result } = renderHook(() => useThreadsFromHtmlYText(ytext, anchorState, 'a'));
    expect(result.current.threads[0].orphan).toBe(false);
  });

  it('callbacks fire edit/delete on the right id', () => {
    const ytext = makeDoc();
    addComment(ytext, 'test', { id: 'c1', author: 'a', ts: 't', body: 'hi', position: 12 });
    const anchorState: AnchorState = new Map();
    const { result } = renderHook(() => useThreadsFromHtmlYText(ytext, anchorState, 'a'));
    const msg = result.current.threads[0].root;

    act(() => { result.current.callbacks.onEdit(msg, 'edited'); });
    expect(ytext.toString()).toContain('"body":"edited"');
  });
});
```

- [ ] **Step 2: Implement**

```ts
// lens-editor/src/components/HtmlEditor/htmlCommentsAdapter.ts
import { useMemo } from 'react';
import type * as Y from 'yjs';
import type { ThreadView, MessageView, ThreadKey, ScrollSource } from '../Comments/types';
import {
  parseComments,
  addReply,
  editMessage,
  deleteMessage,
  type CommentCluster,
} from './comment-store';
import { LENS_EDITOR_ORIGIN } from '../../lib/relay-api';

export interface AnchorRect { y: number; x: number; w: number; h: number }
export type AnchorState = Map<string, AnchorRect>;

export interface HtmlAdapterCallbacks {
  onReply: (thread: ThreadView, body: string) => void;
  onEdit: (message: MessageView, newBody: string) => void;
  onDelete: (message: MessageView) => void;
}

export interface HtmlAdapterResult {
  threads: ThreadView[];
  callbacks: HtmlAdapterCallbacks;
}

export function effectiveY(rect: AnchorRect, baselineScrollY: number, currentScrollY: number, iframeTop: number): number {
  return iframeTop + rect.y - (currentScrollY - baselineScrollY);
}

function projectCluster(cluster: CommentCluster, order: number, currentUser: string, orphan: boolean): ThreadView {
  const root: MessageView = {
    id: cluster.comment.id,
    author: cluster.comment.author,
    body: cluster.comment.body,
    timestamp: cluster.comment.ts,
    canModify: cluster.comment.author === currentUser,
  };
  const replies: MessageView[] = cluster.replies.map(r => ({
    id: r.id,
    author: r.author,
    body: r.body,
    timestamp: r.ts,
    canModify: r.author === currentUser,
  }));
  return { key: cluster.comment.id, root, replies, order, orphan };
}

export function useThreadsFromHtmlYText(
  yText: Y.Text,
  anchorState: AnchorState,
  currentUserName: string,
): HtmlAdapterResult {
  // Re-render on yText change via a useSyncExternalStore.
  const source = useExternalYTextString(yText);

  return useMemo<HtmlAdapterResult>(() => {
    const clusters = parseComments(source);
    const threads = clusters.map((c, i) =>
      projectCluster(c, i + 1, currentUserName, !anchorState.has(c.comment.id))
    );

    const callbacks: HtmlAdapterCallbacks = {
      onReply(thread, body) {
        addReply(yText, LENS_EDITOR_ORIGIN, {
          id: globalThis.crypto?.randomUUID?.() ?? `r-${Date.now()}`,
          parent: thread.key,
          author: currentUserName,
          ts: new Date().toISOString(),
          body,
        });
      },
      onEdit(message, body) {
        editMessage(yText, LENS_EDITOR_ORIGIN, { id: message.id, newBody: body });
      },
      onDelete(message) {
        deleteMessage(yText, LENS_EDITOR_ORIGIN, message.id);
      },
    };

    return { threads, callbacks };
  }, [source, anchorState, yText, currentUserName]);
}

// Minimal yText→string subscription. Lifted out so the hook re-renders cheaply.
function useExternalYTextString(yText: Y.Text): string {
  return useSyncExternalStore(
    (cb) => { yText.observe(cb); return () => yText.unobserve(cb); },
    () => yText.toString(),
  );
}
import { useSyncExternalStore } from 'react';

export interface IframeScrollSourceOptions {
  getState(): { scrollTop: number; scrollHeight: number; clientHeight: number };
}

/** ScrollSource backed by parent-cached bridge `scroll-state` messages. */
export function makeIframeScrollSource(opts: IframeScrollSourceOptions): ScrollSource & { notify(): void } {
  const subs = new Set<() => void>();
  return {
    getScrollTop: () => opts.getState().scrollTop,
    getScrollHeight: () => opts.getState().scrollHeight,
    getClientHeight: () => opts.getState().clientHeight,
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    notify() { subs.forEach(fn => fn()); },
  };
}
```

- [ ] **Step 3: Run the test**

```bash
cd lens-editor && npx vitest run src/components/HtmlEditor/htmlCommentsAdapter.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
jj describe -m "html-editor: comments adapter producing ThreadView[] with rect-resolved anchors" && jj new
```

---

## Task 10: Mount `CommentsLayer` in `HtmlEditor`; drop popover + orphan panel

**Files:**
- Modify: `lens-editor/src/components/HtmlEditor/HtmlEditor.tsx`
- Modify: `lens-editor/src/components/HtmlEditor/HtmlPreview.tsx`
- Delete: `lens-editor/src/components/HtmlEditor/CommentThread.tsx`
- Delete: `lens-editor/src/components/HtmlEditor/OrphanedCommentsPanel.tsx`
- Delete: `lens-editor/src/components/HtmlEditor/OrphanedCommentsPanel.test.tsx`

- [ ] **Step 1: Modify `HtmlPreview.tsx`**

a) Remove the `CommentThread` import and the popover mount at L970-980.

b) Remove local `openThreadId` state. Replace with new props:
```ts
interface HtmlPreviewProps {
  // …existing
  onDotClicked?: (id: string) => void;
  onCommentAdded?: (id: string) => void;
  onAnchorState?: (state: AnchorState) => void;
}
```

c) Where `dot-clicked` is currently handled, call `onDotClicked?.(payload.id)` instead of setting local state.

d) Where the bridge's `commentsRendered` arrives, build `anchorState` from `rects + baselineScrollY` and call `onAnchorState`:
```ts
const anchorState = new Map<string, AnchorRect>();
for (const r of payload.rects) anchorState.set(r.id, { y: r.y, x: r.x, w: r.w, h: r.h });
// Track baseline so the adapter / parent can apply effectiveY.
baselineScrollYRef.current = payload.baselineScrollY;
layoutVersionRef.current = payload.layoutVersion;
onAnchorState?.(anchorState);
```

e) Track scroll-state with `layoutVersion`:
```ts
if (msg.type === 'scrollState') {
  if (msg.payload.layoutVersion !== layoutVersionRef.current) return; // stale
  currentScrollYRef.current = msg.payload.y;
  // notify whoever cares (parent will, via a callback or by observing anchorState changes)
}
```

f) After successful `addComment(...)` in the placement flow, call `onCommentAdded?.(newId)`.

- [ ] **Step 2: Modify `HtmlEditor.tsx`**

Add:
```tsx
import { CommentsLayer, type CommentsLayerHandle } from '../Comments/CommentsLayer';
import {
  useThreadsFromHtmlYText,
  makeIframeScrollSource,
  effectiveY,
  type AnchorState,
} from './htmlCommentsAdapter';
import { useRef, useState, useMemo } from 'react';

// inside component:
const commentsLayerRef = useRef<CommentsLayerHandle>(null);
const [anchorState, setAnchorState] = useState<AnchorState>(new Map());
const baselineScrollYRef = useRef(0);
const currentScrollYRef = useRef(0);
const iframeRef = useRef<HTMLIFrameElement>(null);   // pass down to HtmlPreview

const iframeScrollState = useRef({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 });
const scrollSource = useMemo(
  () => makeIframeScrollSource({ getState: () => iframeScrollState.current }),
  []
);

const { threads, callbacks } = useThreadsFromHtmlYText(ytext, anchorState, currentUser);

const resolveAnchorY = (key: string) => {
  const r = anchorState.get(key);
  if (!r) return null;
  const iframeTop = iframeRef.current?.getBoundingClientRect().top ?? 0;
  return effectiveY(r, baselineScrollYRef.current, currentScrollYRef.current, iframeTop);
};

const getViewportRect = () => {
  const r = iframeRef.current?.getBoundingClientRect();
  return { top: r?.top ?? 0, height: r?.height ?? 0 };
};
```

In the JSX, replace the `<OrphanedCommentsPanel …/>` mount with the sidebar:
```tsx
{(mode === 'preview' || mode === 'split') && (
  <div className="w-80 flex-shrink-0 border-l border-gray-200 bg-gray-50/50">
    <CommentsLayer
      ref={commentsLayerRef}
      threads={threads}
      resolveAnchorY={resolveAnchorY}
      getViewportRect={getViewportRect}
      scrollSource={scrollSource}
      currentUserName={currentUser}
      onReply={callbacks.onReply}
      onEdit={callbacks.onEdit}
      onDelete={callbacks.onDelete}
      onFocusChange={(key) => {
        // Tell the bridge to focus the matching in-iframe icon.
        previewBridgeApi.current?.setFocusedComment(key);
      }}
    />
  </div>
)}
```

Pass new callbacks to `HtmlPreview`:
```tsx
<HtmlPreview
  …existing
  onDotClicked={(id) => commentsLayerRef.current?.focusThread(id)}
  onCommentAdded={(id) => commentsLayerRef.current?.focusThread(id)}
  onAnchorState={setAnchorState}
  // expose an imperative handle from HtmlPreview that wraps postToBridge
  ref={previewBridgeApi}
/>
```

(HtmlPreview needs a `forwardRef` returning `{ setFocusedComment: (id: string | null) => void }`. Implement that there as part of the same diff.)

- [ ] **Step 3: Delete obsolete files**

```bash
rm lens-editor/src/components/HtmlEditor/CommentThread.tsx
rm lens-editor/src/components/HtmlEditor/OrphanedCommentsPanel.tsx
rm lens-editor/src/components/HtmlEditor/OrphanedCommentsPanel.test.tsx
```

Remove their imports from `HtmlEditor.tsx`.

- [ ] **Step 4: Update / remove `OrphanedCommentsPanel.test.tsx` references**

Remove any `OrphanedCommentsPanel` imports from other tests; the orphan UX is now covered by `CommentsLayer.test.tsx`'s orphan-section cases.

- [ ] **Step 5: Run the HtmlEditor test suite**

```bash
cd lens-editor && npx vitest run src/components/HtmlEditor/
```

Expected: PASS. Some tests may need fixture updates (e.g., HtmlEditor integration test mocking the bridge).

- [ ] **Step 6: Run the full test suite**

```bash
cd lens-editor && npm test -- --run
```

Expected: same pass count as the baseline from pre-flight (or higher if new tests added).

- [ ] **Step 7: Run the dev server and smoke-test**

```bash
cd lens-editor && npm run dev:local
```

In another terminal, also start the relay (`npm run relay:start`). Open `http://dev.vps:5273/` to a doc with HTML preview content, verify:
- HTML preview renders comment icons in-iframe.
- Sidebar appears in Preview and Split modes (not Source).
- Click an in-iframe icon → corresponding sidebar card focuses.
- Click a sidebar card → in-iframe icon focuses.
- Create a comment via comment-mode → appears in sidebar.
- Orphan a comment (delete its anchor text via source mode, switch back) → appears in the Orphans section.
- Markdown editor still works (no regressions).

- [ ] **Step 8: Commit**

```bash
jj describe -m "html-editor: mount shared CommentsLayer sidebar; drop popover and OrphanedCommentsPanel" && jj new
```

---

## Task 11: HtmlEditor integration test

End-to-end coverage that the wiring actually works in a happy-dom render.

**Files:**
- Create: `lens-editor/src/components/HtmlEditor/HtmlEditor.sidebar.integration.test.tsx`

- [ ] **Step 1: Write the test**

```tsx
/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { HtmlEditor } from './HtmlEditor';
import { addComment } from './comment-store';
import { DisplayNameProvider } from '../../contexts/DisplayNameContext';

function setup() {
  const doc = new Y.Doc();
  const ytext = doc.getText('contents');
  ytext.insert(0, '<p>hello</p>');
  const awareness = new Awareness(doc);
  return { ytext, awareness };
}

describe('HtmlEditor sidebar integration', () => {
  afterEach(cleanup);

  it('renders existing comments in the sidebar (orphan section pre-bridge)', () => {
    const { ytext, awareness } = setup();
    addComment(ytext, 'origin', { id: 'c1', author: 'alice', ts: 't', body: 'hi', position: 12 });

    const r = render(
      <DisplayNameProvider value="alice">
        <HtmlEditor ytext={ytext} awareness={awareness} currentUser="alice" />
      </DisplayNameProvider>
    );

    // Sidebar shows the comment under Orphans (no bridge in happy-dom)
    expect(r.getByText('Orphans')).toBeTruthy();
    expect(r.getByText('hi')).toBeTruthy();
  });

  it('Reply via sidebar appends to the cluster', () => {
    const { ytext, awareness } = setup();
    addComment(ytext, 'origin', { id: 'c1', author: 'alice', ts: 't', body: 'hi', position: 12 });

    const r = render(
      <DisplayNameProvider value="alice">
        <HtmlEditor ytext={ytext} awareness={awareness} currentUser="alice" />
      </DisplayNameProvider>
    );

    fireEvent.click(r.getByLabelText('Reply'));
    fireEvent.change(r.getByPlaceholderText('Reply…'), { target: { value: 'ok' } });
    fireEvent.click(r.getByLabelText('Send reply'));

    expect(ytext.toString()).toContain('"body":"ok"');
  });
});
```

- [ ] **Step 2: Run it**

```bash
cd lens-editor && npx vitest run src/components/HtmlEditor/HtmlEditor.sidebar.integration.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
jj describe -m "html-editor: integration test for sidebar comment flow" && jj new
```

---

## Self-review checklist

Before declaring done:

- [ ] Run the full test suite: `cd lens-editor && npm test -- --run`. Compare pass/fail count to pre-flight baseline.
- [ ] Run typecheck: `cd lens-editor && npx tsc --noEmit`. Zero errors.
- [ ] Run lint: `cd lens-editor && npm run lint`. Zero new errors.
- [ ] Smoke test in browser (Task 10 Step 7 list).
- [ ] `jj log -r '@-::' --limit 12` shows commit history with one logical change per commit.

---

## Known follow-ups (out of scope for this plan)

- **Resize parity** for the HTML sidebar (markdown has a ResizeHandle via `Layout/EditorArea`). HtmlEditor sidebar is fixed-width 320px.
- **Brief orphan blink** when the user adds a comment locally — the new thread shows up via yText observer before the bridge re-emits rects. Smooth by deferring orphan flagging for ~1 rAF after a known local add.
- **Sticky positioning verification** — `position: sticky` in the sidebar column needs the outer flex container to have a defined height context. If the sticky inner anchored box doesn't pin as expected, add `display: flex; flex-direction: column; min-height: 0` to the column.
- **`<details>` `toggle` event bubbling** in non-Chromium browsers — capture-phase listener on `document` works in Chromium; verify in other engines or fall back to per-element delegation.
