# Responsive Layout Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the editor layout responsive — sidebars have pixel-based hard minimums, auto-collapse when space runs out, header progressively compacts, and the discussion panel becomes a proper resizable panel.

**Architecture:** Keep `react-resizable-panels` for drag-to-resize. Add a `useContainerWidth` hook (ResizeObserver) to dynamically recompute percentage-based `minSize` props from pixel values. A separate auto-collapse mechanism watches container width and imperatively collapses all sidebars when the editor content would go below its minimum. The header uses the same ResizeObserver pattern to progressively compact its items.

**Tech Stack:** React 19, react-resizable-panels ^4.6.5, Tailwind CSS v4, Vitest + @testing-library/react

---

## Layout Overview

Two nested panel groups:

```
Outer Group (App.tsx)
├── Panel#sidebar (left sidebar, 18% default, 200px min)
├── Separator
└── Panel#main-content (everything else)
    └── Inner Group (EditorArea.tsx)
        ├── Panel#editor (main content, 450px min)
        ├── Separator
        ├── Panel#right-sidebar (ToC/backlinks/comments, 22% default, 200px min)
        ├── Separator (conditional)
        └── Panel#discussion (conditional, 250px min) ← NEW: currently a fixed w-80 div
```

Auto-collapse threshold: when outer container width < sum of all pixel minimums, collapse all sidebars simultaneously. One-time trigger per threshold crossing — user can re-expand and they stay open.

---

### Task 1: Create `useContainerWidth` hook

A generic hook that uses ResizeObserver to track an element's width.

**Files:**
- Create: `lens-editor/src/hooks/useContainerWidth.ts`
- Create: `lens-editor/src/hooks/useContainerWidth.test.ts`

**Step 1: Write the failing test**

```typescript
// useContainerWidth.test.ts
import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useContainerWidth } from './useContainerWidth';

// Mock ResizeObserver
let resizeCallback: ResizeObserverCallback;
const mockObserve = vi.fn();
const mockDisconnect = vi.fn();

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    constructor(cb: ResizeObserverCallback) { resizeCallback = cb; }
    observe = mockObserve;
    disconnect = mockDisconnect;
    unobserve = vi.fn();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function triggerResize(width: number) {
  resizeCallback(
    [{ contentRect: { width } } as ResizeObserverEntry],
    {} as ResizeObserver,
  );
}

describe('useContainerWidth', () => {
  it('returns 0 initially when ref is not attached', () => {
    const { result } = renderHook(() => useContainerWidth());
    expect(result.current.width).toBe(0);
  });

  it('observes the element when ref is attached', () => {
    const { result } = renderHook(() => useContainerWidth());
    const div = document.createElement('div');
    // Simulate attaching ref
    (result.current.ref as React.MutableRefObject<HTMLElement | null>).current = div;
    // Re-render to trigger effect
    // (ResizeObserver is set up in useEffect, which runs after render)
  });

  it('updates width when ResizeObserver fires', () => {
    const div = document.createElement('div');
    const { result } = renderHook(() => {
      const hook = useContainerWidth();
      (hook.ref as React.MutableRefObject<HTMLElement | null>).current = div;
      return hook;
    });

    triggerResize(1200);
    expect(result.current.width).toBe(1200);

    triggerResize(800);
    expect(result.current.width).toBe(800);
  });

  it('disconnects observer on unmount', () => {
    const { unmount } = renderHook(() => useContainerWidth());
    unmount();
    expect(mockDisconnect).toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd lens-editor && npx vitest run src/hooks/useContainerWidth.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// useContainerWidth.ts
import { useRef, useState, useEffect } from 'react';

/**
 * Tracks an element's width via ResizeObserver.
 * Returns { ref, width } — attach ref to the element you want to observe.
 */
export function useContainerWidth() {
  const ref = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setWidth(entry.contentRect.width);
      }
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, []);  // ref.current is read inside effect, not a dependency

  return { ref, width };
}
```

**Step 4: Run test to verify it passes**

Run: `cd lens-editor && npx vitest run src/hooks/useContainerWidth.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat: add useContainerWidth hook for responsive layout
```

---

### Task 2: Extend SidebarContext for discussion panel + auto-collapse

Add discussion panel ref/toggle and a shared `autoCollapseAll` function to SidebarContext so both App.tsx and EditorArea.tsx can participate in coordinated collapse.

**Files:**
- Modify: `lens-editor/src/contexts/SidebarContext.tsx`
- Modify: `lens-editor/src/App.tsx` (provider value)

**Step 1: Update SidebarContext interface**

In `lens-editor/src/contexts/SidebarContext.tsx`, add to the interface:

