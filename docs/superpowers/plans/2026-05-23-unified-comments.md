# Unified Comments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `CommentMargin` (file editor) and `EduCommentsSidebar` (course editor) with one shared margin-card comments component driven by a scroll-aware weighted-PAV layout algorithm.

**Architecture:** A single React component `CommentsLayer` reads comment threads directly from the document's Y.Text (Edu's existing pattern, generalised) and positions margin cards via a pure layout function. The component is mounted by both editors with a `resolveAnchorY(offset)` prop — the file editor wraps a single CodeMirror view's `coordsAtPos`; the course editor walks N per-section views. Focus is a single React state value; the existing inline numbered-badge widget is extended to per-section views so anchors render in both editors.

**Tech Stack:** React 18, TypeScript, CodeMirror 6 (`@codemirror/state`, `@codemirror/view`), Yjs / `y-codemirror.next`, Vitest + `@testing-library/react`.

**Spec:** [`docs/superpowers/specs/2026-05-23-unified-comments-design.md`](../specs/2026-05-23-unified-comments-design.md)

**Path convention:** All `src/...` paths in this plan are relative to `lens-editor/`. Run npm/vitest from `lens-editor/`.

---

## File map

**Create:**
- `lens-editor/src/components/Comments/CommentsLayer.tsx` — shared margin-cards container
- `lens-editor/src/components/Comments/CommentCard.tsx` — single thread card
- `lens-editor/src/components/Comments/AddCommentForm.tsx` — moved here from `CommentsPanel/`
- `lens-editor/src/components/Comments/useCommentsFromText.ts` — moved here from `CommentsPanel/useComments.ts` (only the `useCommentsFromText` export)
- `lens-editor/src/components/Comments/CommentCard.test.tsx`
- `lens-editor/src/components/Comments/CommentsLayer.test.tsx`
- `lens-editor/src/components/Comments/index.ts`
- `lens-editor/src/lib/weighted-pav-layout.ts` — pure layout algorithm
- `lens-editor/src/lib/weighted-pav-layout.test.ts`
- `lens-editor/src/lib/anchor-resolver.ts` — position-resolver helpers for one view / many views
- `lens-editor/src/lib/anchor-resolver.test.ts`

**Modify:**
- `lens-editor/src/components/Editor/extensions/criticmarkup.ts` — remove `focusedThreadField` and `focusCommentThread`; badge widget dispatches a DOM CustomEvent and reads its focused style from a `data-focused-thread` attribute on the editor root (set by `CommentsLayer`).
- `lens-editor/src/components/Layout/EditorArea.tsx` — replace `<CommentMargin>` with `<CommentsLayer>`.
- `lens-editor/src/components/SectionEditor/createSectionEditorView.ts` — include the criticmarkup extension so badges render in per-section views.
- `lens-editor/src/components/EduEditor/EduEditor.tsx` — replace `<EduCommentsSidebar>` with `<CommentsLayer>`.

**Delete:**
- `lens-editor/src/components/CommentMargin/` (entire directory)
- `lens-editor/src/components/CommentsPanel/` (entire directory)
- `lens-editor/src/components/EduEditor/EduCommentsSidebar.tsx`
- `lens-editor/src/lib/comment-layout.ts` + `.test.ts`
- `lens-editor/src/lib/comment-utils.ts` + `.test.ts` (EditorView-mediated insert/scroll — replaced by anchor-resolver and `ytext-comment-ops`)

**Keep & reuse:**
- `lens-editor/src/lib/ytext-comment-ops.ts` — all CRUD goes through here
- `lens-editor/src/lib/criticmarkup-parser.ts` — thread parsing
- `lens-editor/src/lib/format-timestamp.ts` — timestamp formatting
- `lens-editor/src/components/ConfirmDialog/` — delete confirmation

---

## Task 1 — Relocate AddCommentForm and useCommentsFromText

