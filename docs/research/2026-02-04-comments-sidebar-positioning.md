# Comments Sidebar Positioning Research

## Goal

Implement Google Docs/Word-style margin annotations where comments float in a sidebar, vertically aligned with their position in the document text.

## How Obsidian's Commentator Plugin Does It

The [Commentator plugin](https://github.com/Fevol/obsidian-criticmarkup) by Fevol implements this pattern using CodeMirror 6.

### Gutter Positioning

Located in `src/editor/renderers/gutters/annotations-gutter/`:

- Uses CodeMirror's `BlockInfo` objects which provide `top` coordinates for each line relative to the viewport
- The `AnnotationUpdateContext.addElement()` method calculates vertical positioning:
  ```typescript
  const above = Math.max(block.top - this.previous_element_end, 0);
  const block_start = above <= 0 ? this.previous_element_end : block.top;
  ```
- Tracks `previous_element_end` to prevent overlapping when multiple comments are close together
- Uses a 24px margin (`ANNOTATION_GUTTER_MARGIN`) between the gutter and editor content
- Known limitation: Only tracks the starting line of multi-line annotations

### Inline Comment Icons

Located in `src/editor/renderers/live-preview/comment-widget.ts`:

- Extends CodeMirror's `WidgetType` to create a `CommentIconWidget`
- Replaces `{>>comment<<}` markup with a small "message-square" icon
- Hover behavior: Shows a tooltip with rendered markdown content
- Click behavior: Focuses the comment, shows editable tooltip with context menu
- Tooltip displays replies and has options to edit/delete/reply

### Key CodeMirror APIs

- `BlockInfo.top` - vertical position of a line in the viewport
- `WidgetType` - for replacing markup with widget icons
- Decoration system for hiding original markup while showing widgets

## Our Approach

We want to implement **margin annotations with connection lines** (Google Docs/Word style):

1. **Sidebar positioning**: Comments float in a right sidebar, vertically aligned with their anchor position in the document
2. **Connection lines**: Visual lines connecting comment cards to their anchor point in the text
3. **Overlap handling**: When comments are close together, stack them but keep lines pointing to exact positions
4. **Inline markers**: Replace `{>>comment<<}` markup with a small icon/highlight in the text

## Implementation Considerations

- Need to coordinate CodeMirror viewport coordinates with React sidebar positioning
- Must handle scroll synchronization between editor and comment sidebar
- Consider how to handle comments that would render off-screen
- Thread grouping: Adjacent comments should still group into threads

## References

- [Commentator Plugin GitHub](https://github.com/Fevol/obsidian-criticmarkup)
- [Commentator Forum Announcement](https://forum.obsidian.md/t/beta-plugin-commentator-suggestions-and-comments-with-criticmarkup/66013)
- [SideNote Plugin](https://github.com/mofukuru/SideNote) - simpler alternative approach