```typescript
interface SidebarContextValue {
  toggleLeftSidebar: () => void;
  leftCollapsed: boolean;
  sidebarRef: RefObject<PanelImperativeHandle | null>;  // rename from implicit
  rightSidebarRef: RefObject<PanelImperativeHandle | null>;
  rightCollapsed: boolean;
  setRightCollapsed: (collapsed: boolean) => void;
  // New:
  discussionRef: RefObject<PanelImperativeHandle | null>;
  discussionCollapsed: boolean;
  setDiscussionCollapsed: (collapsed: boolean) => void;
  toggleDiscussion: () => void;
}
```

Update the default context value to include the new fields with sensible defaults.

**Step 2: Update App.tsx provider**

In `lens-editor/src/App.tsx`:
- Add `discussionRef = usePanelRef()` (line ~186 area)
- Add `[discussionCollapsed, setDiscussionCollapsed] = useState(true)` — collapsed by default since discussion panel is conditional
- Add `toggleDiscussion` callback (same pattern as toggleLeftSidebar/toggleRightSidebar)
- Update the `SidebarContext.Provider value` to include new fields
- Also pass `sidebarRef` (left sidebar ref) through context so it's available everywhere

**Step 3: Run existing tests to verify no regressions**

Run: `cd lens-editor && npx vitest run --reporter=verbose 2>&1 | tail -20`
Expected: All existing tests PASS

**Step 4: Commit**

```
feat: extend SidebarContext with discussion panel ref and toggle
```

---

### Task 3: Auto-collapse logic

Add a `useAutoCollapse` hook that watches container width and imperatively collapses all sidebars when the editor content would be squeezed below its minimum. Wire it into App.tsx.

**Files:**
- Create: `lens-editor/src/hooks/useAutoCollapse.ts`
- Create: `lens-editor/src/hooks/useAutoCollapse.test.ts`
- Modify: `lens-editor/src/App.tsx` (wire up)

**Step 1: Write the failing test**

```typescript
// useAutoCollapse.test.ts
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useAutoCollapse } from './useAutoCollapse';
import type { PanelImperativeHandle } from 'react-resizable-panels';

function mockPanelRef(collapsed = false): React.RefObject<PanelImperativeHandle> {
  return {
    current: {
      collapse: vi.fn(),
      expand: vi.fn(),
      isCollapsed: () => collapsed,
      isExpanded: () => !collapsed,
      getSize: () => collapsed ? 0 : 20,
      resize: vi.fn(),
    } as unknown as PanelImperativeHandle,
  };
}

describe('useAutoCollapse', () => {
  it('collapses all panels when width drops below threshold', () => {
    const leftRef = mockPanelRef();
    const rightRef = mockPanelRef();

    const { rerender } = renderHook(
      ({ width }) => useAutoCollapse({
        containerWidth: width,
        panelRefs: [leftRef, rightRef],
        pixelMinimums: [200, 200],   // sidebar minimums
        contentMinPx: 450,
      }),
      { initialProps: { width: 1200 } },
    );

    // Shrink below threshold (200 + 200 + 450 = 850)
    rerender({ width: 800 });

    expect(leftRef.current!.collapse).toHaveBeenCalled();
    expect(rightRef.current!.collapse).toHaveBeenCalled();
  });

  it('does NOT re-collapse after user re-expands', () => {
    const leftRef = mockPanelRef();
    const rightRef = mockPanelRef();

    const { rerender } = renderHook(
      ({ width }) => useAutoCollapse({
        containerWidth: width,
        panelRefs: [leftRef, rightRef],
        pixelMinimums: [200, 200],
        contentMinPx: 450,
      }),
      { initialProps: { width: 1200 } },
    );

    // Cross threshold
    rerender({ width: 800 });
    expect(leftRef.current!.collapse).toHaveBeenCalledTimes(1);

    // User expands (simulate), then resize again within narrow zone
    vi.mocked(leftRef.current!.collapse).mockClear();
    rerender({ width: 750 });

    // Should NOT collapse again — already fired for this crossing
    expect(leftRef.current!.collapse).not.toHaveBeenCalled();
  });

  it('resets and re-collapses on next threshold crossing', () => {
    const leftRef = mockPanelRef();
    const rightRef = mockPanelRef();

    const { rerender } = renderHook(
      ({ width }) => useAutoCollapse({
        containerWidth: width,
        panelRefs: [leftRef, rightRef],
        pixelMinimums: [200, 200],
        contentMinPx: 450,
      }),
      { initialProps: { width: 1200 } },
    );

    // First crossing
    rerender({ width: 800 });
    expect(leftRef.current!.collapse).toHaveBeenCalledTimes(1);

    // Go back above threshold
    rerender({ width: 1200 });

    // Cross threshold again
    vi.mocked(leftRef.current!.collapse).mockClear();
    rerender({ width: 800 });
    expect(leftRef.current!.collapse).toHaveBeenCalledTimes(1);
  });

  it('skips already-collapsed panels', () => {
    const leftRef = mockPanelRef(true);  // already collapsed
    const rightRef = mockPanelRef(false);

    renderHook(() => useAutoCollapse({
      containerWidth: 800,
      panelRefs: [leftRef, rightRef],
      pixelMinimums: [200, 200],
      contentMinPx: 450,
    }));

    expect(leftRef.current!.collapse).not.toHaveBeenCalled();
    expect(rightRef.current!.collapse).toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd lens-editor && npx vitest run src/hooks/useAutoCollapse.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// useAutoCollapse.ts
import { useRef, useEffect } from 'react';
import type { RefObject } from 'react';
import type { PanelImperativeHandle } from 'react-resizable-panels';

interface UseAutoCollapseOptions {
  /** Current container width in pixels (from useContainerWidth) */
  containerWidth: number;
  /** Refs to all collapsible panels */
  panelRefs: RefObject<PanelImperativeHandle | null>[];
  /** Pixel minimums for each panel (same order as panelRefs) */
  pixelMinimums: number[];
  /** Minimum content area width in pixels */
  contentMinPx: number;
}

/**
 * Auto-collapses all panels when the container is too narrow for content.
 * One-time trigger per threshold crossing — resets when going back above.
 */
export function useAutoCollapse({
  containerWidth,
  panelRefs,
  pixelMinimums,
  contentMinPx,
}: UseAutoCollapseOptions) {
  const hasCollapsedRef = useRef(false);

  const threshold = pixelMinimums.reduce((sum, px) => sum + px, 0) + contentMinPx;
  const isBelowThreshold = containerWidth > 0 && containerWidth < threshold;

  useEffect(() => {
    if (isBelowThreshold && !hasCollapsedRef.current) {
      // Collapse all panels that aren't already collapsed
      for (const ref of panelRefs) {
        const panel = ref.current;
        if (panel && !panel.isCollapsed()) {
          panel.collapse();
        }
      }
      hasCollapsedRef.current = true;
    } else if (!isBelowThreshold) {
      // Reset when going back above threshold
      hasCollapsedRef.current = false;
    }
  }, [isBelowThreshold, panelRefs]);
}
```

