# Multi-Tab / Split-Pane Editing — Scope Exploration

**Date:** 2026-02-23
**Status:** Exploration (no implementation decision yet)

## Goal

Allow multiple open files/tabs within a single browser tab, with Obsidian/VS Code-style interactivity: tab bar, split panes (horizontal and vertical), moveable/collapsible/resizable side panels.

## Current Architecture

The editor is a single-document-at-a-time app:

```
URL (/:docUuid/*) → DocumentView → RelayProvider(key=docId) → EditorArea
```

- **One Y.Doc connection** at a time (`RelayProvider` wraps `YDocProvider` from `@y-sweet/react`)
- Switching documents **unmounts the entire editor** (keyed on `docId`)
- Sidebar lives **outside** the RelayProvider boundary (already stable across doc switches)
- Right panels (ToC, Backlinks, Comments) are tightly coupled to the single active editor

## The 6 Major Work Areas

### 1. Y.Doc Connection Pool (High complexity)

**Problem:** Each document gets exactly one `YDocProvider`, created on mount, destroyed on unmount. Multi-tab means N simultaneous WebSocket connections to the relay server.

**What's needed:**

- A `DocConnectionManager` that owns multiple Y.Doc instances
- Reference counting — connect when a tab opens, disconnect when the last tab using that doc closes
- The `@y-sweet/react` provider assumes one doc per provider tree. Options:
  - Nest multiple `YDocProvider`s (one per open tab), or
  - Drop the React wrapper and manage Y.Docs directly via the y-sweet client SDK
- **Memory budget**: each Y.Doc + WebSocket + CodeMirror instance costs ~2-5MB. With 10 tabs open, that's 20-50MB
- Awareness (cursors/presence) needs to work per-doc, not globally

**Estimated effort:** Medium-Large. The y-sweet React bindings aren't designed for this — likely requires a custom provider.

### 2. Tab State Management (Medium complexity)

**Problem:** No concept of "open tabs" exists. The URL represents one document.

**What's needed:**

- A `TabStore` tracking: open tabs (ordered list), active tab per group, tab groups (for splits), dirty state
- **URL strategy**: URL can only represent the active tab. Open tabs live in React state + localStorage/sessionStorage
- Session persistence: reopen tabs on page refresh (serialize tab list to localStorage)
- Tab operations: open, close, reorder (drag), close others, close all, close to the right
- Pinned tabs (optional, Obsidian supports this)
- Opening links: Ctrl+click = new tab, regular click = reuse current tab (or navigate within it)

**Estimated effort:** Medium. Complex but well-understood React state management.

### 3. Layout Engine — Splits & Docking (High complexity)

**Problem:** The editor area is a single `<main>` with one editor. Splits require a layout model.

**Library comparison:**

| Library | Stars | Weekly DL | Zero-dep | Splits | Tab DnD | Floating | Verdict |
|---------|-------|-----------|----------|--------|---------|----------|---------|
| **dockview** | 2.9k | 34k | Yes | Yes | Yes | Yes | Best fit — VS Code-inspired, serializable layouts, `always` render mode keeps DOM alive |
| **FlexLayout** | 1.2k | — | React-only | Yes | Yes | Yes | Good alternative — JSON model, border panels (vertical tabs like VS Code sidebar) |
| **Custom (no lib)** | — | — | — | Basic | Basic | No | Simpler but massive effort for drag-to-split UX |

**Dockview is the strongest candidate** because:

- `always` rendering mode keeps hidden panels in the DOM (critical for preserving CodeMirror scroll position and Y.js sync state)
- Built-in serialization (`toJSON`/`fromJSON`) for layout persistence
- Tab drag between groups, split in any direction, floating panels
- Custom tab renderers (show sync status, unsaved indicators)
- 34k weekly downloads, actively maintained (v5.0.0 released Feb 2026)

**What integration looks like:**

- Replace `EditorArea` with a `DockviewReact` component
- Each panel renders a `DocumentEditor` (CodeMirror + Y.Doc connection)
- Side panels (ToC, Backlinks) become dockview panels that can be moved/collapsed
- Layout serialized to localStorage on change, restored on load

**Estimated effort:** Large. Dockview handles the hard parts (drag, split, resize), but wiring it to Y.Doc connections and CodeMirror instances is significant.

### 4. Editor Instance Management (Medium-High complexity)

**Problem:** One CodeMirror `EditorView` exists at a time. Multi-tab means multiple instances.

**What's needed:**

