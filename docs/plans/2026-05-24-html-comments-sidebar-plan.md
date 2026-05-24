# HTML viewer: reuse the shared comments sidebar

Plan to consolidate the HTML editor's comment UI onto the existing
`Comments/CommentsLayer` sidebar used by the markdown and course editors.

## Goal

- One sidebar implementation across all three editor surfaces (markdown,
  course/edu, HTML preview).
- Drop the HTML editor's bespoke popover (`CommentThread`) and separate
  `OrphanedCommentsPanel`.
- **Keep** the HTML preview's in-iframe icons and click-to-place comment-mode
  flow, **including the floating `NewCommentCard` composer** for body capture
  at placement time. Sidebar replaces *thread view*, not *thread creation*.

## Architecture

Refactor `Comments/CommentsLayer.tsx` and `Comments/CommentCard.tsx` to be
source-agnostic. Each editor provides a small **adapter** that produces a
normalized `ThreadView[]` and wires callbacks back to its own storage layer.

### Shared types (new `Comments/types.ts`)

```ts
type ThreadKey = string;   // stringified Y.Text offset OR UUID

interface MessageView {
  // Stable identity that survives offset shifts. For criticmarkup, derived
  // from (author, timestamp) which the parser already extracts into
  // range.metadata; for HTML, the message UUID. Used purely as a display key
  // and a handle the layer passes back to callbacks — never decoded by the
  // layer.
  id: string;
  author: string;
  body: string;            // already decoded (display-ready)
  timestamp: string;
  canModify: boolean;
}

interface ThreadView {
  key: ThreadKey;
  root: MessageView;
  replies: MessageView[];
  order: number;           // 1..N display index, matches inline badge
  orphan: boolean;         // anchor unresolvable in current render
}
```

### CommentsLayer props (refactored)

```ts
interface CommentsLayerProps {
  threads: ThreadView[];
  resolveAnchorY: (key: ThreadKey) => number | null;
  getViewportRect: () => { top: number; height: number };
  scrollSource: ScrollSource;        // see below — replaces scrollContainerRef
  editorRootRef?: RefObject<HTMLElement | null>;  // markdown only: badge focus toggle
  currentUserName: string;
  onFocusChange?: (key: ThreadKey | null) => void;
  // Callbacks pass full thread / message values so the adapter can close over
  // live state from the latest parse without an id→state map. This avoids the
  // stale-id failure mode under remote yText updates.
  onReply: (thread: ThreadView, body: string) => void;
  onEdit: (message: MessageView, newBody: string) => void;
  onDelete: (message: MessageView) => void;
  // Add-comment UI shown only when both provided (markdown only today).
  getInsertKey?: () => ThreadKey | null;
  onAddComment?: (key: ThreadKey, body: string) => void;
}

interface CommentsLayerHandle {
  // Imperative inbound focus — used by inline-marker clicks. Idempotent set
  // (not a toggle): focusing an already-focused key is a no-op. Calling with
  // a newly-added key right after the parent inserts the thread works as
  // expected (HTML post-placement flow depends on this).
  focusThread(key: ThreadKey): void;
  openAddForm(): void;
}
```

#### `ScrollSource` (new abstraction)

CommentsLayer reads `scrollContainerRef.current.scrollTop / scrollHeight /
clientHeight` at four sites (L80 destructure, L192 useEffect, L213 dep,
L278 useLayoutEffect edge-clamp). The HTML preview has no equivalent element
— the iframe owns its own scroll, surfaced over `postMessage`. Generalize:

```ts
interface ScrollSource {
  getScrollTop(): number;
  getScrollHeight(): number;
  getClientHeight(): number;
  // Notify on any change relevant to layout (scroll, resize).
  subscribe(onChange: () => void): () => void;
}
```

All three getters must be O(1) and side-effect-free (no sync layout). The
markdown adapter wraps a real DOM element with these. The HTML adapter wraps
`PreviewScrollState` (cached parent-side from bridge `scroll-state`
messages) — values come from the most recently received message.

#### `ThreadKey` generalization

Today `CommentsLayer` keys layout state by `number` (Y.Text offset):
`cardHeightsRef: Map<number, number>`, `observersRef: Map<number,
ResizeObserver>`, `focusedThreadKey: number | null`,
`[data-comment-thread]`, `threadKeys.join(',')`. Generalize all to
`ThreadKey` (~15 sites). For edu's anchor resolver that does numeric
arithmetic on offsets (compares against section ranges), the markdown/edu
adapter guarantees `ThreadKey` is always `String(numericOffset)`, and edu's
adapter parses back to `Number()` at the resolver boundary.

### Orphan section + sidebar scroll layout

The sidebar column splits into two stacked regions inside an
`overflow-y: auto` outer scroller:

```
.comments-sidebar (overflow-y: auto)
├── .comments-sidebar__anchored        position: sticky; top: 0;
│     height: <viewport height>;        ← cards positioned absolutely inside,
│     ├── [+ Add button]                  PAV layout sees this as its fixed
│     ├── [pendingAddForm]                viewport. Editor scroll moves the
│     └── absolute-positioned cards       cards within this sticky box.
└── .comments-sidebar__orphans         normal flow, below the sticky box;
      static list of orphan cards.       sidebar scroll moves these.
```

Why sticky: the anchored region stays pinned to the top of the visible
sidebar area as the user scrolls the sidebar (to see orphans). Its absolute
layout continues to track the editor's scroll independently. The two scroll
axes (editor scroll → anchored card positions; sidebar scroll → orphan
list) never compete for the same elements.

Markdown: orphan list is empty (criticmarkup always has an in-band anchor),
so the sticky box fills the column and the outer scroll is dormant.
Behavior unchanged from today.

HTML: orphans appear below; outer column scrolls naturally; sticky
anchored box stays put visually.

Scope: ~80–120 LOC + CSS in CommentsLayer, plus tests.

### Adapters

**`Comments/criticmarkupAdapter.ts`** (markdown side)

- `useThreadsFromYText(yText) → { threads, callbacks }`:
  - Parses with existing `useCommentsFromText` + filter (comment threads
    only).
  - Builds `ThreadView[]` from parsed `CommentThread`s. Bodies are
    pre-decoded via `decodeCommentContent`. `message.id` derived from
    `(metadata.author, metadata.timestamp)` so it survives offset shifts
    under remote updates. `thread.key = String(thread.from)`.
  - Returns `callbacks` (`onReply`, `onEdit`, `onDelete`, `onAddComment`)
    built fresh **per parse** — each closure captures the live
    `CriticMarkupRange` references from the current parse. The
    `MessageView` passed into a callback is *not* used to look up state;
    the adapter relies on the closure trail. (If the user fires a callback
    after a remote update has retriggered the parse → re-render, the
    callback they invoke comes from the latest closure set and operates on
    the latest range, which is the correct behavior.)
  - Note: the projection's `body` is the decoded string; the underlying
    `CriticMarkupRange` retained inside the closure holds the *raw* content,
    which is what `editRangeContentInYText` re-encodes from.

- `useScrollSource(elRef: RefObject<HTMLElement>) → ScrollSource`: real-DOM
  wrapper. Subscribes once internally to `scroll` + `ResizeObserver`.

**`HtmlEditor/htmlCommentsAdapter.ts`** (new)

- `useThreadsFromHtmlYText(yText, anchorState) → ThreadView[]`: parses
  with `parseComments`, joins with `anchorState` keyed by UUID.
  `thread.key = comment.id` (UUID). `orphan = anchorState.get(id) == null`.
  `MessageView.id = marker.id` (the per-message UUID — already unique
  across threads since `parseComments` enforces it).
- Callbacks wired to `addReply`, `editMessage`, `deleteMessage` from
  `comment-store.ts`. `addComment` is **not** exposed via the sidebar
  `onAddComment` — placement still goes through `NewCommentCard` →
  `HtmlPreview` → `addComment`.
- `useIframeScrollSource(previewScrollState) → ScrollSource`: returns
  cached `{scrollTop, scrollHeight, clientHeight}` from the most recent
  bridge `scroll-state` message; `subscribe` adds to a fanout that fires on
  each new message.
- `resolveAnchorY(uuid)`: see bridge protocol below for the computation.
- `focusThreadFromIframe(uuid)`: called by the parent's `dot-clicked`
  handler; the adapter exposes this so `HtmlEditor` can wire it to the
  layer ref. (No-op if uuid not in current threads.)

### Bridge protocol changes

`bridge/protocol.ts:75` — `commentsRendered: { found: string[]; orphaned:
string[] }`. The bridge already computes rects in
`bridge-script.ts:294` but discards them.

Changes:

1. **Extend `commentsRendered`** with:
   ```ts
   rects: Array<{ id: string; y: number; x: number; w: number; h: number }>;
   baselineScrollY: number;     // iframe scroll-y when rects were measured
   layoutVersion: number;       // monotonic per-bridge counter
   ```