**Step 4: Run test to verify it passes**

Run: `cd lens-editor && npx vitest run src/hooks/useAutoCollapse.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat: add useAutoCollapse hook for responsive sidebar collapse
```

---

### Task 4: Dynamic pixel-based minSize for outer group (left sidebar)

Wire `useContainerWidth` into App.tsx to compute dynamic `minSize` percentages from pixel values for the left sidebar panel.

**Files:**
- Modify: `lens-editor/src/App.tsx`

**Step 1: Add container width tracking**

In `AuthenticatedApp` component (App.tsx:180), add:

```typescript
import { useContainerWidth } from './hooks/useContainerWidth';
import { useAutoCollapse } from './hooks/useAutoCollapse';
```

Inside the component:

```typescript
const { ref: outerRef, width: outerWidth } = useContainerWidth();

// Pixel minimums
const LEFT_SIDEBAR_MIN_PX = 200;
const CONTENT_MIN_PX = 450;
const RIGHT_SIDEBAR_MIN_PX = 200;

// Dynamic minSize as percentage (only when we have a width)
const leftMinPercent = outerWidth > 0
  ? Math.max((LEFT_SIDEBAR_MIN_PX / outerWidth) * 100, 1)
  : 12;

// Auto-collapse all sidebars when content would be squeezed
useAutoCollapse({
  containerWidth: outerWidth,
  panelRefs: [sidebarRef, rightSidebarRef],
  pixelMinimums: [LEFT_SIDEBAR_MIN_PX, RIGHT_SIDEBAR_MIN_PX],
  contentMinPx: CONTENT_MIN_PX,
});
```

**Step 2: Attach ref and update Panel props**

Change the outer `<div>` (currently `className="h-screen flex flex-col bg-gray-50"`) to also receive the ref:

```tsx
<div ref={outerRef} className="h-screen flex flex-col bg-gray-50">
```

Wait — the ref needs to go on the `Group` container, not the screen div. Actually, it should go on an element whose width represents the space available for panels. The `Group` element is `flex-1 min-h-0` — it fills the remaining height but its width is the full container width. So we should observe the div that wraps everything.

Actually, the outerRef should go on the `Group` parent or the Group itself. The `Group` component from react-resizable-panels doesn't forward refs directly, so we need to wrap it or observe a parent. The containing `div.h-screen` works — its width is the viewport width minus any margins.

Attach `ref={outerRef as React.RefObject<HTMLDivElement>}` to the `div.h-screen` at line 246.

Update the left sidebar Panel (line 281):