Move the two reusable primitives out of `CommentsPanel/` (which we'll delete) into the new `Comments/` directory so subsequent tasks can import from a stable location.

**Files:**
- Create: `lens-editor/src/components/Comments/AddCommentForm.tsx`
- Create: `lens-editor/src/components/Comments/useCommentsFromText.ts`
- Create: `lens-editor/src/components/Comments/index.ts`
- Modify: `lens-editor/src/components/EduEditor/EduCommentsSidebar.tsx` (update imports — Edu still uses this until Task 9)
- Modify: existing tests if they import from `CommentsPanel/`

- [ ] **Step 1: Copy `AddCommentForm.tsx` to new location**

Copy `lens-editor/src/components/CommentsPanel/AddCommentForm.tsx` → `lens-editor/src/components/Comments/AddCommentForm.tsx`. Contents unchanged.

- [ ] **Step 2: Copy `useCommentsFromText` to new location**

The current `lens-editor/src/components/CommentsPanel/useComments.ts` exports both `useComments(view)` (EditorView-coupled — we're discarding) and `useCommentsFromText(text)` (Y.Text-driven — we're keeping). Create `lens-editor/src/components/Comments/useCommentsFromText.ts` containing only the `useCommentsFromText` export. Open the old file, copy the implementation of `useCommentsFromText` and any imports it needs (likely `parseThreads`, `CommentThread` from `criticmarkup-parser`), and paste into the new file. Do not touch the old file yet.

- [ ] **Step 3: Create `Comments/index.ts` barrel**

```tsx
export { AddCommentForm } from './AddCommentForm';
export { useCommentsFromText } from './useCommentsFromText';
```

- [ ] **Step 4: Repoint `EduCommentsSidebar.tsx` imports**

In `lens-editor/src/components/EduEditor/EduCommentsSidebar.tsx`, change:
```tsx
import { useCommentsFromText } from '../CommentsPanel/useComments';
import { AddCommentForm } from '../CommentsPanel/AddCommentForm';
```
to:
```tsx
import { useCommentsFromText, AddCommentForm } from '../Comments';
```

- [ ] **Step 5: Run all tests to confirm nothing broke**

Run from `lens-editor/`:
```bash
npm test -- --run
```
Expected: same pass count as before this task. (The old `CommentsPanel/` still exists and its tests still pass against the old file.)

- [ ] **Step 6: Commit**

```bash
jj describe -m "comments: relocate AddCommentForm and useCommentsFromText to Comments/"
jj new -m "comments: weighted-PAV layout algorithm"
```

---

## Task 2 — Weighted-PAV layout algorithm (pure, fully testable)

The core of the new layout. Pure function: given anchors, heights, weights, gap, and bounds, return the y-position of each card. No DOM, no React. This task is TDD; tests come first.

**Files:**
- Create: `lens-editor/src/lib/weighted-pav-layout.ts`
- Create: `lens-editor/src/lib/weighted-pav-layout.test.ts`

- [ ] **Step 1: Write the public interface as a failing test**

Create `lens-editor/src/lib/weighted-pav-layout.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeWeightedLayout } from './weighted-pav-layout';

describe('computeWeightedLayout', () => {
  it('returns each card at its anchor when none overlap', () => {
    const result = computeWeightedLayout({
      items: [
        { key: 1, anchorY: 0,   height: 50, weight: 1 },
        { key: 2, anchorY: 100, height: 50, weight: 1 },
        { key: 3, anchorY: 200, height: 50, weight: 1 },
      ],
      gap: 8,
    });
    expect(result.get(1)).toBe(0);
    expect(result.get(2)).toBe(100);
    expect(result.get(3)).toBe(200);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
npm test -- --run weighted-pav-layout
```
Expected: FAIL with module-not-found.

- [ ] **Step 3: Create a minimal scaffold**

Create `lens-editor/src/lib/weighted-pav-layout.ts`:

```ts
export interface LayoutItem {
  key: number;
  anchorY: number;
  height: number;
  /** 0 = no displacement penalty; ∞ = hard pin (use Number.POSITIVE_INFINITY). */
  weight: number;
}

export interface LayoutInput {
  items: LayoutItem[];
  gap: number;
}

/**
 * Compute non-overlapping y-positions for a set of cards by minimising
 * Σ weight_i · (y_i − anchor_i)² subject to y_i + height_i + gap ≤ y_{i+1}.
 *
 * Returns a Map<key, top-y>.
 */
export function computeWeightedLayout(input: LayoutInput): Map<number, number> {
  const out = new Map<number, number>();
  for (const item of input.items) out.set(item.key, item.anchorY);
  return out;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
npm test -- --run weighted-pav-layout
```
Expected: PASS.

- [ ] **Step 5: Add a failing test for two-card equal-weight overlap**

Append to the test file:

```ts
it('merges two overlapping equal-weight cards to their midpoint', () => {
  const result = computeWeightedLayout({
    items: [
      { key: 1, anchorY: 0,  height: 50, weight: 1 },
      { key: 2, anchorY: 40, height: 50, weight: 1 }, // overlap
    ],
    gap: 8,
  });
  // Cards span (y1, y1+50) and (y2, y2+50). Constraint y2 ≥ y1 + 58.
  // Equal weights → minimise (y1)² + (y2-40)². With y2 = y1 + 58,
  // minimise y1² + (y1+18)². d/dy1 = 4y1 + 36 = 0 → y1 = -9, y2 = 49.
  expect(result.get(1)).toBeCloseTo(-9, 5);
  expect(result.get(2)).toBeCloseTo(49, 5);
});
```

- [ ] **Step 6: Run to confirm it fails**

Expected: FAIL — current scaffold returns anchors unchanged.

- [ ] **Step 7: Implement PAV with weighted blocks**

Replace the body of `computeWeightedLayout` in `lens-editor/src/lib/weighted-pav-layout.ts`:

```ts
/**
 * One block holds one or more adjacent cards that have been merged because
 * their overlap constraints became binding. Within a block the cards have
 * fixed relative offsets (each cardʼs top is `blockY + offset`); the block
 * as a whole slides along the y-axis as a rigid body.
 */
interface Block {
  /** Indices into `sorted` (sorted by anchorY). */
  members: number[];
  /** Sum of card heights + gaps within this block. */
  span: number;
  /** Pre-computed: blockY = (Σ w_k · (a_k − δ_k)) / Σ w_k where δ_k is the
   *  within-block offset of card k. ∞-weight pins blockY exactly. */
  blockY: number;
  /** Cached numerator/denominator so we can re-derive blockY after merges. */
  numer: number;
  denom: number;
  /** True if any member has infinite weight — block is pinned. */
  pinned: boolean;
  /** If pinned, the required blockY (first infinite-weight member's anchor − its offset). */
  pinnedY: number;
}

export function computeWeightedLayout(input: LayoutInput): Map<number, number> {
  const { items, gap } = input;
  const sorted = [...items].sort((a, b) => a.anchorY - b.anchorY);
  const out = new Map<number, number>();
  if (sorted.length === 0) return out;

  // δ_k for a single-member block is 0 (the card is the block).
  const blocks: Block[] = sorted.map((it, _i) => {
    const pinned = !isFinite(it.weight);
    return {
      members: [_i],
      span: it.height,
      blockY: it.anchorY,
      numer: pinned ? 0 : it.weight * it.anchorY,
      denom: pinned ? 0 : it.weight,
      pinned,
      pinnedY: it.anchorY,
    };
  });

  // Merge until no adjacent blocks violate the non-overlap constraint.
  let i = 0;
  while (i < blocks.length - 1) {
    const a = blocks[i];
    const b = blocks[i + 1];
    // Required separation: end of `a` + gap ≤ start of `b`.
    const aBottom = a.blockY + a.span;
    const bTop = b.blockY;
    if (bTop >= aBottom + gap) {
      i++;
      continue;
    }

    // Merge b into a. Card offsets within the new block:
    //   members of a keep their offsets (0..a.span - lastCardHeight)
    //   members of b get offset = (a.span + gap + their previous within-b offset)
    const offsetShift = a.span + gap;
    // Recompute b's numerator with shifted offsets:
    //   contribution per member k: w_k · (a_k − (oldDelta_k + offsetShift))
    //   = w_k · (a_k − oldDelta_k) − w_k · offsetShift
    // So new numer = b.numer − b.denom · offsetShift.
    const mergedNumer = a.numer + b.numer - b.denom * offsetShift;
    const mergedDenom = a.denom + b.denom;
    const mergedPinned = a.pinned || b.pinned;
    let mergedPinnedY = 0;
    if (mergedPinned) {
      // If both pinned, they must agree (pinnedY_a == pinnedY_b - offsetShift);
      // otherwise the constraints are infeasible and we let the later pin win
      // (focus changes are user-initiated; spec says focus is a hard pin and
      // the algorithm runs around it).
      if (b.pinned) {
        mergedPinnedY = b.pinnedY - offsetShift;
      } else {
        mergedPinnedY = a.pinnedY;
      }
    }
    let mergedBlockY: number;
    if (mergedPinned) {
      mergedBlockY = mergedPinnedY;
    } else if (mergedDenom === 0) {
      // All members have weight 0 — place block at a.blockY (no preference).
      mergedBlockY = a.blockY;
    } else {
      mergedBlockY = mergedNumer / mergedDenom;
    }

    const merged: Block = {
      members: [...a.members, ...b.members],
      span: a.span + gap + b.span,
      blockY: mergedBlockY,
      numer: mergedNumer,
      denom: mergedDenom,
      pinned: mergedPinned,
      pinnedY: mergedPinnedY,
    };
    blocks.splice(i, 2, merged);
    // Step back to re-check against the previous block.
    if (i > 0) i--;
  }

  // Expand blocks back into per-card positions.
  for (const block of blocks) {
    let offset = 0;
    for (let k = 0; k < block.members.length; k++) {
      const memberIdx = block.members[k];
      const item = sorted[memberIdx];
      out.set(item.key, block.blockY + offset);
      offset += item.height + gap;
    }
  }
  return out;
}
```

- [ ] **Step 8: Run the existing two tests; both should pass**

```bash
npm test -- --run weighted-pav-layout
```
Expected: PASS (2 tests).

- [ ] **Step 9: Add tests for asymmetric weights**

Append:

```ts
it('weights heavier card closer to its anchor', () => {
  const result = computeWeightedLayout({
    items: [
      { key: 1, anchorY: 0,  height: 50, weight: 1 },
      { key: 2, anchorY: 40, height: 50, weight: 9 }, // 9x heavier
    ],
    gap: 8,
  });
  // y2 = y1 + 58. Minimise 1·y1² + 9·(y1+18)². d/dy1 = 2y1 + 18·(y1+18) = 0
  // → 20·y1 = -324 → y1 = -16.2; y2 = 41.8 (closer to its anchor 40).
  expect(result.get(1)).toBeCloseTo(-16.2, 5);
  expect(result.get(2)).toBeCloseTo(41.8, 5);
});

it('treats infinite weight as a hard pin', () => {
  const result = computeWeightedLayout({
    items: [
      { key: 1, anchorY: 0,  height: 50, weight: 1 },
      { key: 2, anchorY: 40, height: 50, weight: Number.POSITIVE_INFINITY },
    ],
    gap: 8,
  });
  // Card 2 pinned at 40; card 1 must end ≤ 32; closest to its anchor 0 is -18.
  expect(result.get(2)).toBe(40);
  expect(result.get(1)).toBeCloseTo(-18, 5);
});

it('zero-weight card still respects overlap but does not pull', () => {
  const result = computeWeightedLayout({
    items: [
      { key: 1, anchorY: 0,  height: 50, weight: 1 },
      { key: 2, anchorY: 40, height: 50, weight: 0 },
    ],
    gap: 8,
  });
  // Only card 1 pulls. Card 1 stays at anchor 0; card 2 placed at 58.
  expect(result.get(1)).toBe(0);
  expect(result.get(2)).toBe(58);
});

it('chains overlap propagation across three cards', () => {
  const result = computeWeightedLayout({
    items: [
      { key: 1, anchorY: 0,  height: 50, weight: 1 },
      { key: 2, anchorY: 40, height: 50, weight: 1 },
      { key: 3, anchorY: 80, height: 50, weight: 1 },
    ],
    gap: 8,
  });
  // All three merge. Offsets within block: 0, 58, 116.
  // Minimise (y)² + (y+58-40)² + (y+116-80)² = y² + (y+18)² + (y+36)².
  // d/dy = 2y + 2(y+18) + 2(y+36) = 6y + 108 = 0 → y = -18.
  expect(result.get(1)).toBeCloseTo(-18, 5);
  expect(result.get(2)).toBeCloseTo(40, 5);
  expect(result.get(3)).toBeCloseTo(98, 5);
});

it('does not merge cards that already satisfy the gap', () => {
  const result = computeWeightedLayout({
    items: [
      { key: 1, anchorY: 0,   height: 50, weight: 1 },
      { key: 2, anchorY: 200, height: 50, weight: 1 },
    ],
    gap: 8,
  });
  expect(result.get(1)).toBe(0);
  expect(result.get(2)).toBe(200);
});

it('returns empty map for empty input', () => {
  expect(computeWeightedLayout({ items: [], gap: 8 }).size).toBe(0);
});
```

- [ ] **Step 10: Run all algorithm tests**

```bash
npm test -- --run weighted-pav-layout
```
Expected: PASS (7 tests).

- [ ] **Step 11: Commit**

```bash
jj describe -m "comments: weighted-PAV layout algorithm with tests"
jj new -m "comments: anchor resolver utilities"
```

---

## Task 3 — Anchor resolver utilities

Two small functions: one wraps a single CodeMirror view's `coordsAtPos`; one walks an ordered list of section views, finding which view's slice contains the offset.

**Files:**
- Create: `lens-editor/src/lib/anchor-resolver.ts`
- Create: `lens-editor/src/lib/anchor-resolver.test.ts`

- [ ] **Step 1: Write failing test for the single-view resolver**

Create `lens-editor/src/lib/anchor-resolver.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  resolveAnchorYFromView,
  resolveAnchorYFromSectionViews,
  type SectionViewEntry,
} from './anchor-resolver';

function makeView(coordsByPos: Map<number, { top: number; bottom: number }>) {
  return {
    coordsAtPos: (pos: number) => coordsByPos.get(pos) ?? null,
    scrollDOM: { getBoundingClientRect: () => ({ top: 0 }) } as Element,
  } as const;
}

describe('resolveAnchorYFromView', () => {
  it('returns the top y from coordsAtPos', () => {
    const view = makeView(new Map([[42, { top: 123, bottom: 145 }]]));
    expect(resolveAnchorYFromView(view as any, 42)).toBe(123);
  });

  it('returns null when coordsAtPos returns null', () => {
    const view = makeView(new Map());
    expect(resolveAnchorYFromView(view as any, 42)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
npm test -- --run anchor-resolver
```
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the resolver module**

Create `lens-editor/src/lib/anchor-resolver.ts`:

```ts
import type { EditorView } from '@codemirror/view';

/**
 * Resolve the screen-y of a Y.Text offset by asking a CodeMirror view where it
 * renders that position. Returns null if the position is not currently
 * rendered (e.g. inside a collapsed fold).
 */
export function resolveAnchorYFromView(
  view: EditorView,
  offset: number,
): number | null {
  const coords = view.coordsAtPos(offset);
  return coords ? coords.top : null;
}

/**
 * A section editor mounted in the course editor: a CodeMirror view rendering a
 * slice of the underlying Y.Text from `yTextFrom` (inclusive) to `yTextTo`
 * (exclusive). Local CM positions are `offset - yTextFrom`.
 */
export interface SectionViewEntry {
  view: EditorView;
  yTextFrom: number;
  yTextTo: number;
}

/**
 * Resolve a Y.Text offset across many section views. Walks the entries to find
 * the one whose slice contains the offset, then asks that view for the screen
 * y. Returns null if no section owns the offset or its view doesn't render it.
 */
export function resolveAnchorYFromSectionViews(
  entries: readonly SectionViewEntry[],
  offset: number,
): number | null {
  for (const entry of entries) {
    if (offset >= entry.yTextFrom && offset < entry.yTextTo) {
      const localPos = offset - entry.yTextFrom;
      return resolveAnchorYFromView(entry.view, localPos);
    }
  }
  return null;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
npm test -- --run anchor-resolver
```
Expected: PASS (2 tests).

- [ ] **Step 5: Add a failing test for the multi-view resolver**

Append:

```ts
describe('resolveAnchorYFromSectionViews', () => {
  it('finds the right section and translates to local position', () => {
    const viewA = makeView(new Map([[5, { top: 100, bottom: 120 }]]));
    const viewB = makeView(new Map([[3, { top: 250, bottom: 270 }]]));
    const entries: SectionViewEntry[] = [
      { view: viewA as any, yTextFrom: 0,  yTextTo: 50 },
      { view: viewB as any, yTextFrom: 50, yTextTo: 100 },
    ];
    // Offset 53 falls in viewB; local pos = 53 - 50 = 3.
    expect(resolveAnchorYFromSectionViews(entries, 53)).toBe(250);
    // Offset 5 falls in viewA; local pos = 5.
    expect(resolveAnchorYFromSectionViews(entries, 5)).toBe(100);
  });

  it('returns null when no section owns the offset', () => {
    const viewA = makeView(new Map());
    const entries: SectionViewEntry[] = [
      { view: viewA as any, yTextFrom: 0, yTextTo: 50 },
    ];
    expect(resolveAnchorYFromSectionViews(entries, 999)).toBeNull();
  });
});
```

- [ ] **Step 6: Run to confirm all four tests pass**

```bash
npm test -- --run anchor-resolver
```
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
jj describe -m "comments: anchor-resolver utilities (single-view and section-views)"
jj new -m "comments: CommentCard component"
```

---

## Task 4 — CommentCard component

Single-thread card. Renders the root + replies, owner-only Edit/Delete actions, Reply form. No layout logic — accepts an absolute `top` and renders at that position.

**Files:**
- Create: `lens-editor/src/components/Comments/CommentCard.tsx`
- Create: `lens-editor/src/components/Comments/CommentCard.test.tsx`

- [ ] **Step 1: Write a failing render test**

Create `lens-editor/src/components/Comments/CommentCard.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CommentCard } from './CommentCard';
import type { CommentThread } from '../../lib/criticmarkup-parser';

