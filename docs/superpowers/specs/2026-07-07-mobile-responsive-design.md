# Lens Editor Mobile Responsive Design (Obsidian-style)

**Date:** 2026-07-07
**Status:** Approved (defaults confirmed via batched Q&A; user delegated execution)

## Goal

Make the Lens Editor usable and pleasant on phones (~390px wide), modeled closely on
Obsidian's mobile app UX. In scope: the file editor (markdown `EditorArea`, HTML editor
tolerated but not polished), ReviewPage (`/review`), PromotionPage (`/promote`), and the
app shell (sidebar, quick switcher, panels). Out of scope: the course editor
(`/edu/:docUuid`), section editor, add-video/add-article pages (must not crash, but no
mobile polish).

## Decisions (user-confirmed defaults)

1. **Full editing on mobile** — CodeMirror editing incl. suggestions/CriticMarkup, with a
   mobile formatting toolbar.
2. **Bottom nav bar** (Obsidian-style): sidebar toggle, quick switcher, right-panel
   toggle, overflow menu. When the on-screen keyboard is open in the editor, the bar is
   replaced by a formatting toolbar.
3. **Panels become slide-in drawers/sheets** — left sidebar and right panels overlay the
   editor with a scrim; tap scrim to dismiss.
4. **Verification** via Chrome DevTools mobile emulation + share link for real-device
   testing later.

## Obsidian mobile reference model (researched 2026-07-07, obsidian.md/help/mobile)

On phones Obsidian uses:
- **Left/right edge drawers** overlaying the note (file explorer left; outline,
  backlinks, properties right), opened by edge swipe or nav-bar menu button, dismissed
  by scrim tap/swipe. Notably, the right sidebar has NO dedicated button — its
  undiscoverability is Obsidian users' top mobile complaint. We fix that with a
  dedicated bottom-bar button.
- **Bottom navigation bar** (keyboard closed): back / forward / ⊕ quick-switcher
  (doubles as "new note") / tab counter / menu. On the web, browser chrome already
  provides back/forward and tabs, so we keep: sidebar, quick switcher, right panel,
  comments, overflow.
- **Editing toolbar**: when the keyboard opens, the nav bar is replaced by a
  horizontally scrollable strip of formatting buttons docked above the keyboard.
- **Quick switcher**: search-as-you-type overlay; empty query shows recent files.
- **Pull-down "Quick Action"** gesture (default command palette) — omitted here (YAGNI).
- **Note options** via a `⋮` menu in the header (our OverflowMenu already covers this).

We mirror these patterns with our existing components.

## Architecture

### Breakpoint & detection

- New hook `useIsMobile()` in `src/hooks/useIsMobile.ts`:
  `window.matchMedia('(max-width: 767px)')` with a subscription
  (`useSyncExternalStore`). 768px matches Tailwind's `md:` boundary so CSS and JS
  branches agree; Tailwind `max-md:`/`md:` variants are used for pure-CSS cases.
- Exposed through a new `MobileContext` (provider in `AuthenticatedApp`) carrying:
  - `isMobile: boolean`
  - `activeDrawer: 'left' | 'right' | 'comments' | 'discussion' | null` + setters
    (single-drawer-at-a-time invariant lives here).
- Desktop path is untouched: when `isMobile` is false, everything renders exactly as
  today (panel manager, resize handles). `usePanelManager` is not modified.

### App shell (`App.tsx`)

Mobile branch:
- **Header** stays but slimmer: hamburger (opens left drawer), breadcrumb (truncated),
  and the existing `#header-controls` portal which already collapses to `OverflowMenu`
  at `headerStage === 'overflow'` (<600px header width — always true on phones).
  The desktop comments/right-sidebar toggle buttons in the header are hidden on mobile
  (bottom bar takes over).
- **Left sidebar**: not rendered in the flex row. Instead a fixed drawer:
  `fixed inset-y-0 left-0 w-[85vw] max-w-[320px] z-40` + scrim
  (`fixed inset-0 bg-black/40 z-30`), slide animation via `translate-x` transition.
  Contains the existing `<Sidebar />` unchanged.
- **ResizeHandles**: not rendered on mobile.
- **Bottom nav bar** (`MobileNavBar`, new component): fixed bottom, safe-area padded
  (`env(safe-area-inset-bottom)`), shown on all routes when mobile. Buttons:
  1. Sidebar (hamburger) — toggles left drawer
  2. Quick switcher (magnifier) — opens QuickSwitcher
  3. Right panel (TOC/backlinks icon) — toggles right drawer (editor routes only)
  4. Comments (bubble) — opens comments sheet (editor routes only)
  5. Overflow `⋯` — menu with: Discussion (when doc has one), Review suggestions,
     Promote to production, Add video/article (role-gated, same gating as routes).
  The main content column gets `padding-bottom` so content isn't hidden behind the bar.
- **Editor scroll containment**: `#root`/shell already `h-screen overflow-hidden`;
  use `100dvh` instead of `h-screen` on mobile so browser chrome collapse doesn't
  clip the bottom bar.

### EditorArea (mobile branch)

- **Comment margin**: not rendered as a column. Instead `MobileCommentsSheet` (new):
  a bottom sheet (`fixed inset-x-0 bottom-0 max-h-[70dvh] rounded-t-xl z-40` + scrim)
  listing threads in document order, reusing `CommentCard` and `AddCommentForm` with
  the same `useThreadsFromYText` callbacks. Tapping a `.cm-comment-badge` in the editor
  opens the sheet and scrolls to/focuses that thread. "+ Add" works from the current
  selection via the existing `getInsertKey` mechanism. `CommentsLayer` (PAV layout) is
  not mounted on mobile.
