# HTML Inline Comment Markers Design

## Goal

HTML preview comments should have a clickable inline marker at the exact rendered text location where the comment was created.

## Design

New HTML comments attach only to plain rendered text. Creating a comment inserts a visible source anchor immediately before the hidden comment metadata:

```html
[[@comment:c1]]<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"note"}-->
```

The visible anchor participates in normal browser layout, so it appears at the same location as the source insertion. The preview bridge then upgrades that text token into a small inline button. Clicking the button uses the existing `dot-clicked` message path to open the comment thread.

Existing documents with older `<!--lens-comment ...-->` markers remain readable. If a comment has no inline anchor, the bridge keeps the existing fallback overlay dot anchored near the following rendered element so old comments do not disappear.

## Boundaries

- `comment-store.ts` owns serialization, parsing, editing, deleting, and insertion of anchored comments.
- `bridge-script.ts` owns preview rendering of inline buttons and fallback dots.
- `HtmlPreview.tsx` keeps the existing comment thread selection flow.

## Testing

- Unit tests cover anchored serialization and source bounds.
- Unit tests cover editing and deleting anchored comments without losing or orphaning the anchor.
- Bridge wiring tests cover replacing a visible anchor with a clickable inline marker.
- Bridge wiring tests keep fallback overlay behavior for old comments.