```tsx
<Panel
  id="sidebar"
  panelRef={sidebarRef}
  defaultSize="18%"
  minSize={`${leftMinPercent}%`}
  collapsible
  collapsedSize="0%"
  onResize={(size) => setLeftCollapsed(size.asPercentage === 0)}
>
```

**Step 3: Run existing tests**

Run: `cd lens-editor && npx vitest run --reporter=verbose 2>&1 | tail -20`
Expected: All tests PASS

**Step 4: Manual verification**

Start the dev server: `cd lens-editor && npm run dev:local`
Open browser, resize window. Left sidebar should hold 200px minimum as the window narrows. When the window goes below ~850px, both sidebars should auto-collapse.

**Step 5: Commit**

```
feat: dynamic pixel-based minSize for left sidebar
```

---

### Task 5: Dynamic pixel-based minSize for inner group (right sidebar)

Wire `useContainerWidth` into EditorArea.tsx for the right sidebar.

**Files:**
- Modify: `lens-editor/src/components/Layout/EditorArea.tsx`

**Step 1: Add container width tracking**

In EditorArea.tsx, the inner `<div className="flex-1 flex min-h-0">` at line 88 wraps the inner group. We need to observe its width.

```typescript
import { useContainerWidth } from '../../hooks/useContainerWidth';
```

Inside the component:

```typescript
const { ref: innerRef, width: innerWidth } = useContainerWidth();

const RIGHT_SIDEBAR_MIN_PX = 200;
const rightMinPercent = innerWidth > 0
  ? Math.max((RIGHT_SIDEBAR_MIN_PX / innerWidth) * 100, 1)
  : 14;
```

**Step 2: Attach ref and update Panel props**

Attach the ref to the flex container wrapping the inner group (line 88):

```tsx
<div ref={innerRef as React.RefObject<HTMLDivElement>} className="flex-1 flex min-h-0">
```

Update the right sidebar Panel (line 113):

```tsx
<Panel
  id="right-sidebar"
  panelRef={rightSidebarRef}
  defaultSize="22%"
  minSize={`${rightMinPercent}%`}
  collapsible
  collapsedSize="0%"
  onResize={(size) => setRightCollapsed(size.asPercentage === 0)}
>
```

**Step 3: Run existing tests**

Run: `cd lens-editor && npx vitest run --reporter=verbose 2>&1 | tail -20`
Expected: All tests PASS

**Step 4: Commit**

```
feat: dynamic pixel-based minSize for right sidebar
```

---

### Task 6: Upgrade discussion panel to resizable Panel

Move the discussion panel from a fixed `w-80` div into the `react-resizable-panels` group as a proper resizable, collapsible panel.

**Files:**
- Modify: `lens-editor/src/components/Layout/EditorArea.tsx`
- Modify: `lens-editor/src/components/DiscussionPanel/DiscussionPanel.tsx`
- Modify: `lens-editor/src/App.tsx` (header toggle button)

**Step 1: Update DiscussionPanel to remove fixed width**

In `lens-editor/src/components/DiscussionPanel/DiscussionPanel.tsx`, change the outer `<aside>` (line 57-58):

From:
```tsx
<aside
  className="w-80 flex-shrink-0 border-l border-gray-200 bg-white flex flex-col"
```

To:
```tsx
<aside
  className="h-full border-l border-gray-200 bg-white flex flex-col"
```

Remove `w-80` and `flex-shrink-0` — the Panel component now controls the width.

**Step 2: Move discussion panel inside the Group in EditorArea.tsx**

In `lens-editor/src/components/Layout/EditorArea.tsx`:

Add to imports and hooks:
```typescript
const { discussionRef, setDiscussionCollapsed } = useSidebar();
```

Add the discussion panel inside the Group (after the right sidebar panel), and add `order` props to all panels for conditional rendering stability:

```tsx
<Group id="editor-area" className="flex-1 min-h-0">
  <Panel id="editor" order={1} minSize="30%">
    {/* ... existing editor content ... */}
  </Panel>

  <Separator className="w-1 bg-gray-200 hover:bg-blue-400 focus:outline-none transition-colors cursor-col-resize" />

  <Panel id="right-sidebar" order={2} panelRef={rightSidebarRef} defaultSize="22%" minSize={`${rightMinPercent}%`} collapsible collapsedSize="0%" onResize={(size) => setRightCollapsed(size.asPercentage === 0)}>
    {/* ... existing right sidebar content ... */}
  </Panel>

  {hasDiscussion && (
    <>
      <Separator className="w-1 bg-gray-200 hover:bg-blue-400 focus:outline-none transition-colors cursor-col-resize" />
      <Panel
        id="discussion"
        order={3}
        panelRef={discussionRef}
        defaultSize="20%"
        minSize={`${discussionMinPercent}%`}
        collapsible
        collapsedSize="0%"
        onResize={(size) => setDiscussionCollapsed(size.asPercentage === 0)}
      >
        <ConnectedDiscussionPanel />
      </Panel>
    </>
  )}
</Group>
```

