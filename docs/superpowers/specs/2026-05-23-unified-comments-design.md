# Unified Comments — UX/UI Design

## Goal

Replace the two unrelated comment UIs (`CommentMargin` in the file editor, `EduCommentsSidebar` in the course editor) with one shared component. Fix the file-editor positioning bugs by replacing the greedy top-down collision solver (with its stale per-anchor height cache) with a scroll-driven local-window optimisation. Bring full CRUD (currently only in Edu) to both editors.

This is a UX/UI spec. Architectural choices are noted where they're load-bearing for the UX, but exact module boundaries and migration steps are left for the implementation plan.

## Current state

Both editors store comments identically — as CriticMarkup ranges in the document's Y.Text. Threading is by adjacency (one range's `to` equals the next's `from`). Beyond that, the two UIs diverge completely:

- **File editor (`CommentMargin`)** — floating cards next to a single CodeMirror EditorView. Layout uses a greedy top-down collision solver fed by a `Map<from, height>` keyed by anchor offset. Cards stack near their anchors when they fit, push down when they don't. Active comment lives in a CodeMirror `StateField`. Symptoms: cards overlap on first paint (height map empty), focus highlight jumps after edits (position mapping race), stale height entries after deletes, scroll-sync drift. No edit/delete.
- **Course editor (`EduCommentsSidebar`)** — a slide-in right panel listing all comments for the active document. Reads the Y.Text directly via `useCommentsFromText(text)`, bypassing CodeMirror (the course editor mounts N small CodeMirror views, one per section, so there's no single view to attach to). Stable; full CRUD; but no anchored positioning — it's a flat list.
- **`CommentsPanel`** — third component, only referenced from its own tests. Dead UI code, but `useCommentsFromText` and `AddCommentForm` live in its directory and are reused.

## UX

### Layout

A vertical column to the right of the prose. Cards float at absolute positions; each card targets the screen-y of its inline anchor. The column shares the editor's scroll container — scrolling the prose scrolls the column. Where the document is short, the column ends with the prose; where the column would extend past the prose end (heavy comment density), the shared scroll container grows so the user can scroll past the prose to see the trailing cards. This matches what the Edu sidebar effectively does today.

### Inline anchor

The existing `cm-comment-badge` widget — a numbered superscript at the comment's insertion point in the prose. Comments are point-based (a single Y.Text offset), not range-based, so there's no underline; the badge alone marks the anchor. Today this widget exists only in the file editor's full-document EditorView. We extend it to the course editor's per-section CodeMirror views so badges render at the right place in both.

Badge styling: warm yellow background by default; the badge of the currently-focused card switches to blue to match the card's focus outline.

### Card content

One card per thread. Header line per comment: author display name and relative timestamp. Body: comment text. Replies indent under the root with a thin left border.

Per-comment actions:
- **Reply** (any user, on any comment): expands a reply form at the bottom of the card.
- **Edit** (only on comments you authored): swaps the body for a textarea pre-filled with the existing content.
- **Delete** (only on comments you authored): confirm dialog, then removes the range from the Y.Text.

### Filter strip

A tiny segmented control at the top of the column: **All** / **Mine**. Default All. No date or author filter. No Unresolved tab until resolve is implemented (out of scope here).

### Focus model

Exactly one comment is "focused" at a time. Source of truth is a single React state value in the shared component (`focusedThreadKey: number | null`, keyed by the thread's anchor offset). Focus is set by:

- Clicking an inline badge.
- Clicking a card.
- Creating a new comment (the new card opens focused, with its input ready).

Focus is cleared by:

- Pressing Escape.
- Clicking the column background.
- The current document changing.

The CodeMirror `focusedThreadField` is removed. The criticmarkup extension's badge widget dispatches a DOM `CustomEvent` on click; the shared component listens, sets state. The focused styling on the badge is driven by a CSS variable or data attribute that the component writes to the editor root when focus changes — no per-badge React state, no inline marker re-render churn.

### Empty state

When the open doc has no comments: a short hint in the column ("No comments yet. Select text and click Add, or press ⌘E.") and an Add button.

### CRUD entry points

- **Add at cursor:** the column header's "Add" button inserts a new comment at the current editor selection's caret position; if the caret is inside an existing comment range, insert at that range's `to` (becomes a sibling adjacent to the existing thread).
- **Reply:** per-card.
- **Edit/Delete:** per-comment, owner-only.

All operations go through the existing `ytext-comment-ops.ts` (transactional Y.Doc edits). No EditorView-mediated mutation paths.

## Course editor specifics

The shared component shows comments for **the page currently rendered in the content panel** — a Lens (LO doc), a test, or a file. One page at a time, flat list, same UX as the file editor. No cross-document grouping or aggregation views.

The per-section CodeMirror views each render the badge widget over their slice of the Y.Text. The shared component's position resolver iterates the section views to find which one owns each comment's offset and asks that view for screen coordinates.

## Layout algorithm

The core piece. Designed to satisfy three constraints simultaneously:

1. **No overlap** between cards.
2. **Continuous scroll mapping** — scrolling the editor produces a continuous, jump-free movement of cards. No frame-by-frame layout discontinuities.
3. **Cards stay near their anchors** — cards drift only when forced to by overlap, and the drift is distributed fairly, not piled on whichever direction the algorithm scans first.

### Inputs (recomputed on scroll)

For each comment thread visible within an active window (see below):
- `anchorY` — screen-y of the comment's inline badge, queried fresh from the EditorView via `coordsAtPos`.
- `height` — current rendered card height, measured via ResizeObserver.
- `weight` — derived from the comment's vertical position within the editor's viewport.

### Weighting function

The weighting is what makes the result continuous in scroll position. The factor is a triangle peaking at the viewport center:

```
let vh = editor viewport height
let y  = (anchorY - editor.top)        // position within viewport, 0..vh
let mid = vh / 2

weight =  clamp01(1 - |y - mid| / mid)   // 0 at edges, 1 at center
```

(A trapezoid — `1` across the middle 50% with linear ramps in the outer 25%s — is equivalent for our purposes. We use the triangle for simplicity.)

Comments outside the viewport have weight 0. They still exist in the optimization for overlap purposes (so they don't crash into a weighted card), but the optimizer doesn't penalise their displacement.

### Active-window trimming

For long documents, restrict the algorithm to comments whose anchors fall within **2× viewport height** of the viewport (one viewport above, one below). Everything outside that band is laid out at its raw anchor position (zero weight, never visible) and excluded from the optimization. This bounds the work per scroll to O(visible comments), typically dozens not thousands.

### Optimization: Weighted PAV (Pool Adjacent Violators)

Given anchors `a_i`, heights `h_i`, weights `w_i`, gap `g`, minimise `Σ w_i (y_i − a_i)²` subject to `y_i + h_i + g ≤ y_{i+1}` for adjacent in-window cards.

Standard isotonic-regression algorithm, O(N):

1. Initialise `y_i = a_i` for all in-window comments, sorted by anchor.
2. Scan left to right. If `y_i + h_i + g > y_{i+1}` (violation), merge cards `i` and `i+1` into a block. The block's position minimises the merged weighted-displacement; for two cards it's a closed-form weighted mean adjusted for the offsets within the block.
3. Check the merged block against its left neighbour; if it now violates, merge further.
4. Continue.

For a block of merged cards with offsets `δ_k` (the within-block position of card `k` relative to the block's anchor) and weights `w_k`, the optimal block position is `(Σ w_k (a_k − δ_k)) / Σ w_k`.

A zero-weight card in a block contributes nothing to the position but still occupies space and pushes weight-bearing neighbours.

### Focus override

When a card is focused, treat its weight as effectively infinite — equivalent to a hard pin at its anchor. PAV runs around it; everything else displaces to make room. Focus changes are discrete user actions, so the small re-layout when focus changes is acceptable; scroll-induced layout changes never are.

### Edges

- **Top of doc:** if the algorithm would push a card above 0 (above the prose start), clamp it. PAV's left-to-right scan naturally produces non-negative `y` when the first card's anchor is ≥ 0.
- **Bottom of doc:** no hard upper boundary. If the column extends past the prose end, the shared scroll container grows (the editor adds padding so the column has somewhere to live).

### Recompute triggers

- `scroll` event on the editor scroll container — throttled to rAF (one recompute per animation frame at most).
- `resize` event on the editor or container — same rAF throttle.
- `ResizeObserver` firing on any card (height changed because of a reply added, text edited, etc.) — same.
- Y.Text update (add/edit/delete a comment) — rebuild the in-window comment list, then recompute.

### Cost

Per recompute: O(N_in_window). With ~50 in-window cards on a busy page, this is sub-millisecond. Comfortable at 60fps on the scroll path.

### Why not a globally-precomputed layout

A scroll-invariant global layout (full PAV over all comments in the doc) is mathematically clean and removes the per-scroll cost. But its global L2 optimum redistributes compression across the entire document — at the start of a comment-heavy doc, cards get pushed above the viewport top; at the end, below the viewport bottom. That's worse than the current bug. Local-window optimization with smooth boundary weighting gives both: continuity (smooth weights → smooth minimum), and visible-window faithfulness (each scroll position optimised for what's actually on screen).

## Architectural shape

Sketched here only to validate the UX is implementable; details belong in the implementation plan.

- **One React component** used by both editors. Props: `docId`, an `EditorViewLike` or list-of-views (for position resolution), a `ytext` reference (for parsing and mutation), and the current user identity.
- **Position resolver pattern.** The component takes `resolveAnchorY(offset) => number | null`. The file editor passes a wrapper around `view.coordsAtPos`. The course editor passes a function that walks its section views, finds the one whose slice contains the offset, and asks that view. Returns `null` if the offset is inside a collapsed/unmounted section — card hides.
- **Y.Text-driven.** Source of truth for comment data is `useCommentsFromText` (today's Edu hook), generalised. The file editor's old `useComments(view)` hook is replaced.
- **Single focus state.** `useState<number | null>` inside the shared component. The `cm-comment-badge` widget dispatches a CustomEvent; component listens. The component writes a `data-focused-thread="<offset>"` attribute on the editor root for CSS-driven badge styling.
- **Mutations.** Always via `ytext-comment-ops.ts`. EditorView is never the entry point for a write.
- **Delete.** Replace `CommentMargin`, `CommentsPanel`, and `EduCommentsSidebar`. Keep and reuse `AddCommentForm`, `useCommentsFromText`, `ytext-comment-ops.ts`, the criticmarkup parser, and the badge widget. Remove the criticmarkup extension's `focusedThreadField`.

## Scope

In:
- Single shared component, mounted in both editors.
- Margin-card layout with scroll-driven weighted-PAV positioning.
- Inline numbered badge in both editors (extending the existing widget to the per-section views).
- CRUD: add / reply / edit-own / delete-own.
- Filter strip: All / Mine.
- Single React focus state, replacing the CodeMirror state field.

Out:
- Storage format changes (CriticMarkup stays).
- Resolve / archive / unresolved filter.
- @mentions.
- Notifications.
- Cross-document views (course-level aggregations).
- Comment search.
- Permissions beyond owner-only edit/delete.
- Suggestion-mode interactions (the criticmarkup extension also renders insertions/deletions; those keep their existing accept/reject UI, unrelated to this).

## Open questions to resolve during planning

1. **Active-window radius.** Spec says 2× viewport height. Could be smaller (1.5×) or larger (3×). Tune based on observed scroll responsiveness.
2. **Animation on layout change.** Should card position changes triggered by *data* events (a reply lands, a card resizes) animate, while *scroll* changes don't? Or strict no-animation everywhere? Default: no animation, see if it feels jumpy.
3. **Empty-doc Add button placement.** When there are zero comments, the column is mostly empty. Header Add button vs. centred call-to-action.
4. **What happens during a Y.Text re-anchor.** When a user edits text upstream of a comment's offset, the comment's offset shifts. PAV runs fresh each scroll, so positions update; but the user's *focused* offset value is a stale integer. Spec choice: when focus is set, store the offset *and* the original thread identity (e.g., the root comment's author+timestamp from the parsed metadata); on each render, look up the thread by identity first, falling back to offset. Resolve in planning.
5. **Course editor: behaviour when the rendered page has no Y.Text.** The course overview/tree view doesn't render a document. Column hidden, or shown empty with a hint? Default: hidden.
