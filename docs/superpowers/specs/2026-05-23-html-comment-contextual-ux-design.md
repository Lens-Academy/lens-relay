# HTML Comment Contextual UX Design

## Context

HTML comments v2 currently supports comment markers, rendered dots, thread popovers, orphan reporting, and probe-based placement. The remaining UX problem is that comment placement is hard to evaluate and feels indirect:

- The primary path requires clicking a toolbar `Comment` button before interacting with the preview.
- Placement immediately creates an empty root comment, then the visible text box adds a reply to that empty root.
- Preview refreshes can reset the iframe scroll position after placement.
- Marker dots are element-anchored, so they do not indicate exact per-character source placement.

This spec scopes the next pass to the first three issues. Exact per-letter visual anchoring remains future work.

## Goals

- Make adding an HTML preview comment feel like the markdown editor's comment flow.
- Let users start comments contextually from the rendered preview with right-click or selected text.
- Do not write empty `lens-comment` markers.
- Preserve the preview scroll position across comment creation.
- Keep the existing toolbar `Comment` button as a fallback while the contextual flow settles.

## Non-Goals

- No exact text-node or per-letter dot positioning in the preview.
- No quoted selected-text payload in markers.
- No redesign of markdown comments.
- No broad comment data-model rewrite.

## Existing UI To Reuse

Reuse the markdown comment form pattern:

- `lens-editor/src/components/CommentsPanel/AddCommentForm.tsx`
- `lens-editor/src/components/CommentMargin/NewCommentCard.tsx`

HTML preview should use the same `AddCommentForm` behavior and visual language for new root comments: focused textarea, `Comment` submit label, `Cancel`, `Enter` to submit, `Shift+Enter` for newline, and `Escape` to cancel.

The existing HTML `CommentThread` can continue to display saved threads and replies, but the new-comment composer should not look or behave like a reply to an empty root comment.

## Proposed UX

### Right-Click In Preview

When the user right-clicks rendered HTML content, the app prevents the browser context menu inside the preview and shows a compact comment popover near the click location.

The popover contains:

- The reused `AddCommentForm`
- Submit label: `Comment`
- Cancel behavior that closes the popover without changing the source

Submitting creates one `lens-comment` marker with the typed body at the resolved source position. Cancelling creates no marker.

### Text Selection In Preview

When the user selects text in the rendered preview, show the same add-comment popover near the selection. Submitting uses the same placement pipeline as right-click.

Selection is only an intent signal for this slice. The selected text is not quoted into the comment and is not stored in marker payloads.

### Toolbar Fallback

The toolbar `Comment` button remains available but is no longer the primary path. It keeps the current click-to-place behavior during this slice, with one important change: it must also use the new root-comment composer before writing a marker.

## Placement Flow

The placement pipeline should become two-phase:

1. Capture a placement request from preview interaction.
2. Resolve a source position, then open the composer without mutating the source.
3. On submit, write the `lens-comment` marker with the entered body.
4. On cancel, discard the pending placement.

The existing `scoreCandidates` and `verifyByProbe` logic remains the source-position resolver. If the resolver finds one position or probe-verifies a position, the composer can open immediately. If the resolver cannot disambiguate, switch to split view and highlight the possible source positions. After the user clicks one highlighted source position, open the same composer for that chosen position. Do not write a marker until submit.

Pending placement must be invalidated if:

- The source changes before submit.
- Toolbar comment mode is turned off while a toolbar-initiated placement is pending.
- The preview unmounts.
- The user cancels the composer.

## Scroll Preservation

Before writing the marker, capture the visible iframe scroll position. After the debounced preview refresh caused by the source mutation, restore that scroll position in the preview iframe.

This preservation only needs to handle same-document comment insertion. It does not need to preserve scroll across file switches or large user-authored source rewrites.

## Data Model

No marker schema change is needed.

New root comments continue to serialize as:

```html
<!--lens-comment {"id":"...","author":"...","ts":"...","body":"typed comment"}-->
```

Replies continue to serialize as `lens-reply` markers adjacent to the root marker cluster.

## Component Changes

- `HtmlPreview`
  - Capture right-click and selection placement requests from the bridge.
  - Resolve placement without immediately calling `addComment`.
  - Own or report pending composer coordinates.
  - Preserve iframe scroll around submitted mutations.

- `bridge-script`
  - Add context-menu capture for right-click.
  - Add selection-driven add-comment intent.
  - Continue sandbox-safe postMessage communication.

- `HtmlEditor`
  - Track pending placement position/candidates and pending composer state.
  - Reuse `NewCommentCard` or an HTML-specific wrapper around `AddCommentForm`.
  - Ensure manual source selection opens the composer instead of writing an empty marker.

- `CommentThread`
  - Keep handling saved threads and replies.
  - Avoid being used as the initial empty-comment composer.

## Testing

Add focused tests for:

- Right-click preview interaction opens an add-comment composer without mutating `Y.Text`.
- Submitting the composer writes one `lens-comment` marker with the typed body.
- Cancelling the composer writes no marker.
- Toolbar fallback no longer creates an empty root comment.
- Manual ambiguous placement opens the composer after source-position selection and writes only on submit.
- Preview scroll position is restored after submitted marker insertion.
- Existing reply/edit/delete behavior still works for saved threads.

Manual smoke should verify:

- Right-click add comment in preview.
- Select text, then add comment from the popover.
- Cancel leaves no marker.
- Adding a comment does not reset preview scroll.
- Dots and existing thread popovers still work.

## Confirmed Decisions

Defaults accepted for this slice:

- Right-click replaces the browser context menu inside the preview.
- Selected text opens the add-comment UI but is not quoted in the comment.
- Comments save only after typing and submitting.
- The toolbar button remains as fallback.
- Exact per-letter rendered dot placement is deferred.