Where `hasDiscussion` is a prop or state that indicates whether the current document has a discussion field. This needs to be plumbed from the DiscussionPanel's internal logic. The simplest approach: have `ConnectedDiscussionPanel` always render (it returns `null` internally when no discussion exists), but wrap the Panel in a condition.

**Important:** The `ConnectedDiscussionPanel` currently returns `null` when there's no discussion. But now it's inside a Panel — we need the Panel itself to be conditional. Extract the `useDiscussion` hook usage to EditorArea level, or add a `useHasDiscussion` hook.

Create a simple hook:
```typescript
// In EditorArea.tsx or extract to a hook file
import { useYDoc } from '@y-sweet/react';

// Inside EditorArea, get whether discussion exists:
// This requires access to the Y.Doc, which is available via useYDoc() inside RelayProvider
```

Actually, `EditorArea` is already inside `RelayProvider`. So we can use `useYDoc()` to check frontmatter. But `useDiscussion` already does this — we just need to export the channelId check.

**Simplest approach:** Add a `useHasDiscussion` hook or just let `ConnectedDiscussionPanel` accept a `render` callback pattern. Or, even simpler: always render the Panel with the discussion, and have it collapse when there's no discussion content. The panel will just be empty.

Actually, the cleanest approach for conditional panels with react-resizable-panels is to use `order` props and conditionally render the Panel + Separator. The `hasDiscussion` state needs to come from somewhere accessible in EditorArea.

Let me adjust: Create a small `useHasDiscussion` hook:

```typescript
// lens-editor/src/components/DiscussionPanel/useHasDiscussion.ts
import { useYDoc } from '@y-sweet/react';
import { useDiscussion } from './useDiscussion';

export function useHasDiscussion(): boolean {
  const doc = useYDoc();
  const { channelId } = useDiscussion(doc);
  return !!channelId;
}
```

Then in EditorArea.tsx, import and use it to conditionally render the Panel.

**Step 3: Add discussion toggle button to header**

In `App.tsx`, add a third toggle button after the right sidebar toggle (line 267-277 area). Same pattern as the existing toggles but using `toggleDiscussion` and `discussionCollapsed` from SidebarContext. Use a chat bubble icon.

**Step 4: Update auto-collapse to include discussion panel**

In App.tsx, update the `useAutoCollapse` call to include the discussion ref when discussion is active. This means the auto-collapse hook needs to handle optional/conditional panels.

Modify the `panelRefs` and `pixelMinimums` arrays to conditionally include the discussion panel:

```typescript
const DISCUSSION_MIN_PX = 250;

// Build dynamic arrays based on which panels are active
const activeRefs = [sidebarRef, rightSidebarRef];
const activeMinimums = [LEFT_SIDEBAR_MIN_PX, RIGHT_SIDEBAR_MIN_PX];
// Discussion panel only counted if it exists and isn't already collapsed
// (We can check discussionRef.current !== null as a proxy)

useAutoCollapse({
  containerWidth: outerWidth,
  panelRefs: activeRefs,
  pixelMinimums: activeMinimums,
  contentMinPx: CONTENT_MIN_PX,
});
```

Note: The discussion panel's auto-collapse is trickier because it's conditionally rendered. For now, include it only when the panel exists.

**Step 5: Run tests**

Run: `cd lens-editor && npx vitest run --reporter=verbose 2>&1 | tail -20`
Expected: All tests PASS (some DiscussionPanel tests may need adjustment if they rely on the `w-80` class)

**Step 6: Commit**

```
feat: upgrade discussion panel to resizable collapsible Panel
```

---

### Task 7: Create `useHeaderBreakpoints` hook

A hook that returns the current responsive stage for the header based on its width.

**Files:**
- Create: `lens-editor/src/hooks/useHeaderBreakpoints.ts`
- Create: `lens-editor/src/hooks/useHeaderBreakpoints.test.ts`

**Step 1: Write the failing test**