2. **Augment `scroll-state`** with `layoutVersion: number` (current
   bridge's most-recent value). Parent discards any `scroll-state` whose
   `layoutVersion` doesn't match the latest `commentsRendered` — protects
   against the bridge's mutation-debounce window where a `scroll-state`
   could race ahead of the corresponding `commentsRendered`.
3. **Re-emit triggers in the bridge.** Today `rebuildDots` only runs from
   MutationObserver records. Add re-emit on:
   - `ResizeObserver(doc.body)` — covers font/image-load reflow, CSS-only
     geometry changes.
   - `toggle` event on `document` (capturing) — covers `<details>`
     open/close.
   - `window.resize` on the bridge frame — covers iframe size changes.
   Each triggers a `rebuildDots` call which bumps `layoutVersion` and posts a
   fresh `commentsRendered`.
4. **New parent→bridge `setFocusedComment: { id: string | null }`.** Bridge
   stores `lastFocusedId` (mirror of `lastComments` at
   `bridge-script.ts:471`) and applies `data-comment-focused` after every
   `rebuildDots` so the focus class survives DOM rebuild.

Effective viewport-y inside the adapter:

```ts
function effectiveY(rect: Rect, baselineScrollY: number, currentScrollY: number, iframeTop: number) {
  return iframeTop + rect.y - (currentScrollY - baselineScrollY);
}
```

`iframeTop` is the iframe element's `getBoundingClientRect().top`. Since
the iframe is `position: absolute; inset: 0` inside the static editor
pane (`HtmlPreview.tsx:889`), `iframeTop` is essentially fixed for a given
window size; the adapter reads it lazily on each `resolveAnchorY` call.

### CommentCard refactor

Switch from `CommentThread` (CriticMarkup) → `ThreadView`/`MessageView`.
Coupling sites in `Comments/CommentCard.tsx`:

| Site | Change |
|---|---|
| L2: `CommentThread, CriticMarkupRange` import | drop |
| L3: `decodeCommentContent` | move to markdown adapter |
| L27-28: `thread.comments[0]` / `slice(1)` | → `thread.root` / `thread.replies` |
| L36: `onReply(thread.to, ...)` | → `onReply(thread, ...)` |
| L99: `reply-${reply.from}-${idx}` | → `reply.id` |
| L154-168 (CommentRow): `comment.metadata?.…`, `comment.content` | → `msg.author / .body / .timestamp` |
| L179/L230: `onEdit(rangeIndex, ...)` / `onDelete(rangeIndex)` | → `onEdit(msg, ...)` / `onDelete(msg)` |
| Owner check (currently `metadata.author === currentUserName`) | → `msg.canModify` |

Every prop signature changes; `CommentCard.test.tsx` is fully rewritten.

### Sidebar mount inside HtmlEditor

Layout, Preview/Split tabs only:

```
[ toolbar: Source | Preview | Split | Comment | orphan-count ]
[ HtmlSourceEditor | HtmlPreview ]  [ CommentsLayer column (320px) ]
```

Refs and props flow:

- `commentsLayerRef: RefObject<CommentsLayerHandle>` owned by `HtmlEditor`.
- `HtmlPreview` receives new props:
  - `onDotClicked: (id: string) => void` — replaces local
    `setOpenThreadId`. Wired by `HtmlEditor` to call
    `commentsLayerRef.current?.focusThread(id)` via the adapter's
    `focusThreadFromIframe`.
  - `onCommentAdded: (id: string) => void` — fired after a successful
    `addComment` from the placement flow. `HtmlEditor` wires it to
    `commentsLayerRef.current?.focusThread(id)`.
  - `onAnchorState: (state: AnchorState) => void` — pushes updated rect
    state up so the adapter can produce `ThreadView`s with the right
    `orphan` flag. (Equivalent of today's `onOrphanedChange`, generalized.)

`HtmlPreview` drops:
- Local `openThreadId` state and the `CommentThread` mount at L970-980.
- The popover-positioning logic associated with it.

The placement-time floating `NewCommentCard` and its body capture remain
exactly as they are at `HtmlPreview.tsx:920-968` and `HtmlEditor.tsx:155-188`.

### `getViewportRect()` semantics — coordinate-space contract

Both `resolveAnchorY` and `getViewportRect` must return values in the same
y-coordinate space. Markdown today uses screen-y (CodeMirror returns
screen-coord; CommentsLayer subtracts `viewport.top` to get
viewport-relative).

- **Markdown**: `getViewportRect` returns the editor scrollDOM rect (top,
  height) in screen-y. `resolveAnchorY` returns screen-y.
- **HTML**: `getViewportRect` returns the iframe element's screen rect
  (`iframeEl.getBoundingClientRect().top`, `.height`). `resolveAnchorY`
  returns screen-y via the `effectiveY` formula above.

Spelled out so future implementers don't conflate iframe-content-y with
screen-y.

### EduEditor adapter wiring

`EduEditor.tsx` uses a multi-section resolver. The plan keeps that
implementation; the adapter just bridges types: `resolveAnchorY` takes
`ThreadKey` (string), converts to `number`, calls the existing resolver.
Single full-doc `Y.Text` (`ContentPanel.tsx:355` —
`doc.getText('contents')`); no change there.

## Files touched

| File | Change |
|---|---|
| `Comments/types.ts` | new |
| `Comments/CommentsLayer.tsx` | type generalization, scrollSource, sticky+orphans layout, new props/handle |
| `Comments/CommentCard.tsx` | full prop refactor |
| `Comments/CommentCard.test.tsx` | rewrite fixtures |
| `Comments/CommentsLayer.test.tsx` | rewrite fixtures |
| `Comments/criticmarkupAdapter.ts` | new — projection + per-parse closures + scroll-source wrapper |
| `Comments/criticmarkupAdapter.test.ts` | new |
| `Layout/EditorArea.tsx` | markdown side: use adapter |
| `EduEditor/EduEditor.tsx` | use adapter |
| `HtmlEditor/htmlCommentsAdapter.ts` | new |
| `HtmlEditor/htmlCommentsAdapter.test.ts` | new |
| `HtmlEditor/HtmlEditor.tsx` | mount sidebar; thread refs/callbacks through to HtmlPreview; drop OrphanedCommentsPanel mount |
| `HtmlEditor/HtmlPreview.tsx` | drop popover `CommentThread`; new props (`onDotClicked`, `onCommentAdded`, `onAnchorState`); keep `NewCommentCard` placement flow |
| `HtmlEditor/bridge/protocol.ts` | extend `commentsRendered`; extend `scroll-state` with `layoutVersion`; add `setFocusedComment` |
| `HtmlEditor/bridge/bridge-script.ts` | emit rects + layoutVersion; ResizeObserver(doc.body); toggle handler; window.resize; `setFocusedComment` w/ `lastFocusedId` mirror |
| `HtmlEditor/OrphanedCommentsPanel.tsx` + `.test.tsx` | delete |
| `HtmlEditor/CommentThread.tsx` | delete |
| `HtmlEditor/NewCommentCard.tsx` | **keep** |

5 new files, 8 modified, 3 deleted.

## Test coverage

- `CommentsLayer.test.tsx`: rewrite. Anchored / orphan / mixed; focus
  toggle (inbound handle + outbound `onFocusChange`); `scrollSource`
  triggers re-layout; sticky vs orphan flow.
- `criticmarkupAdapter.test.ts`: round-trip projection; callback closures
  see current parse after yText mutation; reply/edit/delete fire correct
  ops with correct ranges; remote-insert-before-thread doesn't drop a
  user's pending edit.
- `htmlCommentsAdapter.test.ts`: parse → ThreadView; orphan flag from
  anchor-state; effective-y math with scroll delta; `layoutVersion`
  mismatch discards stale scroll-state.
- Bridge protocol: schema validator tests; rect-on-resize triggers;
  setFocusedComment survives `rebuildDots`.
- HtmlEditor integration: anchored thread in sidebar; orphan in orphan
  section; sidebar card click toggles in-iframe focus class; in-iframe
  icon click focuses sidebar card; placement flow still places.

## Realistic scope

- `CommentsLayer.tsx`: ~200 LOC delta.
- `CommentCard.tsx`: ~80 LOC delta + test rewrite.
- Adapters + tests: ~500 LOC combined.
- Bridge protocol + script: ~150 LOC across both sides + tests.
- HtmlEditor / HtmlPreview integration: ~150 LOC delta.

Total ~1100–1400 LOC churn.

## Remaining uncertainties

1. **`layoutVersion` race during placement**: a user adds a comment, the
   bridge mutates DOM, bumps `layoutVersion`, posts new
   `commentsRendered`. In the tiny window between the user's
   `addComment` call (yText mutation) and the bridge's next
   `commentsRendered`, the adapter's `ThreadView` projection has a new
   thread but `anchorState` doesn't know its rect yet → it's flagged
   orphan briefly, then resolves. Visual blink. Acceptable as v1; can
   smooth by deferring orphan flagging for ~one rAF after a known local
   add.
2. **Edu's edit/delete identity under remote updates**: even with the
   `(author, timestamp)` content-derived `message.id`, the adapter's
   callback closures reference `CriticMarkupRange` objects from a parse
   snapshot. If a remote delete removes the range *between* render and
   callback fire, the operation will run on a non-existent range. Need to
   confirm `editRangeContentInYText` / `deleteRangeInYText` handle this
   gracefully (no-op vs throw). Quick code check before implementation.
3. **Sticky positioning + sidebar resize**: `position: sticky` requires
   the outer column to have a known height context. In
   `Layout/EditorArea.tsx`, the comment-margin div has explicit width and
   `overflow-hidden`; height comes from flex. Verify the sticky inner box
   actually pins as expected; may need an additional `display: flex;
   flex-direction: column` on the column.
4. **Bridge `<details>` toggle event capture**: bubbling for `toggle` was
   not standardized everywhere; verify in current Chromium. Fallback:
   listen on each `<details>` element explicitly via delegation through
   the existing MutationObserver hookup.
