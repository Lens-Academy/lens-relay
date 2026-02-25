# Responsive Layout Design

## Problem

When the browser window resizes, all panels (sidebars + editor content) scale proportionally. This means sidebars become unusably narrow at smaller widths, and the header overflows without any adaptation. Obsidian keeps sidebars fixed and only resizes content; we want a hybrid: content absorbs most of the resize, sidebars shrink slowly, and auto-collapse when space runs out.

## Approach

Keep `react-resizable-panels` for user-initiated drag resize. Add a `ResizeObserver` layer for:
- Dynamic percentage-based minimums derived from pixel values
- Auto-collapse trigger when content would go below its minimum
- Header breakpoint detection

## Resize Behavior

### Proportional resize (above minimums)

The library's default percentage-based behavior already creates a hybrid effect: sidebars at 18-22% lose small absolute amounts while content at ~60% loses more. This is close to the desired behavior without any modification.

### Pixel minimums

A `ResizeObserver` on the panel group container tracks width. On each resize, it recomputes percentage equivalents for pixel minimums and updates panel constraints:

| Element | Pixel Minimum | Default % |
|---------|--------------|-----------|
| Left sidebar | 200px | 18% |
| Right sidebar (TOC/backlinks/comments) | 200px | 22% |
| Discussion panel | 250px | ~20% |
| Main content | 450px | flex remainder |

### Auto-collapse

When the container width drops below the collapse threshold (the point where content would hit 450px with all sidebars at their pixel minimums), all side panels auto-collapse simultaneously via the imperative API.

- Without discussion: `200 + 200 + 450 = 850px`
- With discussion: `200 + 200 + 250 + 450 = 1100px`

Auto-collapse is a **one-time trigger** when crossing the threshold downward. A boolean ref tracks whether collapse has fired. It resets when the container width goes back above the threshold.

Sidebar toggle buttons remain visible in the header at all times. The user can re-expand sidebars after auto-collapse, and they stay open even if the window narrows further. Only the next downward threshold crossing re-triggers collapse.

## Discussion Panel Upgrade

The discussion panel (currently a fixed `w-80` div outside the panel system) becomes a proper `Panel` inside the editor-area group:

```
Group#editor-area
  Panel#editor (main content)
  Separator
  Panel#right-sidebar (TOC/backlinks/comments)
  Separator
  Panel#discussion (collapsible, resizable)
```

- Conditional rendering (only when `discussion` frontmatter exists) with `id` and `order` props
- Collapsible with toggle button in the header
- Default ~20%, min derived from 250px

## Responsive Header

The header uses `ResizeObserver` (header-width-based, not viewport-based) to progressively compact:

| Stage | Header Width | Change |
|-------|-------------|--------|
| Full | > 1100px | Everything visible with labels |
| Compact toggles | < 1100px | Suggestion/Editing toggle: icon-only (hide text labels) |
| Hide title | < 900px | "Lens Editor" title disappears |
| Hide username | < 750px | DisplayNameBadge hides name text |
| Overflow menu | < 600px | Suggestion/editing + source/preview toggles move to "..." dropdown |

Implementation via a `useHeaderBreakpoints` hook that returns the current stage. Components adapt:
- Toggle components accept `iconOnly` prop
- Title gets conditional `hidden` class
- DisplayNameBadge accepts `compact` prop
- `OverflowMenu` component collects overflowed items

## Implementation Components

1. **`useResponsiveLayout` hook** — ResizeObserver on panel container, computes dynamic minSize percentages, fires auto-collapse
2. **`useHeaderBreakpoints` hook** — ResizeObserver on header element, returns current responsive stage
3. **Discussion panel integration** — move into panel group, add toggle button, wire up collapse state
4. **Header component updates** — iconOnly/compact props on toggles and badge, OverflowMenu component