```typescript
// useHeaderBreakpoints.test.ts
import { renderHook } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { useHeaderBreakpoints, type HeaderStage } from './useHeaderBreakpoints';

describe('useHeaderBreakpoints', () => {
  it('returns "full" for wide widths', () => {
    const { result } = renderHook(() => useHeaderBreakpoints(1200));
    expect(result.current).toBe('full');
  });

  it('returns "compact-toggles" below 1100px', () => {
    const { result } = renderHook(() => useHeaderBreakpoints(1050));
    expect(result.current).toBe('compact-toggles');
  });

  it('returns "hide-title" below 900px', () => {
    const { result } = renderHook(() => useHeaderBreakpoints(850));
    expect(result.current).toBe('hide-title');
  });

  it('returns "hide-username" below 750px', () => {
    const { result } = renderHook(() => useHeaderBreakpoints(700));
    expect(result.current).toBe('hide-username');
  });

  it('returns "overflow" below 600px', () => {
    const { result } = renderHook(() => useHeaderBreakpoints(550));
    expect(result.current).toBe('overflow');
  });

  it('returns "full" for zero width (not yet measured)', () => {
    const { result } = renderHook(() => useHeaderBreakpoints(0));
    expect(result.current).toBe('full');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd lens-editor && npx vitest run src/hooks/useHeaderBreakpoints.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// useHeaderBreakpoints.ts

export type HeaderStage =
  | 'full'             // > 1100px: everything visible
  | 'compact-toggles'  // < 1100px: toggles become icon-only
  | 'hide-title'       // < 900px: "Lens Editor" title hidden
  | 'hide-username'    // < 750px: display name hidden
  | 'overflow';        // < 600px: toggles move to overflow menu

const BREAKPOINTS: [number, HeaderStage][] = [
  [1100, 'compact-toggles'],
  [900, 'hide-title'],
  [750, 'hide-username'],
  [600, 'overflow'],
];

/**
 * Returns the current header responsive stage based on container width.
 * Pass the header's measured width (from useContainerWidth).
 */
export function useHeaderBreakpoints(headerWidth: number): HeaderStage {
  if (headerWidth === 0) return 'full'; // Not yet measured

  for (const [breakpoint, stage] of BREAKPOINTS) {
    if (headerWidth < breakpoint) return stage;
  }
  return 'full';
}
```

Note: This is a pure function wrapped as a hook for consistency. It could be a plain function, but keeping it as a hook allows future additions (e.g., debouncing).

Wait — the breakpoints are checked wrong. We want the NARROWEST matching stage. The loop should check from widest to narrowest:

Actually, looking at the logic: if width < 600, ALL conditions match. We want to return `'overflow'` (the narrowest). The array is ordered from widest breakpoint to narrowest. So if width < 600, it matches `< 1100`, `< 900`, `< 750`, `< 600` — and returns `'compact-toggles'` (the first match). That's wrong.

Fix: reverse the order — check narrowest breakpoint first:

```typescript
const BREAKPOINTS: [number, HeaderStage][] = [
  [600, 'overflow'],
  [750, 'hide-username'],
  [900, 'hide-title'],
  [1100, 'compact-toggles'],
];

export function useHeaderBreakpoints(headerWidth: number): HeaderStage {
  if (headerWidth === 0) return 'full';

  for (const [breakpoint, stage] of BREAKPOINTS) {
    if (headerWidth < breakpoint) return stage;
  }
  return 'full';
}
```

Now if width is 550: `550 < 600` → returns `'overflow'`. Correct.
If width is 700: `700 < 600`? No. `700 < 750`? Yes → returns `'hide-username'`. Correct.

**Step 4: Run test to verify it passes**

Run: `cd lens-editor && npx vitest run src/hooks/useHeaderBreakpoints.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat: add useHeaderBreakpoints hook for responsive header
```

---

### Task 8: Add `iconOnly` prop to SuggestionModeToggle

Make the toggle show just icons when the header is compact.

**Files:**
- Modify: `lens-editor/src/components/SuggestionModeToggle/SuggestionModeToggle.tsx`

**Step 1: Add iconOnly prop**

Add to the props interface:

```typescript
interface SuggestionModeToggleProps {
  view: EditorView | null;
  /** When true, show icons instead of text labels */
  iconOnly?: boolean;
}
```

**Step 2: Add icons for suggesting/editing**

Add two small SVG icon components inside the file (before the main component):

```typescript
// Pencil icon for "Editing" mode
function EditIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
      <path d="M2.695 14.763l-1.262 3.154a.5.5 0 00.65.65l3.155-1.262a4 4 0 001.343-.885L17.5 5.5a2.121 2.121 0 00-3-3L3.58 13.42a4 4 0 00-.885 1.343z" />
    </svg>
  );
}

// Chat bubble icon for "Suggesting" mode
function SuggestIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
      <path fillRule="evenodd" d="M10 2c-2.236 0-4.43.18-6.57.524C1.993 2.755 1 4.014 1 5.426v5.148c0 1.413.993 2.67 2.43 2.902 1.168.188 2.352.327 3.55.414.28.02.521.18.642.413l1.713 3.293a.75.75 0 001.33 0l1.713-3.293a.783.783 0 01.642-.413 41.102 41.102 0 003.55-.414c1.437-.231 2.43-1.49 2.43-2.902V5.426c0-1.413-.993-2.67-2.43-2.902A41.289 41.289 0 0010 2zM6.75 6a.75.75 0 000 1.5h6.5a.75.75 0 000-1.5h-6.5zm0 2.5a.75.75 0 000 1.5h3.5a.75.75 0 000-1.5h-3.5z" clipRule="evenodd" />
    </svg>
  );
}
```