- Each tab gets its own `EditorView` bound to its own `Y.Text`
- The `yCollab` extension (cursors, undo) must be per-instance
- When a tab becomes active, its CodeMirror view needs to be focused and potentially resized
- **Undo/redo** must be scoped per-tab (already using `Y.UndoManager` per doc, but need one per editor instance)
- Extensions (markdown, wikilinks, live preview, suggestion mode) must be instantiated per editor
- `onNavigate` callback for wikilinks needs to know: open in current tab? new tab? existing tab for that doc?

**Estimated effort:** Medium. Mostly instantiation plumbing, but edge cases around focus, resize observers, and extension lifecycle.

### 5. Side Panel Refactoring (Medium complexity)

**Problem:** ToC, Backlinks, Comments panels are hardcoded in `EditorArea`'s JSX, coupled to a single `editorView`.

**What's needed:**

- These become context-aware panels that react to "which tab/editor is active"
- ToC needs the active editor's `EditorView` reference
- Backlinks needs the active `currentDocId`
- Comments needs both
- If panels become dockable (moveable left/right/floating), they'd be registered as dockview panel types
- The Discussion panel (Discord bridge) similarly needs to track the active doc

**Estimated effort:** Medium. Mostly plumbing — pass active-tab context instead of direct props.

### 6. Navigation & Routing Overhaul (Medium complexity)

**Problem:** Current routing is `/:docUuid/*` → renders that single document. No concept of "open this as a tab."

**What's needed:**

- URL continues to represent the active tab: `/:docUuid/*`
- Switching tabs updates the URL (via `history.replaceState`, not a full navigation)
- `onNavigate` becomes `onOpenDocument` with options: `{ target: 'current-tab' | 'new-tab' | 'split-right' }`
- Quick Switcher (Ctrl+O) opens in new tab or navigates existing
- Sidebar clicks: single click = open in current tab (or switch to existing tab), Ctrl+click = new tab
- Back/forward browser buttons: navigate tab history within the active tab (needs per-tab history stack)
- Share links: open the shared doc as a tab in whatever layout the user has

**Estimated effort:** Medium. The tricky part is per-tab history and making browser back/forward feel natural.

## Dependency Graph

```
                    ┌─────────────────┐
                    │ 1. Y.Doc Pool   │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
   ┌──────────────┐  ┌─────────────┐  ┌──────────────┐
   │ 2. Tab State │  │ 4. Editor   │  │ 6. Navigation│
   │    Store     │  │  Instances  │  │   Overhaul   │
   └──────┬───────┘  └──────┬──────┘  └──────────────┘
          │                 │
          ▼                 ▼
   ┌─────────────────────────────┐
   │ 3. Layout Engine (dockview) │
   └──────────────┬──────────────┘
                  │
                  ▼
         ┌────────────────┐
         │ 5. Side Panel  │
         │   Refactoring  │
         └────────────────┘
```

## Incremental Delivery Path

| Phase | Scope | What ships | Effort |
|-------|-------|------------|--------|
| **Phase 1** | Tab bar (no splits) | Multiple tabs, tab switching, close/reorder, session persistence | ~1-2 weeks |
| **Phase 2** | Split panes | Dockview integration, split left/right/up/down, drag tabs between groups | ~1-2 weeks |
| **Phase 3** | Moveable panels | ToC/Backlinks/Comments as dockable panels, layout persistence | ~1 week |

Phase 1 could be done without dockview (custom tab bar + multiple RelayProviders), keeping it simpler but requiring a rewrite when adding splits. Starting with dockview from Phase 1 means more upfront work but no throwaway code.

## Key Risks

1. **Y-sweet React bindings**: `@y-sweet/react`'s `YDocProvider` assumes one doc per provider subtree. Multiple simultaneous connections may require dropping down to the imperative API.

2. **Memory pressure**: Each open tab holds a full Y.Doc + CodeMirror in memory. Need a strategy for "soft-closing" (disconnect WebSocket but keep tab state) for tabs idle > N minutes.

3. **Awareness conflicts**: With multiple docs connected, the presence system needs to show which document each collaborator is actually viewing, not just that they're connected.

4. **CodeMirror lifecycle**: CodeMirror doesn't love being hidden/shown. Dockview's `always` render mode helps, but scroll position, selection, and resize behavior need testing.

5. **Wikilink navigation**: Today, clicking `[[Page]]` does a full navigation. It needs to become "open in tab" — this touches the editor extensions (CodeMirror plugins), not just React routing.
