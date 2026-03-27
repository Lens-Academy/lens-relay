# Sticky Scroll Direct DOM Rendering

**Date:** 2026-03-24
**Status:** Draft

## Problem

The sticky scroll overlay updates via React state (`setStickyNodes` → reconcile → DOM commit), adding 1-2 frames of lag during fast scrolling. The overlay visibly desyncs from the tree content.

## Solution

Replace React-managed rendering with direct DOM manipulation in the scroll handler. Pre-allocate a fixed pool of header DOM elements on mount. Update their properties imperatively in the rAF callback. Zero React renders during scroll.

## Architecture

### Two-phase approach (VS Code pattern)

**Mount phase (React):** The component renders a single container div via `useRef`. On mount, a `useEffect` creates MAX_STICKY_DEPTH (5) header row elements via `document.createElement` and appends them to the container. Each row contains the full structure: indent guide spans (MAX_STICKY_DEPTH pre-allocated, extras hidden), chevron SVG, folder icon SVG, name span. Element references are cached in a "view holder" array for O(1) access during scroll.

**Scroll phase (imperative):** The rAF-gated scroll handler runs the existing computation algorithm (`getAncestorFolders`, `findLastDescendantIndex`, hybrid floor+edge, viewport push-up) — unchanged. Then instead of `setStickyNodes(result)`, it writes directly to the pre-allocated elements:

- `row.style.transform = translateY(${top}px)` for position
- `row.style.display = 'flex' | 'none'` for visibility
- `nameSpan.textContent = folderName` for the label
- `chevronSvg.style.transform` for open/closed rotation
- Show/hide indent guide spans based on depth
- `container.style.height` for the overlay extent
- Store `nodeId` on each row via `dataset.nodeId` for click handling

### Fast path optimization (VS Code's `animationStateChanged`)

Track the previous computation result in a ref. If only the positions changed (same set of ancestor IDs), skip all textContent/display mutations and only update `style.transform` on the affected rows. This is the common case during smooth scrolling within a single folder section.

### Click handling

Use event delegation: a single `click` listener on the container. Read `event.target.closest('[data-node-id]').dataset.nodeId` to identify which header was clicked. Call `treeApi.get(id).toggle()` + `treeApi.scrollTo(id, 'smart')`. Recompute imperatively afterward.

### Structure changes

When `treeApi.visibleNodes.length` changes (expand/collapse), trigger a full recompute (same as scroll handler). This is the only time React triggers recomputation — via a `useEffect` that watches `visibleNodes.length`.

### Scrollbar width

Measured once on mount via `scrollEl.offsetWidth - scrollEl.clientWidth`. Stored in a plain variable (not state). Applied as `container.style.right`.

## What changes

| Aspect | Before | After |
|--------|--------|-------|
| Element creation | React JSX on every render | `document.createElement` once on mount |
| Scroll update | `setStickyNodes()` → React reconcile | Direct `style.transform`/`textContent` writes |
| Container height | React-computed `style={{ height }}` | `container.style.height = ...` |
| Click handling | React `onClick` per element | Event delegation on container |
| Cleanup | React unmount | `useEffect` cleanup removes elements + listener |

## What stays the same

- All computation logic (ancestor walking, section-end detection, hybrid floor+edge algorithm, viewport-based push-up)
- The visual appearance of sticky headers (same classes, same structure)
- Integration with FileTree.tsx (same props, same mount point)
- The z-index fix on react-arborist's scroll container

## Files changed

- `lens-editor/src/components/Sidebar/StickyScrollOverlay.tsx` — full rewrite of rendering, computation logic preserved

## Risks

- **React style conflicts**: React must not set `style` props on the container div that would overwrite imperative mutations. Solution: render only a bare `<div ref={containerRef} />` with no style props.
- **SVG innerHTML**: Creating SVGs via `document.createElement` requires `document.createElementNS` with the SVG namespace. Alternative: create them once via `innerHTML` on the row template.
- **Memory**: 5 pre-allocated rows × ~10 child elements each = ~50 DOM nodes. Negligible.