**Step 3: Update toggle rendering**

In the edit-role toggle section (line 71-80), use `iconOnly` to switch labels:

```tsx
return (
  <SegmentedToggle
    leftLabel={iconOnly ? <SuggestIcon /> : "Suggesting"}
    rightLabel={iconOnly ? <EditIcon /> : "Editing"}
    leftTitle="Suggesting"
    rightTitle="Editing"
    value={isSuggestionMode ? 'left' : 'right'}
    onChange={handleChange}
    disabled={!view}
    ariaLabel="Toggle between suggesting and editing mode"
  />
);
```

Also update the locked badges for suggest/view roles — when `iconOnly`, show just the icon with a background:

```tsx
if (role === 'view') {
  return (
    <span className="inline-flex items-center px-3 py-1.5 rounded-md text-sm font-medium bg-red-100 text-red-800" title="Viewing">
      {iconOnly ? <svg ...>...</svg> : 'Viewing'}
    </span>
  );
}
```

Use an eye icon for "Viewing" mode.

**Step 4: Run tests**

Run: `cd lens-editor && npx vitest run --reporter=verbose 2>&1 | tail -20`
Expected: PASS (existing tests don't pass iconOnly, so they render with text labels as before)

**Step 5: Commit**

```
feat: add iconOnly prop to SuggestionModeToggle
```

---

### Task 9: Add `compact` prop to DisplayNameBadge

When compact, hide the name text and show just the first-letter avatar.

**Files:**
- Modify: `lens-editor/src/components/DisplayNameBadge/DisplayNameBadge.tsx`

**Step 1: Add compact prop**

```typescript
interface DisplayNameBadgeProps {
  /** When true, show only the avatar initial, hide name text */
  compact?: boolean;
}

export function DisplayNameBadge({ compact = false }: DisplayNameBadgeProps) {
```

**Step 2: Update display mode rendering**

When `compact` and not editing, show a circular avatar with the first letter:

```tsx
if (compact && !editing) {
  return (
    <button
      onClick={startEditing}
      title={displayName}
      className="w-8 h-8 rounded-full bg-gray-200 text-gray-700 text-sm font-medium flex items-center justify-center hover:bg-gray-300 transition-colors cursor-pointer"
    >
      {displayName.charAt(0).toUpperCase()}
    </button>
  );
}
```

The edit input stays the same regardless of compact mode (user needs to type).

**Step 3: Run tests**

Run: `cd lens-editor && npx vitest run --reporter=verbose 2>&1 | tail -20`
Expected: PASS

**Step 4: Commit**

```
feat: add compact prop to DisplayNameBadge
```

---

### Task 10: Create OverflowMenu component

A "..." dropdown button that collects header items that don't fit.

**Files:**
- Create: `lens-editor/src/components/OverflowMenu/OverflowMenu.tsx`
- Create: `lens-editor/src/components/OverflowMenu/index.ts`

**Step 1: Write the component**

```typescript
// OverflowMenu.tsx
import { useState, useRef, useEffect, type ReactNode } from 'react';

interface OverflowMenuProps {
  children: ReactNode;
}

/**
 * A "..." button that shows a dropdown with overflowed header items.
 */
export function OverflowMenu({ children }: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="p-1.5 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-700 transition-colors cursor-pointer"
        aria-label="More options"
        title="More options"
      >
        <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
          <path d="M10 3a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM10 8.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM11.5 15.5a1.5 1.5 0 10-3 0 1.5 1.5 0 003 0z" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50 min-w-48">
          <div className="flex flex-col gap-1 p-2">
            {children}
          </div>
        </div>
      )}
    </div>
  );
}
```

```typescript
// index.ts
export { OverflowMenu } from './OverflowMenu';
```

**Step 2: Run tests**

Run: `cd lens-editor && npx vitest run --reporter=verbose 2>&1 | tail -20`
Expected: PASS (no new test failures)

**Step 3: Commit**

```
feat: add OverflowMenu component for responsive header
```

---

### Task 11: Wire header responsive behavior in App.tsx

Connect `useContainerWidth` + `useHeaderBreakpoints` to the header, and conditionally render items based on the current stage.

**Files:**
- Modify: `lens-editor/src/App.tsx`
- Modify: `lens-editor/src/components/Layout/EditorArea.tsx` (portal content adapts)

**Step 1: Add header width tracking in App.tsx**

```typescript
import { useHeaderBreakpoints, type HeaderStage } from './hooks/useHeaderBreakpoints';
```

In AuthenticatedApp:

```typescript
const { ref: headerRef, width: headerWidth } = useContainerWidth();
const headerStage = useHeaderBreakpoints(headerWidth);
```

Attach `ref={headerRef}` to the `<header>` element (line 248).

**Step 2: Apply header stages**

Update the header JSX:

```tsx
<header ref={headerRef as React.RefObject<HTMLElement>} className="flex items-center justify-between px-4 py-2 bg-white shadow-sm border-b border-gray-200">
  <div className="flex items-center gap-6">
    {/* Left sidebar toggle — always visible */}
    <button onClick={toggleLeftSidebar} ...>...</button>

    {/* Title — hidden at 'hide-title' and narrower */}
    {(headerStage === 'full' || headerStage === 'compact-toggles') && (
      <h1 className="text-lg font-semibold text-gray-900">Lens Editor</h1>
    )}

    <div id="header-breadcrumb" />
  </div>
  <div className="flex items-center gap-4">
    <div id="header-controls" className="flex items-center gap-4" />

    {/* Display name — compact at 'hide-username', hidden at 'overflow' */}
    {headerStage !== 'overflow' && (
      <DisplayNameBadge compact={headerStage === 'hide-username'} />
    )}

    {/* Right sidebar toggle — always visible */}
    <button onClick={toggleRightSidebar} ...>...</button>
  </div>
</header>
```

**Step 3: Pass headerStage to editor controls portal**

The editor controls (SuggestionModeToggle, SourceModeToggle, etc.) are rendered via portal from EditorArea.tsx. They need to know the current header stage.

Option A: Add `headerStage` to SidebarContext (simplest, already used by EditorArea).
Option B: Create a separate context.
Option C: Use a data attribute on the header-controls div and read it.

Go with **Option A** — add `headerStage` to SidebarContext:

Update SidebarContext interface:
```typescript
headerStage: HeaderStage;
```

Pass it from App.tsx provider. In EditorArea.tsx, read `headerStage` from `useSidebar()`.

**Step 4: Update EditorArea portal content**

In EditorArea.tsx, where the portal content is rendered (lines 77-86):

```tsx
const { rightSidebarRef, setRightCollapsed, headerStage } = useSidebar();

// ...

{portalTarget && createPortal(
  headerStage === 'overflow' ? (
    <OverflowMenu>
      <SuggestionModeToggle view={editorView} iconOnly />
      <SourceModeToggle editorView={editorView} />
      <PresencePanel />
      <SyncStatus />
    </OverflowMenu>
  ) : (
    <>
      <DebugYMapPanel />
      <SuggestionModeToggle view={editorView} iconOnly={headerStage !== 'full'} />
      <SourceModeToggle editorView={editorView} />
      <PresencePanel />
      <SyncStatus />
    </>
  ),
  portalTarget
)}
```

Note: `DebugYMapPanel` goes into the overflow menu too (or is hidden — it's a debug tool).

**Step 5: Run all tests**

Run: `cd lens-editor && npx vitest run --reporter=verbose 2>&1 | tail -30`
Expected: PASS

**Step 6: Manual verification**

Start dev server, resize window through all breakpoints, verify:
1. > 1100px: Full header with text labels
2. < 1100px: Toggle labels become icons
3. < 900px: "Lens Editor" title disappears
4. < 750px: Display name disappears (shows avatar only)
5. < 600px: Toggles move to "..." dropdown

**Step 7: Commit**

```
feat: wire responsive header with progressive compaction
```

---

### Task 12: Integration verification and polish

Final pass to verify everything works together.

**Files:**
- Potentially any of the above files for fixes

**Step 1: Run full test suite**

Run: `cd lens-editor && npx vitest run --reporter=verbose 2>&1 | tail -40`
Expected: All tests PASS

**Step 2: Manual visual testing checklist**

Start dev server and verify each behavior:

- [ ] Wide window (1400px+): All panels visible, header fully populated
- [ ] Resize to 1100px: Suggestion toggle becomes icon-only
- [ ] Resize to 900px: "Lens Editor" title disappears
- [ ] Resize to 850px: Both sidebars auto-collapse simultaneously
- [ ] After auto-collapse: toggle buttons still work to re-expand
- [ ] Re-expand a sidebar, resize narrower: sidebar stays open (no re-collapse)
- [ ] Resize back above 850px, then below again: auto-collapse fires again
- [ ] Left sidebar holds 200px minimum when being dragged
- [ ] Right sidebar holds 200px minimum when being dragged
- [ ] Header at 750px: display name shows avatar only
- [ ] Header at 600px: toggles in overflow menu
- [ ] Discussion panel (on docs that have discussion): resizable, collapsible, has toggle button

**Step 3: Fix any issues found**

Address any visual or functional issues discovered during testing.

**Step 4: Commit**

```
fix: polish responsive layout edge cases
```