function thread(): CommentThread {
  return {
    from: 0,
    to: 10,
    comments: [
      {
        type: 'comment',
        from: 0,
        to: 10,
        contentFrom: 2,
        contentTo: 8,
        content: 'Hello world',
        metadata: { author: 'Alice', timestamp: 1700000000000 },
      },
    ],
  };
}

describe('CommentCard', () => {
  it('renders the root content and author', () => {
    render(
      <CommentCard
        thread={thread()}
        top={100}
        focused={false}
        currentUserName="Bob"
        onFocus={vi.fn()}
        onReply={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText('Hello world')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test -- --run CommentCard
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Create `lens-editor/src/components/Comments/CommentCard.tsx`. The implementation should:
- Render absolutely positioned at `props.top`.
- Show root comment then each reply, indented with a left border.
- Per-comment: author + relative timestamp via `formatTimestamp` from `src/lib/format-timestamp`.
- Owner detection: a reply is the current user's if `range.metadata.author === currentUserName`. Use `isOwnRange` from `ytext-comment-ops` only if it matches that contract; otherwise inline the comparison.
- Render Reply button always; Edit/Delete only on owner's comments.
- Reply form: hidden until Reply is clicked; uses `AddCommentForm`.
- Edit form: when edit clicked on a comment, swap that comment's body for an `AddCommentForm` pre-filled with the content; submitting calls `onEdit(rangeIndex, newContent)`.
- Delete: show `ConfirmDialog` then call `onDelete(rangeIndex)`.
- Card root has `data-thread-from={thread.from}` and a `comments-card focused` class when `focused`.
- Click on card root (outside form/buttons) calls `onFocus(thread.from)`.

Reference `lens-editor/src/components/CommentMargin/CommentCard.tsx` and `lens-editor/src/components/EduEditor/EduCommentsSidebar.tsx` for visual style — match Edu's warm-card look (white background, `#e8e5df` border, subtle shadow on focus). Tailwind utility classes are fine; existing files use them.

Use this prop signature:

```tsx
import type { CommentThread } from '../../lib/criticmarkup-parser';

export interface CommentCardProps {
  thread: CommentThread;
  top: number;
  focused: boolean;
  currentUserName: string;
  onFocus: (threadFrom: number) => void;
  onReply: (threadEndPos: number, content: string) => void;
  onEdit: (rangeIndex: number, newContent: string) => void;
  onDelete: (rangeIndex: number) => void;
}

export function CommentCard(props: CommentCardProps): JSX.Element { /* ... */ }
```

The card must use `position: absolute; top: <props.top>px; right: 0; width: 100%` styling so the parent column controls the geometry.

- [ ] **Step 4: Run the render test**

```bash
npm test -- --run CommentCard
```
Expected: PASS.

- [ ] **Step 5: Add a test for owner-only Edit/Delete visibility**

Append:

```tsx
it('shows Edit and Delete only when the current user is the author', () => {
  const t = thread();
  const { rerender } = render(
    <CommentCard
      thread={t}
      top={0}
      focused
      currentUserName="Alice"
      onFocus={vi.fn()} onReply={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()}
    />,
  );
  expect(screen.queryByRole('button', { name: /edit/i })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /delete/i })).toBeInTheDocument();

  rerender(
    <CommentCard
      thread={t}
      top={0}
      focused
      currentUserName="Bob"
      onFocus={vi.fn()} onReply={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()}
    />,
  );
  expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
});

it('calls onFocus when the card is clicked', async () => {
  const onFocus = vi.fn();
  const { container } = render(
    <CommentCard
      thread={thread()}
      top={0} focused={false} currentUserName="Bob"
      onFocus={onFocus} onReply={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()}
    />,
  );
  (container.firstChild as HTMLElement).click();
  expect(onFocus).toHaveBeenCalledWith(0);
});
```

- [ ] **Step 6: Run all card tests**

```bash
npm test -- --run CommentCard
```
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
jj describe -m "comments: CommentCard component"
jj new -m "comments: CommentsLayer container"
```

---

## Task 5 — CommentsLayer container

The shared component. Subscribes to a Y.Text, computes weighted layout each scroll/resize/data change, renders cards via `CommentCard`. Mounts an empty-state hint when there are no comments. Owns focus state.

**Files:**
- Create: `lens-editor/src/components/Comments/CommentsLayer.tsx`
- Create: `lens-editor/src/components/Comments/CommentsLayer.test.tsx`

- [ ] **Step 1: Define the public interface and a smoke render test**

Create `lens-editor/src/components/Comments/CommentsLayer.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import * as Y from 'yjs';
import { CommentsLayer } from './CommentsLayer';

function makeYDoc(initialText: string) {
  const doc = new Y.Doc();
  const yt = doc.getText('contents');
  yt.insert(0, initialText);
  return { doc, yt };
}

describe('CommentsLayer', () => {
  beforeEach(() => {
    // jsdom: stub ResizeObserver
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  it('renders nothing when the Y.Text has no comments', () => {
    const { yt } = makeYDoc('Just plain prose.');
    const { container } = render(
      <CommentsLayer
        yText={yt}
        resolveAnchorY={() => 0}
        getViewportRect={() => ({ top: 0, height: 800 })}
        scrollContainerRef={{ current: null }}
        currentUserName="Bob"
      />,
    );
    // Empty-state hint, but no card.
    expect(container.querySelectorAll('[data-thread-from]')).toHaveLength(0);
    expect(screen.getByText(/no comments yet/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test -- --run CommentsLayer
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Create `lens-editor/src/components/Comments/CommentsLayer.tsx`. Key behaviour:

```tsx
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import type * as Y from 'yjs';
import { useCommentsFromText } from './useCommentsFromText';
import { CommentCard } from './CommentCard';
import { AddCommentForm } from './AddCommentForm';
import { computeWeightedLayout, type LayoutItem } from '../../lib/weighted-pav-layout';
import {
  insertCommentInYText,
  replyInYText,
  editRangeContentInYText,
  deleteRangeInYText,
} from '../../lib/ytext-comment-ops';

const ACTIVE_WINDOW_MULTIPLIER = 2;
const CARD_GAP = 10;

export interface CommentsLayerProps {
  /** Y.Text containing the document content. */
  yText: Y.Text;
  /** Resolve a Y.Text offset to a screen y, or null if not currently rendered. */
  resolveAnchorY: (offset: number) => number | null;
  /** Current visible viewport in the same coordinate space as resolveAnchorY. */
  getViewportRect: () => { top: number; height: number };
  /** Scroll container shared with the editor; the column listens to its scroll. */
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  /** Editor root element to which the layer writes data-focused-thread for CSS-driven badge styling. */
  editorRootRef?: React.RefObject<HTMLElement | null>;
  /** Current user's display name for owner detection. */
  currentUserName: string;
  /** Where new "Add" inserts. If omitted, no Add button is shown. */
  insertCursorPos?: number | null;
}

export function CommentsLayer(props: CommentsLayerProps): JSX.Element { /* ... */ }
```

Implementation requirements:

1. **Read threads**: call `useCommentsFromText(yText)` and filter to comment-type threads only (ignore additions/deletions which the criticmarkup extension also produces).

2. **Card heights**: `cardHeightsRef = useRef(new Map<number, number>())`. On each card mount, attach a `ResizeObserver` to its DOM and write its height into the map keyed by `thread.from`. When the map changes, trigger a relayout. Clean up on unmount.

3. **Layout computation** in a `useLayoutEffect` that depends on `[threads, focusedThreadKey, layoutTick]`, where `layoutTick` is a `useState<number>` bumped by scroll / resize / ResizeObserver events:
   - Get the viewport via `props.getViewportRect()`.
   - For each thread, call `props.resolveAnchorY(thread.from)`. If null, exclude.
   - For each remaining thread, compute the in-viewport relative y `vy = anchorY − viewport.top` and weight = `clamp01(1 − |vy − viewport.height/2| / (viewport.height/2))`.
   - Cards whose anchor is outside `[viewport.top − N·vh, viewport.top + (N+1)·vh]` (where `N = ACTIVE_WINDOW_MULTIPLIER`) are excluded from the optimisation entirely; they get placed at their raw `anchorY` with no overlap-block participation. (Simpler implementation: include them with `weight: 0` — the PAV algorithm already handles this correctly. Use this approach.)
   - If `focusedThreadKey === thread.from`, override weight to `Number.POSITIVE_INFINITY`.
   - Build the `items: LayoutItem[]` array with `{ key: thread.from, anchorY, height: cardHeights.get(thread.from) ?? DEFAULT_HEIGHT, weight }`.
   - Call `computeWeightedLayout({ items, gap: CARD_GAP })`.
   - Store result in state used by the render.

4. **Scroll/resize triggers**: `useEffect` attaches a `scroll` listener to `scrollContainerRef.current` and a `resize` observer to it; both call `setLayoutTick(t => t + 1)` via `requestAnimationFrame`. Clean up on unmount.

5. **Focus state**: `useState<number | null>(null)`. Setter is `setFocus(threadFrom: number | null)`. Whenever it changes, also write/remove `data-focused-thread` on `props.editorRootRef.current` if provided.

6. **Inline badge click listener**: `useEffect` adds a `comment-badge-focus` listener on `document` (the criticmarkup extension dispatches this CustomEvent with `detail: { threadFrom }`). Listener calls `setFocus(detail.threadFrom)`.

7. **Render**:
   - Wrapper `<div className="comments-layer" />` with `position: absolute` filling the column space; relies on parent for sizing.
   - Filter strip (All / Mine) at top, sticky.
   - One `<CommentCard>` per thread with computed `top` (or, for excluded threads, their raw anchor — never rendered visibly if outside the active window, but still keep them mounted for measurement stability).
   - Empty-state hint when `threads.length === 0`: "No comments yet. Select text and click Add."
   - "Add" button in the filter strip when `insertCursorPos != null`; opens an `AddCommentForm` that calls `insertCommentInYText(yText, content, insertCursorPos)` and focuses the new comment.

8. **CRUD wiring**:
   - `onReply(threadEndPos, content)` → `replyInYText(yText, content, threadEndPos)`.
   - `onEdit(rangeIndex, newContent)` → `editRangeContentInYText(yText, threads[i].comments[rangeIndex], newContent)`.
   - `onDelete(rangeIndex)` → `deleteRangeInYText(yText, threads[i].comments[rangeIndex])`.

9. **Mine filter**: filter the rendered cards to those where the current user authored the root comment.

- [ ] **Step 4: Run the smoke test**

```bash
npm test -- --run CommentsLayer
```
Expected: PASS.

- [ ] **Step 5: Add a test that a single comment renders with computed top**

Append to `CommentsLayer.test.tsx`:

```tsx
it('renders a card for each comment with the resolver-supplied y', async () => {
  // CriticMarkup syntax: {>>{metadata}@@encoded<<}
  const meta = JSON.stringify({ author: 'Alice', timestamp: 1700000000000 });
  const { yt } = makeYDoc(`Hello {>>{${meta}}@@first<<} world.`);

  const { container } = render(
    <CommentsLayer
      yText={yt}
      resolveAnchorY={(_offset) => 222}
      getViewportRect={() => ({ top: 0, height: 800 })}
      scrollContainerRef={{ current: null }}
      currentUserName="Bob"
    />,
  );

  const cards = container.querySelectorAll('[data-thread-from]');
  expect(cards.length).toBe(1);
  // top defaults to the resolver value when uncrowded.
  expect((cards[0] as HTMLElement).style.top).toBe('222px');
});
```

- [ ] **Step 6: Run all CommentsLayer tests**

```bash
npm test -- --run CommentsLayer
```
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
jj describe -m "comments: CommentsLayer container with weighted-PAV layout"
jj new -m "comments: simplify criticmarkup focus to CSS-attr + CustomEvent"
```

---

## Task 6 — Simplify criticmarkup extension focus

Remove `focusedThreadField` and `focusCommentThread` from `criticmarkup.ts`. Badge widget click handler dispatches a CustomEvent on `document` (not on `view.dom`) with `detail: { threadFrom }`. Focused styling is purely CSS-driven via an attribute set by `CommentsLayer` on the editor root.

**Files:**
- Modify: `lens-editor/src/components/Editor/extensions/criticmarkup.ts`
- Modify: `lens-editor/src/components/Editor/extensions/criticmarkup.test.ts` (drop tests for the removed exports)
- Modify: any callers of `focusCommentThread` / `focusedThreadField` (search across `src/`)

- [ ] **Step 1: Audit callers**

Run from `lens-editor/`:
```bash
grep -rn "focusedThreadField\|focusCommentThread" src/ --include="*.ts" --include="*.tsx"
```
Note every hit. They will be: the extension file itself, its tests, and any consumer (likely `CommentMargin` and `EditorArea` only — both are about to be deleted in Task 10).

- [ ] **Step 2: Add CSS rules for the new focus-styling mechanism**

Add to `lens-editor/src/components/Editor/extensions/criticmarkup.ts` (or wherever badge CSS currently lives — search for `.cm-comment-badge {`):

```css
/* Default badge */
.cm-comment-badge {
  background: #fef3c7;       /* warm yellow */
  color: #92400e;
  padding: 0 4px;
  border-radius: 8px;
  font-size: 0.7em;
}
/* Focused badge (parent sets [data-focused-thread="<n>"] on editor root) */
[data-focused-thread] .cm-comment-badge {
  /* unmatched badges keep default */
}
[data-focused-thread="0"] .cm-comment-badge[data-thread-from="0"],
[data-focused-thread] .cm-comment-badge[data-thread-from]:where([data-thread-from]) {
  /* CSS attr-equals selector at runtime — we use a JS-set class instead, see below */
}
```

The attribute-equals selector trick doesn't work with dynamic values. Use a class instead:

In `CommentsLayer`, when focus changes, walk badges via `editorRootRef.current?.querySelectorAll('.cm-comment-badge')` and toggle a `cm-comment-badge--focused` class on the one whose `data-thread-from === focusedThreadKey`. Remove the `data-focused-thread` attribute idea from the spec — we'll use a class-toggle pass instead.

Updated CSS:
```css
.cm-comment-badge { background: #fef3c7; color: #92400e; padding: 0 4px; border-radius: 8px; font-size: 0.7em; }
.cm-comment-badge--focused { background: #2563eb; color: #fff; }
```

- [ ] **Step 3: Update `CommentsLayer` focus side effect to toggle the class**

In `CommentsLayer.tsx`, after `setFocus`, run an effect that:
```tsx
useEffect(() => {
  const root = props.editorRootRef?.current;
  if (!root) return;
  root.querySelectorAll('.cm-comment-badge--focused').forEach(el => el.classList.remove('cm-comment-badge--focused'));
  if (focusedThreadKey != null) {
    root.querySelectorAll(`.cm-comment-badge[data-thread-from="${focusedThreadKey}"]`)
        .forEach(el => el.classList.add('cm-comment-badge--focused'));
  }
}, [focusedThreadKey, props.editorRootRef]);
```

- [ ] **Step 4: Remove `focusedThreadField` and `focusCommentThread` from criticmarkup.ts**

Delete the exports and the StateField definition. In the badge widget click handler (around line 362), replace:
```ts
const currentFocused = view.state.field(focusedThreadField);
const threadFrom = parseInt(target.dataset.threadFrom ?? '', 10);
if (!isNaN(threadFrom)) {
  const focusing = currentFocused !== threadFrom;
  view.dispatch({ effects: focusCommentThread.of(focusing ? threadFrom : null) });
  if (focusing) {
    view.dom.dispatchEvent(new CustomEvent('comment-badge-focus'));
  }
}
```
with:
```ts
const threadFrom = parseInt(target.dataset.threadFrom ?? '', 10);
if (!isNaN(threadFrom)) {
  document.dispatchEvent(new CustomEvent('comment-badge-focus', { detail: { threadFrom } }));
}
```

Remove `focusedThreadField` from the extension export list and from `update()` reaction to its effect.

- [ ] **Step 5: Remove tests for the removed exports**

In `lens-editor/src/components/Editor/extensions/criticmarkup.test.ts`, find any test asserting `focusedThreadField` behaviour and delete it.

- [ ] **Step 6: Run criticmarkup tests**

```bash
npm test -- --run criticmarkup
```
Expected: PASS (with fewer tests than before).

- [ ] **Step 7: Commit**

```bash
jj describe -m "comments: badge focus via DOM CustomEvent + CSS class, drop StateField"
jj new -m "comments: wire CommentsLayer into file editor"
```

---

## Task 7 — Wire `CommentsLayer` into file editor

Replace `CommentMargin` in `EditorArea.tsx`. Get the `Y.Text` from the existing y-codemirror binding; the resolver wraps the single EditorView.

**Files:**
- Modify: `lens-editor/src/components/Layout/EditorArea.tsx`

- [ ] **Step 1: Locate the existing `CommentMargin` mount**

Open `lens-editor/src/components/Layout/EditorArea.tsx` and find the `<CommentMargin … />` JSX. Inspect the surrounding code to see how `view`, `stateVersion`, and the Y.Text are obtained.

- [ ] **Step 2: Get a Y.Text reference**

The editor binds via `y-codemirror.next`'s `yCollab(ytext, ...)` or similar. The Y.Text is whatever was passed in. Trace upward to find the prop or hook that holds it; if not already exposed in `EditorArea`, lift it through props from the parent.

- [ ] **Step 3: Replace the mount**

Remove the `<CommentMargin>` and its surrounding wrapper if any. Replace with:

```tsx
import { CommentsLayer } from '../Comments/CommentsLayer';
import { resolveAnchorYFromView } from '../../lib/anchor-resolver';

// inside render:
{view && yText && (
  <CommentsLayer
    yText={yText}
    resolveAnchorY={(offset) => resolveAnchorYFromView(view, offset)}
    getViewportRect={() => {
      const rect = view.scrollDOM.getBoundingClientRect();
      return { top: rect.top, height: rect.height };
    }}
    scrollContainerRef={{ current: view.scrollDOM }}
    editorRootRef={{ current: view.dom }}
    currentUserName={currentUserName}
    insertCursorPos={view.state.selection.main.head}
  />
)}
```

`currentUserName` comes from whatever existing source the old `CommentMargin` used; reuse the same.

- [ ] **Step 4: Remove `CommentMargin` import**

Delete `import { CommentMargin } from '../CommentMargin';` from the top of the file.

- [ ] **Step 5: Build the project to surface type errors**

```bash
npm run build 2>&1 | head -40
```
Fix any TypeScript errors that surface. Expected mismatches: prop shapes, missing exports, etc.

- [ ] **Step 6: Manual smoke test**

Start a local relay + dev server:
```bash
# Terminal A
npm run relay:start
# Terminal B
npm run dev:local
```

Open `http://dev.vps:5273` (ws2 port). Open a document, add a comment via the existing flow (selecting text or putting cursor in position, then clicking Add). Verify:
- Card appears in the right margin near the badge.
- Clicking the badge focuses the card; clicking the card focuses the card; both also turn the badge blue.
- Adding a reply renders under the root.
- Edit own comment works; Delete own comment works.
- Scroll the document — cards move smoothly with the prose.

If any of these fail, note the failure mode and fix before continuing.

- [ ] **Step 7: Commit**

```bash
jj describe -m "comments: mount CommentsLayer in file editor (replaces CommentMargin)"
jj new -m "comments: extend badge widget to section editors"
```

---

## Task 8 — Extend badge widget into section editors

Each per-section CodeMirror view in the course editor needs to render the `cm-comment-badge` widget for comments whose offset falls within its slice. Currently the criticmarkup extension is only added to the file editor; section editors don't include it.

**Files:**
- Modify: `lens-editor/src/components/SectionEditor/createSectionEditorView.ts`

- [ ] **Step 1: Audit current section-editor extensions**

Open `lens-editor/src/components/SectionEditor/createSectionEditorView.ts` and locate the `extensions: [...]` array passed to `EditorState.create`. Note what's already included.

- [ ] **Step 2: Determine offset translation**

The criticmarkup extension expects offsets in the full Y.Text's coordinate space, but the section view holds a slice. The badge widget uses positions from the parsed CriticMarkup ranges. If the parser runs over the section's local doc string, positions will be local to the slice. The criticmarkup-parser is fed `state.doc.toString()` — for section views this returns the slice text, so badge `threadFrom` will be local. That's fine for display, but the CustomEvent we dispatch needs the *absolute* Y.Text offset so `CommentsLayer` can match it.

Pass a `yTextOffsetBase` parameter into the criticmarkup extension when used in section editors:

In `criticmarkup.ts`, add an optional facet or option to the extension that provides a `getYTextOffset(localPos: number) => number` function. The badge widget's click handler uses it before dispatching the CustomEvent. Default: identity (file editor).

```ts
// in criticmarkup.ts, add:
import { Facet } from '@codemirror/state';
export const commentOffsetTranslator = Facet.define<(local: number) => number, (local: number) => number>({
  combine: vals => vals[0] ?? ((n) => n),
});

// in badge click handler:
const translator = view.state.facet(commentOffsetTranslator);
const threadFromAbsolute = translator(threadFrom);
document.dispatchEvent(new CustomEvent('comment-badge-focus', { detail: { threadFrom: threadFromAbsolute } }));
```

Apply the same translation when emitting badge `data-thread-from` so CSS class-toggle in `CommentsLayer` finds the right element. Update the badge widget's `toDOM` to take a `dataAttrThreadFrom: number` (separate from the local `threadFrom` used internally) and write that to the dataset.

- [ ] **Step 3: Include the criticmarkup extension in section views**

In `createSectionEditorView.ts`, add to the `extensions` array:

```ts
import {
  criticmarkupExtension, // whatever the public bundle is named
  commentOffsetTranslator,
} from '../Editor/extensions/criticmarkup';

// inside extensions: [...]
criticmarkupExtension,
commentOffsetTranslator.of((localPos) => opts.yTextOffsetBase + localPos),
```

Where `opts.yTextOffsetBase` is added to `createSectionEditorView`'s `opts` parameter type. The course editor that calls this function will pass `sliceStart` (already known when the section view is created — `y-section-sync.ts` works in terms of slice ranges).

- [ ] **Step 4: Wire `yTextOffsetBase` through course-editor section creation**

Search for callers of `createSectionEditorView`:

```bash
grep -rn "createSectionEditorView" src/ --include="*.ts" --include="*.tsx"
```

For each call site, pass `yTextOffsetBase: <sliceStart>`.

- [ ] **Step 5: Build to confirm types**

```bash
npm run build 2>&1 | head -40
```
Fix any errors.

- [ ] **Step 6: Manual smoke test in course editor**

Run `npm run dev:local:r2` (or `dev:local`), navigate to a course → module → LO that has comments. Confirm badges render in the per-section views at the right positions. (Cards won't appear yet — that's Task 9.)

- [ ] **Step 7: Commit**

```bash
jj describe -m "comments: include criticmarkup extension in section editors"
jj new -m "comments: wire CommentsLayer into course editor"
```

---

## Task 9 — Wire `CommentsLayer` into course editor

Replace `EduCommentsSidebar` in `EduEditor.tsx`. Build a position resolver that walks the active page's section views.

**Files:**
- Modify: `lens-editor/src/components/EduEditor/EduEditor.tsx`

- [ ] **Step 1: Track active section views**

In `EduEditor.tsx` (or wherever section views are managed), maintain a ref or state of currently-mounted section views per active page:

```ts
const sectionViewsRef = useRef<SectionViewEntry[]>([]);
```

Update this ref each time a section mounts/unmounts. The existing `useLODocs` or `ModuleTreeEditor` may already track section views — reuse if so.

- [ ] **Step 2: Determine the active page's Y.Text**

The "currently rendered page" is a Lens (LO) doc, a test, or a file. Its Y.Text is what the section views are slicing. Trace where this Y.Text is currently available in `EduEditor.tsx`. If multiple Y.Texts exist (different LOs in a module), pick the one currently in view per the user's preference (spec: comments for the currently rendered page only).

- [ ] **Step 3: Replace `<EduCommentsSidebar>` with `<CommentsLayer>`**

```tsx
import { CommentsLayer } from '../Comments/CommentsLayer';
import { resolveAnchorYFromSectionViews } from '../../lib/anchor-resolver';

// inside render:
{activeYText && (
  <CommentsLayer
    yText={activeYText}
    resolveAnchorY={(offset) =>
      resolveAnchorYFromSectionViews(sectionViewsRef.current, offset)
    }
    getViewportRect={() => {
      const rect = contentPanelRef.current?.getBoundingClientRect();
      return rect ? { top: rect.top, height: rect.height } : { top: 0, height: 0 };
    }}
    scrollContainerRef={contentPanelScrollRef}
    editorRootRef={contentPanelRef}
    currentUserName={currentUserName}
    insertCursorPos={null /* TODO: route from active section editor selection */}
  />
)}
```

The `insertCursorPos` is omitted for now; the course editor doesn't have a single "cursor" the way the file editor does. Add a follow-up TODO comment to route the most-recently-active section view's cursor through, but ship without the Add-at-cursor flow in the course editor for this PR — users can still add via clicking inside a section and using the existing add-comment shortcut from the criticmarkup extension if one exists. (Verify behaviour; if no shortcut, accept that course-editor add-from-sidebar is deferred.)

- [ ] **Step 4: Remove `EduCommentsSidebar` import and mount**

Delete the import and any state/props it required.

- [ ] **Step 5: Build to confirm types**

```bash
npm run build 2>&1 | head -40
```

- [ ] **Step 6: Manual smoke test**

Run `npm run dev:local:r2`. Open a course, drill into an LO with existing comments. Verify:
- Comments render in the right margin of the content panel.
- Badges in per-section views match cards.
- Clicking either highlights the matching pair.
- Scroll behaviour smooth.
- Reply / Edit / Delete work.

- [ ] **Step 7: Commit**

```bash
jj describe -m "comments: mount CommentsLayer in course editor (replaces EduCommentsSidebar)"
jj new -m "comments: delete superseded modules"
```

---

## Task 10 — Delete superseded files

Remove the dead code from Tasks 7 and 9.

**Files (delete):**
- `lens-editor/src/components/CommentMargin/` (entire directory)
- `lens-editor/src/components/CommentsPanel/` (entire directory)
- `lens-editor/src/components/EduEditor/EduCommentsSidebar.tsx`
- `lens-editor/src/lib/comment-layout.ts` and `comment-layout.test.ts`
- `lens-editor/src/lib/comment-utils.ts` and `comment-utils.test.ts`

- [ ] **Step 1: Confirm no remaining imports**

```bash
grep -rn "CommentMargin\|EduCommentsSidebar\|CommentsPanel\b" lens-editor/src/ --include="*.ts" --include="*.tsx"
grep -rn "from '.*comment-layout'\|from '.*comment-utils'" lens-editor/src/ --include="*.ts" --include="*.tsx"
```
Both should return only the files about to be deleted (or nothing).

- [ ] **Step 2: Delete the directories and files**

```bash
rm -rf lens-editor/src/components/CommentMargin
rm -rf lens-editor/src/components/CommentsPanel
rm lens-editor/src/components/EduEditor/EduCommentsSidebar.tsx
rm lens-editor/src/lib/comment-layout.ts lens-editor/src/lib/comment-layout.test.ts
rm lens-editor/src/lib/comment-utils.ts lens-editor/src/lib/comment-utils.test.ts
```

- [ ] **Step 3: Run the full test suite**

```bash
npm test -- --run
```
Expected: PASS.

- [ ] **Step 4: Run the build**

```bash
npm run build
```
Expected: no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
jj describe -m "comments: remove superseded CommentMargin / CommentsPanel / EduCommentsSidebar"
jj new -m "comments: manual verification pass"
```

---

## Task 11 — Manual verification pass

Final hands-on check across both editors. Drives out any regressions the unit tests miss.

- [ ] **Step 1: Start local dev**

```bash
npm run relay:start    # terminal A
npm run dev:local      # terminal B
```

- [ ] **Step 2: File editor — dense comments scrolling**

Open or create a markdown doc with ≥15 comments distributed throughout. Scroll slowly top-to-bottom. Verify:
- No comment-card jumps or jitters during scroll.
- Cards in the visible viewport sit at or near their anchor lines.
- Cards crowded in a dense region compress symmetrically (no top-pile bias).
- Focused card (after click) holds its position exactly at its anchor.

- [ ] **Step 3: File editor — focus and CRUD**

- Click a badge in the prose → card focuses (blue).
- Click a different card → focus moves; previous unfocuses.
- Press Escape → focus clears, both badge and card return to default style.
- Reply to a comment → reply appears in the card; layout reflows.
- Edit own comment → text updates in place; CRDT update propagates to a second tab if open.
- Delete own comment → confirm dialog appears; on confirm, card vanishes and badge disappears from prose.

- [ ] **Step 4: Course editor — same flow**

Open `npm run dev:local:r2`. Navigate to a module → LO with comments across multiple sections. Verify the same five behaviours above, plus:
- Badges render correctly inside per-section CodeMirror views.
- Cards align with badges even though the content is composed of N section editors.

- [ ] **Step 5: Edge cases**

- Scroll to the absolute end of a long doc — cards near the end aren't cut off by the scroll-container bottom.
- Add a comment, immediately add a reply — card grows; subsequent cards shift down smoothly, no overlap.
- Add many comments in quick succession — no flicker, no z-order glitches.

- [ ] **Step 6: Final commit**

If everything checks out, no code change needed — the previous task is the last meaningful commit. If anything was tweaked during verification, commit it now:

```bash
jj st
jj describe -m "comments: verification-driven tweaks"
```

---

## Notes for the executor

- **Cursor-pos for Add in course editor**: deferred (see Task 9 step 3). Add a follow-up issue or TODO comment in `EduEditor.tsx`.
- **Layout algorithm performance**: if scrolling feels janky on long docs, profile `computeWeightedLayout`. The current implementation re-merges via `splice`; if N becomes large this is O(N²). Replace with a stack-based merge if needed. Spec allows ≥30-50 in-window cards comfortably; only optimise if measured.
- **Stale offsets after edits**: spec open question #4 — focused offset shifts when text upstream edits. The current implementation uses raw offset matching. If users report focus jumping after edits, plan a follow-up to track focus by `(rootRange.metadata.author, rootRange.metadata.timestamp)` and re-resolve to the current offset each render.
- **CSS for `.cm-comment-badge--focused`**: ensure it has higher specificity than the default so the focused style wins. If not, tighten the selector.
- **ResizeObserver in tests**: stub it in `beforeEach` (see Task 5 step 1).