- **Right sidebar (TOC + backlinks)**: rendered inside a right drawer
  (same pattern as left), stacked vertically with natural scrolling (no
  `useAutoSplitHeight`, no resize handles).
- **Discussion**: full-height right drawer (own drawer id, opened from overflow menu /
  bottom bar), containing `ConnectedDiscussionPanel` unchanged.
- **Auto-collapse effect** (`collapseWithInfinity('comment-margin')` on docs without
  comments) is skipped on mobile — irrelevant to sheet model.
- **Editor theme**: on mobile reduce horizontal content padding (24px→16px) and bottom
  padding; `fontSize` stays 16px (also prevents iOS zoom-on-focus).

### Mobile formatting toolbar (`MobileEditToolbar`, new)

- Shown instead of the nav bar when the CodeMirror editor has focus (tracked via
  CM `updateListener`/focus events surfaced from `Editor.tsx` through a callback).
- Positioned above the keyboard using `window.visualViewport` (listen to
  `resize`/`scroll`, set `bottom: (innerHeight - vv.height - vv.offsetTop)`).
- Horizontally scrollable strip of buttons dispatching CM transactions:
  bold, italic, strikethrough, highlight, H1-H3 cycle, bullet list, numbered list,
  checkbox, quote, code, wikilink `[[]]`, undo, redo, keyboard-dismiss (blur).
- Implemented with a small `toggleInlineMark` / `setLineBlock` helper module
  (`src/lib/editor-commands.ts`) + unit tests.

### QuickSwitcher (mobile tweaks)

- At `max-md`: position `top-0`, full width, `h-[60dvh]` list, larger row padding
  (44px touch targets), input font ≥16px. Opened from bottom bar button (in addition
  to Ctrl+O).

### ReviewPage

- Header row and FilterBar: allow wrapping (`flex-wrap`), full-width buttons where
  needed; suggestion rows stack metadata above actions at `max-md`. Touch-size the
  accept/reject buttons.

### PromotionPage

- The `table-fixed` table becomes stacked cards at `max-md`: each row renders as a
  card (path, status pill, timestamps, actions). Implemented via a `md:` split —
  `<table>` hidden below `md`, card list hidden above. DiffViewer gets
  `overflow-x-auto`.

### index.html

- Add `viewport-fit=cover, maximum-scale=1` to the viewport meta (safe-area +
  prevent double-tap zoom quirks in the editor), `theme-color`. (No full PWA
  manifest in this pass — YAGNI.)

## New files

| File | Purpose |
|---|---|
| `src/hooks/useIsMobile.ts` (+test) | matchMedia breakpoint hook |
| `src/contexts/MobileContext.tsx` | isMobile + single-active-drawer state |
| `src/components/Mobile/MobileNavBar.tsx` | bottom navigation bar |
| `src/components/Mobile/MobileDrawer.tsx` | reusable left/right drawer + scrim shell |
| `src/components/Mobile/MobileCommentsSheet.tsx` | bottom-sheet comments list |
| `src/components/Mobile/MobileEditToolbar.tsx` | keyboard formatting toolbar |
| `src/lib/editor-commands.ts` (+test) | CM formatting commands for the toolbar |

## Known limitations (accepted in this pass)

- Edu editor and section editor have no mobile toolbar/panels (edu explicitly
  out of scope; section editor rarely used on phones).
- Drawers have Escape-to-close, scrim-tap, swipe-to-close, and Android
  back-button dismissal (one pushed history entry) but no full focus trap.
- Drawers open by full-surface horizontal swipe (revised after device testing:
  user requested swipes; edge-anchored zones conflict with the Android system
  back gesture, so swipes work anywhere on the content, guarded by 2.5×
  horizontal dominance, no-active-selection, and excluded UI regions).
  Dedicated buttons remain the primary affordance.
- iOS Safari keyboard geometry relies on visualViewport; verify on a real
  device (toolbar/sheet offsets may need tuning).
- Suggestion-mode formatting from the toolbar is wrapped as CriticMarkup via
  the `userEvent: 'input.format'` annotation (same filter as typing).

## Error handling & edge cases

- Rotation / resize across the breakpoint: drawers close when `isMobile` flips;
  desktop panel state is preserved (manager untouched while mobile).
- Keyboard heuristics: visualViewport unavailable (old browsers) → toolbar docks at
  bottom; still usable.
- Back button: opening a drawer pushes one history entry so Android back
  dismisses it; orphaned entries (drawer closed by navigation/rotation) are
  skipped by the popstate handler.
- Read-only roles: comments sheet respects `canWrite`; edit toolbar hidden when
  `readOnly`.

## Testing

- Vitest co-located tests: `useIsMobile`, `editor-commands`, `MobileNavBar` render
  logic (route/role gating), `MobileCommentsSheet` (thread list + add flow, reusing
  MockRelayProvider patterns).
- Existing tests must stay green (desktop default in happy-dom: `matchMedia` may need
  a shim in `src/test/setup.ts`).
- Manual verification via Chrome DevTools device emulation (390×844) against
  `npm run relay:start` + `npm run dev:local`, checking: navigation, editing +
  toolbar, comments, TOC/backlinks, discussion, quick switcher, review page,
  promotion page, and desktop non-regression at 1440px.
