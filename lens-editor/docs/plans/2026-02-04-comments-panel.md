# Comments Panel Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Add a right sidebar panel that displays comments from CriticMarkup, grouped by threads, with add/edit/reply functionality.

**Architecture:** React component reads comments from `criticMarkupField` StateField via the EditorView. Comments are grouped into threads using `parseThreads()`. Edit-on-commit pattern: user types in textarea, changes write to Y.Text only on Enter/Save. Navigation: clicking a comment scrolls the editor to that position.

**Tech Stack:** React 18, CodeMirror 6 StateField, Vitest + Happy DOM for component tests, React Testing Library for UI tests.

**Prerequisites:**
- `src/lib/criticmarkup-parser.ts` - Parser with `parse()` and `parseThreads()` (DONE)
- `src/components/Editor/extensions/criticmarkup.ts` - StateField `criticMarkupField` (DONE)
- `src/components/Layout/EditorArea.tsx` - Layout with right sidebar pattern (DONE)
- `src/components/TableOfContents/TableOfContents.tsx` - Reference pattern for sidebar (DONE)

---

## Task 1: Create useComments Hook

A hook that extracts comments from the editor StateField and groups them into threads. Follows the same pattern as `useHeadings` for ToC.

**Files:**
- Create: `src/components/CommentsPanel/useComments.ts`
- Create: `src/components/CommentsPanel/useComments.test.ts`

### Step 1.1: Write failing test for useComments hook

**Note:** The hook is intentionally simple (no useMemo) because the parent component controls
re-renders via `stateVersion`. This avoids stale closure issues with `view.state`.

```typescript
// src/components/CommentsPanel/useComments.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createCriticMarkupEditor } from '../../test/codemirror-helpers';
import { useComments } from './useComments';

describe('useComments', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    if (cleanup) cleanup();
  });

  it('returns empty threads when view is null', () => {
    const { result } = renderHook(() => useComments(null));
    expect(result.current).toEqual([]);
  });

  it('returns empty threads when no comments in document', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello {++world++} end',
      0
    );
    cleanup = c;

    const { result } = renderHook(() => useComments(view));
    expect(result.current).toEqual([]);
  });

  it('returns single thread with single comment', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello {>>my comment<<} end',
      0
    );
    cleanup = c;

    const { result } = renderHook(() => useComments(view));

    expect(result.current).toHaveLength(1);
    expect(result.current[0].comments).toHaveLength(1);
    expect(result.current[0].comments[0].content).toBe('my comment');
  });

  it('groups adjacent comments into single thread', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'text{>>first<<}{>>reply<<} more',
      0
    );
    cleanup = c;

    const { result } = renderHook(() => useComments(view));

    expect(result.current).toHaveLength(1);
    expect(result.current[0].comments).toHaveLength(2);
    expect(result.current[0].comments[0].content).toBe('first');
    expect(result.current[0].comments[1].content).toBe('reply');
  });

  it('separates non-adjacent comments into different threads', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'text{>>first<<} gap {>>second<<} end',
      0
    );
    cleanup = c;

    const { result } = renderHook(() => useComments(view));

    expect(result.current).toHaveLength(2);
    expect(result.current[0].comments[0].content).toBe('first');
    expect(result.current[1].comments[0].content).toBe('second');
  });

  it('extracts metadata from comments', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      '{>>{"author":"alice","timestamp":1234567890}@@my note<<}',
      0
    );
    cleanup = c;

    const { result } = renderHook(() => useComments(view));

    expect(result.current).toHaveLength(1);
    expect(result.current[0].comments[0].metadata?.author).toBe('alice');
    expect(result.current[0].comments[0].metadata?.timestamp).toBe(1234567890);
  });

  it('updates when re-rendered after document change', () => {
    const { view, cleanup: c } = createCriticMarkupEditor('hello world', 0);
    cleanup = c;

    const { result, rerender } = renderHook(() => useComments(view));

    // Initially no comments
    expect(result.current).toEqual([]);

    // Modify document to add a comment
    view.dispatch({
      changes: { from: 0, insert: '{>>new comment<<}' },
    });

    // Re-render (simulates parent stateVersion change)
    rerender();

    // Now should have the comment
    expect(result.current).toHaveLength(1);
    expect(result.current[0].comments[0].content).toBe('new comment');
  });
});
```

### Step 1.2: Run test to verify it fails

Run: `npm test -- src/components/CommentsPanel/useComments.test.ts`

Expected: FAIL with "Cannot find module './useComments'"

### Step 1.3: Write minimal implementation

**Important:** We intentionally don't use `useMemo` here. The parent component (`CommentsPanel`)
passes `stateVersion` which triggers re-renders when the document changes. This avoids the
stale closure problem where `view.state` reference changes but React doesn't detect it.

```typescript
// src/components/CommentsPanel/useComments.ts
import type { EditorView } from '@codemirror/view';
import { criticMarkupField } from '../Editor/extensions/criticmarkup';
import { parseThreads, type CommentThread } from '../../lib/criticmarkup-parser';

/**
 * Hook that extracts comments from the editor and groups them into threads.
 *
 * Note: This hook does not memoize because the parent component controls
 * re-renders via stateVersion prop. Memoizing on view.state would create
 * stale closure issues since React can't properly detect state changes.
 *
 * @param view - The CodeMirror EditorView instance
 * @returns Array of comment threads (empty if view is null or no comments)
 */
export function useComments(view: EditorView | null): CommentThread[] {
  if (!view) return [];

  const ranges = view.state.field(criticMarkupField);
  return parseThreads(ranges);
}
```

### Step 1.4: Run test to verify it passes

Run: `npm test -- src/components/CommentsPanel/useComments.test.ts`

Expected: PASS (7 tests)

### Step 1.5: Commit

```bash
jj describe -m "feat(comments-panel): add useComments hook

- Extracts comments from criticMarkupField StateField
- Groups adjacent comments into threads using parseThreads
- Returns empty array when view is null or no comments

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Create CommentsPanel Base Component

The main panel component with empty/loading states. Follows TableOfContents pattern.

**Files:**
- Create: `src/components/CommentsPanel/CommentsPanel.tsx`
- Create: `src/components/CommentsPanel/CommentsPanel.test.tsx`
- Create: `src/components/CommentsPanel/index.ts`

### Step 2.1: Write failing test for CommentsPanel component

```typescript
// src/components/CommentsPanel/CommentsPanel.test.tsx
/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { CommentsPanel } from './CommentsPanel';
import { createCriticMarkupEditor } from '../../test/codemirror-helpers';

describe('CommentsPanel', () => {
  let editorCleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup();
    if (editorCleanup) editorCleanup();
  });

  it('shows "No document open" when view is null', () => {
    render(<CommentsPanel view={null} />);
    expect(screen.getByText('No document open')).toBeInTheDocument();
  });

  it('shows "No comments" when document has no comments', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello world',
      0
    );
    editorCleanup = c;

    render(<CommentsPanel view={view} />);
    expect(screen.getByText('No comments in document')).toBeInTheDocument();
  });

  it('shows panel header "Comments"', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      '{>>my comment<<}',
      0
    );
    editorCleanup = c;

    render(<CommentsPanel view={view} />);
    expect(screen.getByText('Comments')).toBeInTheDocument();
  });

  it('displays comment content', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello {>>my note<<} world',
      0
    );
    editorCleanup = c;

    render(<CommentsPanel view={view} />);
    expect(screen.getByText('my note')).toBeInTheDocument();
  });

  it('displays multiple threads', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      '{>>first<<} gap {>>second<<}',
      0
    );
    editorCleanup = c;

    render(<CommentsPanel view={view} />);
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();
  });
});
```

### Step 2.2: Run test to verify it fails

Run: `npm test -- src/components/CommentsPanel/CommentsPanel.test.tsx`

Expected: FAIL with "Cannot find module './CommentsPanel'"

### Step 2.3: Write minimal implementation

```typescript
// src/components/CommentsPanel/CommentsPanel.tsx
import type { EditorView } from '@codemirror/view';
import { useComments } from './useComments';

interface CommentsPanelProps {
  view: EditorView | null;
  stateVersion?: number; // Triggers re-render on doc changes
}

export function CommentsPanel({ view, stateVersion }: CommentsPanelProps) {
  // stateVersion triggers re-render (parent increments on doc change)
  void stateVersion;

  const threads = useComments(view);

  if (!view) {
    return (
      <div className="comments-panel p-3 text-sm text-gray-500">
        No document open
      </div>
    );
  }

  if (threads.length === 0) {
    return (
      <div className="comments-panel p-3 text-sm text-gray-500">
        No comments in document
      </div>
    );
  }

  return (
    <div className="comments-panel">
      <h3 className="px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider border-b border-gray-200">
        Comments
      </h3>
      <ul className="py-2">
        {threads.map((thread, threadIndex) => (
          <li
            key={`thread-${thread.from}-${threadIndex}`}
            className="border-b border-gray-100 last:border-0"
          >
            {thread.comments.map((comment, commentIndex) => (
              <div
                key={`comment-${comment.from}-${commentIndex}`}
                className="px-3 py-2 text-sm text-gray-700"
              >
                {comment.content}
              </div>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

### Step 2.4: Create index file

```typescript
// src/components/CommentsPanel/index.ts
export { CommentsPanel } from './CommentsPanel';
export { useComments } from './useComments';
```

### Step 2.5: Run test to verify it passes

Run: `npm test -- src/components/CommentsPanel/CommentsPanel.test.tsx`

Expected: PASS (5 tests)

### Step 2.6: Commit

```bash
jj describe -m "feat(comments-panel): add base CommentsPanel component

- Shows 'No document open' when view is null
- Shows 'No comments in document' when empty
- Displays comment content from threads
- Uses useComments hook for data

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Add Comment Metadata Display

Display author and timestamp for comments that have metadata.

**Files:**
- Modify: `src/components/CommentsPanel/CommentsPanel.tsx`
- Modify: `src/components/CommentsPanel/CommentsPanel.test.tsx`

### Step 3.1: Write failing test for metadata display

Add to `CommentsPanel.test.tsx`:

```typescript
describe('Comment Metadata', () => {
  it('displays author name when available', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      '{>>{"author":"alice"}@@my note<<}',
      0
    );
    editorCleanup = c;

    render(<CommentsPanel view={view} />);
    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  it('displays formatted timestamp when available', () => {
    // Timestamp: 2024-02-03 12:00:00 UTC
    const { view, cleanup: c } = createCriticMarkupEditor(
      '{>>{"timestamp":1706961600000}@@my note<<}',
      0
    );
    editorCleanup = c;

    render(<CommentsPanel view={view} />);
    // Should display relative or formatted time
    expect(screen.getByText(/Feb|2024|ago/)).toBeInTheDocument();
  });

  it('displays "Anonymous" when no author', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      '{>>my note<<}',
      0
    );
    editorCleanup = c;

    render(<CommentsPanel view={view} />);
    expect(screen.getByText('Anonymous')).toBeInTheDocument();
  });
});
```

### Step 3.2: Run test to verify it fails

Run: `npm test -- src/components/CommentsPanel/CommentsPanel.test.tsx`

Expected: FAIL with "Unable to find an element with the text: alice"

### Step 3.3: Update CommentsPanel with metadata display

Update the comment display section in `CommentsPanel.tsx`:

```typescript
// src/components/CommentsPanel/CommentsPanel.tsx
import type { EditorView } from '@codemirror/view';
import { useComments } from './useComments';
import type { CriticMarkupRange } from '../../lib/criticmarkup-parser';

interface CommentsPanelProps {
  view: EditorView | null;
  stateVersion?: number;
}

/**
 * Format a timestamp for display.
 * Uses relative time for recent, absolute for older.
 */
function formatTimestamp(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  // Less than 1 minute
  if (diff < 60000) return 'just now';
  // Less than 1 hour
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  // Less than 1 day
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  // Less than 7 days
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;

  // Older - show date
  return new Date(timestamp).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: timestamp < now - 31536000000 ? 'numeric' : undefined,
  });
}

/**
 * Component for displaying a single comment.
 */
function CommentItem({ comment }: { comment: CriticMarkupRange }) {
  const author = comment.metadata?.author || 'Anonymous';
  const timestamp = comment.metadata?.timestamp;

  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-sm font-medium text-gray-900">{author}</span>
        {timestamp && (
          <span className="text-xs text-gray-400">
            {formatTimestamp(timestamp)}
          </span>
        )}
      </div>
      <p className="text-sm text-gray-700">{comment.content}</p>
    </div>
  );
}

export function CommentsPanel({ view, stateVersion }: CommentsPanelProps) {
  void stateVersion;

  const threads = useComments(view);

  if (!view) {
    return (
      <div className="comments-panel p-3 text-sm text-gray-500">
        No document open
      </div>
    );
  }

  if (threads.length === 0) {
    return (
      <div className="comments-panel p-3 text-sm text-gray-500">
        No comments in document
      </div>
    );
  }

  return (
    <div className="comments-panel">
      <h3 className="px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider border-b border-gray-200">
        Comments
      </h3>
      <ul className="py-2">
        {threads.map((thread, threadIndex) => (
          <li
            key={`thread-${thread.from}-${threadIndex}`}
            className="border-b border-gray-100 last:border-0"
          >
            {thread.comments.map((comment, commentIndex) => (
              <CommentItem
                key={`comment-${comment.from}-${commentIndex}`}
                comment={comment}
              />
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

### Step 3.4: Run test to verify it passes

Run: `npm test -- src/components/CommentsPanel/CommentsPanel.test.tsx`

Expected: PASS (8 tests)

### Step 3.5: Commit

```bash
jj describe -m "feat(comments-panel): add author and timestamp display

- Shows author name or 'Anonymous' fallback
- Formats timestamp as relative time (ago) or date
- Extract CommentItem as internal component

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Add Click-to-Navigate

Clicking a comment scrolls the editor to that position.

**Files:**
- Modify: `src/components/CommentsPanel/CommentsPanel.tsx`
- Modify: `src/components/CommentsPanel/CommentsPanel.test.tsx`

### Step 4.1: Write failing test for navigation

Add to `CommentsPanel.test.tsx`:

```typescript
import { fireEvent } from '@testing-library/react';

describe('Navigation', () => {
  it('scrolls editor to comment position when clicked', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello {>>my note<<} world',
      0
    );
    editorCleanup = c;

    render(<CommentsPanel view={view} />);

    const comment = screen.getByText('my note');
    fireEvent.click(comment);

    // Cursor should move to comment position
    const cursorPos = view.state.selection.main.head;
    // Comment is at position 6 (after "hello ")
    expect(cursorPos).toBeGreaterThanOrEqual(6);
    expect(cursorPos).toBeLessThanOrEqual(22);
  });

  it('has cursor pointer on comment items', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      '{>>my note<<}',
      0
    );
    editorCleanup = c;

    const { container } = render(<CommentsPanel view={view} />);

    const commentItem = container.querySelector('.comment-item');
    expect(commentItem).toHaveClass('cursor-pointer');
  });
});
```

### Step 4.2: Run test to verify it fails

Run: `npm test -- src/components/CommentsPanel/CommentsPanel.test.tsx`

Expected: FAIL

### Step 4.3: Add click handler to CommentItem

Update `CommentsPanel.tsx`:

```typescript
/**
 * Scroll the editor to a specific position and focus it.
 */
function scrollToPosition(view: EditorView, pos: number): void {
  view.dispatch({
    selection: { anchor: pos },
    scrollIntoView: true,
  });
  view.focus();
}

/**
 * Component for displaying a single comment.
 */
function CommentItem({
  comment,
  onClick,
}: {
  comment: CriticMarkupRange;
  onClick?: () => void;
}) {
  const author = comment.metadata?.author || 'Anonymous';
  const timestamp = comment.metadata?.timestamp;

  return (
    <div
      className="comment-item px-3 py-2 cursor-pointer hover:bg-gray-50"
      onClick={onClick}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-sm font-medium text-gray-900">{author}</span>
        {timestamp && (
          <span className="text-xs text-gray-400">
            {formatTimestamp(timestamp)}
          </span>
        )}
      </div>
      <p className="text-sm text-gray-700">{comment.content}</p>
    </div>
  );
}

// In the CommentsPanel render:
{thread.comments.map((comment, commentIndex) => (
  <CommentItem
    key={`comment-${comment.from}-${commentIndex}`}
    comment={comment}
    onClick={() => scrollToPosition(view, comment.contentFrom)}
  />
))}
```

### Step 4.4: Run test to verify it passes

Run: `npm test -- src/components/CommentsPanel/CommentsPanel.test.tsx`

Expected: PASS (10 tests)

### Step 4.5: Commit

```bash
jj describe -m "feat(comments-panel): add click-to-navigate

- Clicking comment scrolls editor to that position
- Cursor moves to comment content start
- Editor gains focus after navigation

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: Add Thread Visual Grouping

Make threads visually distinct with styling and reply counts.

**Files:**
- Modify: `src/components/CommentsPanel/CommentsPanel.tsx`
- Modify: `src/components/CommentsPanel/CommentsPanel.test.tsx`

### Step 5.1: Write failing test for thread display

Add to `CommentsPanel.test.tsx`:

```typescript
describe('Thread Display', () => {
  it('shows thread with multiple replies grouped together', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      '{>>first<<}{>>reply1<<}{>>reply2<<}',
      0
    );
    editorCleanup = c;

    const { container } = render(<CommentsPanel view={view} />);

    // Should show as single thread with indented replies
    const thread = container.querySelector('.comment-thread');
    expect(thread).toBeInTheDocument();

    // First comment is root, rest are replies
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.getByText('reply1')).toBeInTheDocument();
    expect(screen.getByText('reply2')).toBeInTheDocument();
  });

  it('shows reply count for threads with multiple comments', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      '{>>first<<}{>>reply<<}',
      0
    );
    editorCleanup = c;

    render(<CommentsPanel view={view} />);
    expect(screen.getByText('1 reply')).toBeInTheDocument();
  });

  it('shows "replies" (plural) for 2+ replies', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      '{>>first<<}{>>reply1<<}{>>reply2<<}',
      0
    );
    editorCleanup = c;

    render(<CommentsPanel view={view} />);
    expect(screen.getByText('2 replies')).toBeInTheDocument();
  });
});
```

### Step 5.2: Run test to verify it fails

Run: `npm test -- src/components/CommentsPanel/CommentsPanel.test.tsx`

Expected: FAIL

### Step 5.3: Create CommentThread component

Add to `CommentsPanel.tsx`:

```typescript
import type { CommentThread as CommentThreadType } from '../../lib/criticmarkup-parser';

/**
 * Component for displaying a thread of comments.
 */
function CommentThread({
  thread,
  view,
}: {
  thread: CommentThreadType;
  view: EditorView;
}) {
  const rootComment = thread.comments[0];
  const replies = thread.comments.slice(1);
  const replyCount = replies.length;

  return (
    <div className="comment-thread">
      {/* Root comment */}
      <CommentItem
        comment={rootComment}
        onClick={() => scrollToPosition(view, rootComment.contentFrom)}
      />

      {/* Reply count */}
      {replyCount > 0 && (
        <div className="px-3 py-1 text-xs text-gray-500">
          {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
        </div>
      )}

      {/* Replies (indented) */}
      {replies.map((comment, index) => (
        <div key={`reply-${comment.from}-${index}`} className="pl-4">
          <CommentItem
            comment={comment}
            onClick={() => scrollToPosition(view, comment.contentFrom)}
          />
        </div>
      ))}
    </div>
  );
}

// Update the CommentsPanel render:
{threads.map((thread, threadIndex) => (
  <li
    key={`thread-${thread.from}-${threadIndex}`}
    className="border-b border-gray-100 last:border-0"
  >
    <CommentThread thread={thread} view={view} />
  </li>
))}
```

### Step 5.4: Run test to verify it passes

Run: `npm test -- src/components/CommentsPanel/CommentsPanel.test.tsx`

Expected: PASS (13 tests)

### Step 5.5: Commit

```bash
jj describe -m "feat(comments-panel): add thread visual grouping

- CommentThread component groups related comments
- Root comment displayed prominently
- Replies indented with count indicator
- Singular/plural 'reply/replies' label

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: Add New Comment Functionality

Allow users to add a new comment at the cursor position.

**Files:**
- Modify: `src/components/CommentsPanel/CommentsPanel.tsx`
- Modify: `src/components/CommentsPanel/CommentsPanel.test.tsx`
- Create: `src/components/CommentsPanel/AddCommentForm.tsx`
- Create: `src/components/CommentsPanel/AddCommentForm.test.tsx`

### Step 6.1: Write failing test for AddCommentForm

```typescript
// src/components/CommentsPanel/AddCommentForm.test.tsx
/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddCommentForm } from './AddCommentForm';

describe('AddCommentForm', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders textarea and submit button', () => {
    render(<AddCommentForm onSubmit={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByPlaceholderText(/add a comment/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add/i })).toBeInTheDocument();
  });

  it('calls onSubmit with comment text when form submitted', async () => {
    const onSubmit = vi.fn();
    render(<AddCommentForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    const textarea = screen.getByPlaceholderText(/add a comment/i);
    await userEvent.type(textarea, 'My new comment');
    fireEvent.click(screen.getByRole('button', { name: /add/i }));

    expect(onSubmit).toHaveBeenCalledWith('My new comment');
  });

  it('submits on Enter key (without shift)', async () => {
    const onSubmit = vi.fn();
    render(<AddCommentForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    const textarea = screen.getByPlaceholderText(/add a comment/i);
    await userEvent.type(textarea, 'Comment text');
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(onSubmit).toHaveBeenCalledWith('Comment text');
  });

  it('does not submit on Shift+Enter (allows newline)', async () => {
    const onSubmit = vi.fn();
    render(<AddCommentForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    const textarea = screen.getByPlaceholderText(/add a comment/i);
    await userEvent.type(textarea, 'Line one');
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('calls onCancel when cancel button clicked', () => {
    const onCancel = vi.fn();
    render(<AddCommentForm onSubmit={vi.fn()} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onCancel).toHaveBeenCalled();
  });

  it('does not submit when text is empty', () => {
    const onSubmit = vi.fn();
    render(<AddCommentForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /add/i }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('clears textarea after successful submit', async () => {
    const onSubmit = vi.fn();
    render(<AddCommentForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    const textarea = screen.getByPlaceholderText(/add a comment/i) as HTMLTextAreaElement;
    await userEvent.type(textarea, 'Comment text');
    fireEvent.click(screen.getByRole('button', { name: /add/i }));

    expect(textarea.value).toBe('');
  });
});
```

### Step 6.2: Run test to verify it fails

Run: `npm test -- src/components/CommentsPanel/AddCommentForm.test.tsx`

Expected: FAIL with "Cannot find module './AddCommentForm'"

### Step 6.3: Implement AddCommentForm

```typescript
// src/components/CommentsPanel/AddCommentForm.tsx
import { useState, useRef, useEffect } from 'react';

interface AddCommentFormProps {
  onSubmit: (content: string) => void;
  onCancel: () => void;
  placeholder?: string;
  submitLabel?: string;
  autoFocus?: boolean;
}

export function AddCommentForm({
  onSubmit,
  onCancel,
  placeholder = 'Add a comment...',
  submitLabel = 'Add',
  autoFocus = true,
}: AddCommentFormProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [autoFocus]);

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;

    onSubmit(trimmed);
    setText('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === 'Escape') {
      onCancel();
    }
  };

  return (
    <div className="add-comment-form p-3 bg-gray-50 border-t border-gray-200">
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        rows={3}
      />
      <div className="flex justify-end gap-2 mt-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1 text-sm text-gray-600 hover:text-gray-800"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          className="px-3 py-1 text-sm text-white bg-blue-600 rounded hover:bg-blue-700"
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
```

### Step 6.4: Run test to verify it passes

Run: `npm test -- src/components/CommentsPanel/AddCommentForm.test.tsx`

Expected: PASS (7 tests)

### Step 6.5: Add "Add Comment" button to CommentsPanel

Update `CommentsPanel.test.tsx`:

```typescript
describe('Add Comment', () => {
  it('shows "Add Comment" button', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello world',
      5
    );
    editorCleanup = c;

    render(<CommentsPanel view={view} />);
    expect(screen.getByRole('button', { name: /add comment/i })).toBeInTheDocument();
  });

  it('shows form when "Add Comment" clicked', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello world',
      5
    );
    editorCleanup = c;

    render(<CommentsPanel view={view} />);
    fireEvent.click(screen.getByRole('button', { name: /add comment/i }));

    expect(screen.getByPlaceholderText(/add a comment/i)).toBeInTheDocument();
  });

  it('inserts comment at cursor position when submitted', async () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello world',
      5 // cursor after "hello"
    );
    editorCleanup = c;

    render(<CommentsPanel view={view} />);
    fireEvent.click(screen.getByRole('button', { name: /add comment/i }));

    const textarea = screen.getByPlaceholderText(/add a comment/i);
    await userEvent.type(textarea, 'my note');
    fireEvent.click(screen.getByRole('button', { name: /add$/i }));

    // Document should contain the new comment
    expect(view.state.doc.toString()).toMatch(/\{>>.*my note<<\}/);
  });
});
```

### Step 6.6: Update CommentsPanel with add comment functionality

Add to `CommentsPanel.tsx`:

```typescript
import { useState } from 'react';
import { AddCommentForm } from './AddCommentForm';
import { getCurrentAuthor } from '../Editor/extensions/criticmarkup';

/**
 * Insert a new comment at the specified position.
 */
function insertComment(view: EditorView, content: string, pos: number): void {
  const author = getCurrentAuthor();
  const timestamp = Date.now();
  const meta = JSON.stringify({ author, timestamp });
  const markup = `{>>${meta}@@${content}<<}`;

  view.dispatch({
    changes: { from: pos, insert: markup },
  });
}

// In CommentsPanel component:
export function CommentsPanel({ view, stateVersion }: CommentsPanelProps) {
  const [showAddForm, setShowAddForm] = useState(false);
  // ... existing code ...

  const handleAddComment = (content: string) => {
    if (!view) return;
    const pos = view.state.selection.main.head;
    insertComment(view, content, pos);
    setShowAddForm(false);
  };

  // ... existing render ...

  return (
    <div className="comments-panel flex flex-col h-full">
      <h3 className="px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider border-b border-gray-200 flex items-center justify-between">
        <span>Comments</span>
        <button
          onClick={() => setShowAddForm(true)}
          className="text-blue-600 hover:text-blue-800 normal-case font-normal"
        >
          + Add Comment
        </button>
      </h3>

      {showAddForm && (
        <AddCommentForm
          onSubmit={handleAddComment}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      {/* existing threads list */}
    </div>
  );
}
```

### Step 6.7: Update exports

Add to `src/components/CommentsPanel/index.ts`:

```typescript
export { CommentsPanel } from './CommentsPanel';
export { useComments } from './useComments';
export { AddCommentForm } from './AddCommentForm';
```

### Step 6.8: Run all CommentsPanel tests

Run: `npm test -- src/components/CommentsPanel`

Expected: PASS

### Step 6.9: Commit

```bash
jj describe -m "feat(comments-panel): add new comment functionality

- AddCommentForm component with textarea
- Submit on Enter, cancel on Escape
- Insert comment at cursor with author/timestamp metadata
- Toggle form visibility with 'Add Comment' button

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: Add Reply to Thread

Allow users to reply to an existing thread (adds adjacent comment).

**Files:**
- Modify: `src/components/CommentsPanel/CommentsPanel.tsx`
- Modify: `src/components/CommentsPanel/CommentsPanel.test.tsx`

### Step 7.1: Write failing test for reply

Add to `CommentsPanel.test.tsx`:

```typescript
describe('Reply to Thread', () => {
  it('shows reply button on thread', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      '{>>first comment<<}',
      0
    );
    editorCleanup = c;

    render(<CommentsPanel view={view} />);
    expect(screen.getByRole('button', { name: /reply/i })).toBeInTheDocument();
  });

  it('shows reply form when reply button clicked', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      '{>>first comment<<}',
      0
    );
    editorCleanup = c;

    render(<CommentsPanel view={view} />);
    fireEvent.click(screen.getByRole('button', { name: /reply/i }));

    expect(screen.getByPlaceholderText(/reply/i)).toBeInTheDocument();
  });

  it('inserts reply adjacent to thread end', async () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      '{>>first<<} more text',
      0
    );
    editorCleanup = c;

    render(<CommentsPanel view={view} />);
    fireEvent.click(screen.getByRole('button', { name: /reply/i }));

    const textarea = screen.getByPlaceholderText(/reply/i);
    await userEvent.type(textarea, 'my reply');
    fireEvent.click(screen.getByRole('button', { name: /^reply$/i }));

    // Reply should be adjacent (no space between)
    const doc = view.state.doc.toString();
    expect(doc).toMatch(/<<\}\{>>.*my reply<<\}/);
  });
});
```

### Step 7.2: Run test to verify it fails

Run: `npm test -- src/components/CommentsPanel/CommentsPanel.test.tsx`

Expected: FAIL

### Step 7.3: Add reply functionality to CommentThread

Update `CommentsPanel.tsx`:

```typescript
/**
 * Insert a reply at the end of a thread (adjacent = same thread).
 */
function insertReply(view: EditorView, content: string, threadEnd: number): void {
  const author = getCurrentAuthor();
  const timestamp = Date.now();
  const meta = JSON.stringify({ author, timestamp });
  const markup = `{>>${meta}@@${content}<<}`;

  // Insert immediately after the thread's last comment (no space = same thread)
  view.dispatch({
    changes: { from: threadEnd, insert: markup },
  });
}

function CommentThread({
  thread,
  view,
}: {
  thread: CommentThreadType;
  view: EditorView;
}) {
  const [showReplyForm, setShowReplyForm] = useState(false);

  const rootComment = thread.comments[0];
  const replies = thread.comments.slice(1);
  const replyCount = replies.length;

  const handleReply = (content: string) => {
    insertReply(view, content, thread.to);
    setShowReplyForm(false);
  };

  return (
    <div className="comment-thread">
      {/* Root comment */}
      <CommentItem
        comment={rootComment}
        onClick={() => scrollToPosition(view, rootComment.contentFrom)}
      />

      {/* Reply count and button */}
      <div className="px-3 py-1 flex items-center gap-2">
        {replyCount > 0 && (
          <span className="text-xs text-gray-500">
            {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
          </span>
        )}
        <button
          onClick={() => setShowReplyForm(true)}
          className="text-xs text-blue-600 hover:text-blue-800"
        >
          Reply
        </button>
      </div>

      {/* Replies (indented) */}
      {replies.map((comment, index) => (
        <div key={`reply-${comment.from}-${index}`} className="pl-4">
          <CommentItem
            comment={comment}
            onClick={() => scrollToPosition(view, comment.contentFrom)}
          />
        </div>
      ))}

      {/* Reply form */}
      {showReplyForm && (
        <div className="pl-4">
          <AddCommentForm
            onSubmit={handleReply}
            onCancel={() => setShowReplyForm(false)}
            placeholder="Write a reply..."
            submitLabel="Reply"
          />
        </div>
      )}
    </div>
  );
}
```

### Step 7.4: Run test to verify it passes

Run: `npm test -- src/components/CommentsPanel/CommentsPanel.test.tsx`

Expected: PASS

### Step 7.5: Commit

```bash
jj describe -m "feat(comments-panel): add reply to thread

- Reply button on each thread
- Reply form with 'Write a reply...' placeholder
- Inserts reply adjacent to thread end (preserves thread grouping)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: Wire CommentsPanel to EditorArea

Integrate the Comments Panel into the editor layout.

**Files:**
- Modify: `src/components/Layout/EditorArea.tsx`
- Create: `src/components/Layout/EditorArea.test.tsx`

**Note:** Sidebar width changes from `w-56` (224px) to `w-64` (256px) to accommodate both panels.

### Step 8.1: Add CommentsPanel to EditorArea

Read EditorArea.tsx first, then update:

```typescript
// src/components/Layout/EditorArea.tsx
import { useState, useCallback } from 'react';
import { EditorView } from '@codemirror/view';
import { SyncStatus } from '../SyncStatus/SyncStatus';
import { Editor } from '../Editor/Editor';
import { SourceModeToggle } from '../SourceModeToggle/SourceModeToggle';
import { SuggestionModeToggle } from '../SuggestionModeToggle/SuggestionModeToggle';
import { PresencePanel } from '../PresencePanel/PresencePanel';
import { TableOfContents } from '../TableOfContents';
import { CommentsPanel } from '../CommentsPanel';
import { useNavigation } from '../../contexts/NavigationContext';

export function EditorArea() {
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const [stateVersion, setStateVersion] = useState(0);
  const { metadata, onNavigate } = useNavigation();

  const handleEditorReady = useCallback((view: EditorView) => {
    setEditorView(view);
    setStateVersion(v => v + 1);
  }, []);

  const handleDocChange = useCallback(() => {
    setStateVersion(v => v + 1);
  }, []);

  return (
    <main className="flex-1 flex flex-col min-h-0">
      {/* Header bar */}
      <header className="flex items-center justify-between px-4 py-3 bg-white shadow-sm border-b border-gray-200">
        <h1 className="text-lg font-semibold text-gray-900">Lens Editor</h1>
        <div className="flex items-center gap-4">
          <SuggestionModeToggle view={editorView} />
          <SourceModeToggle editorView={editorView} />
          <PresencePanel />
          <SyncStatus />
        </div>
      </header>
      {/* Editor + Sidebars container */}
      <div className="flex-1 flex min-h-0">
        {/* Editor */}
        <div className="flex-1 px-4 py-6 min-w-0 overflow-auto">
          <Editor
            onEditorReady={handleEditorReady}
            onDocChange={handleDocChange}
            onNavigate={onNavigate}
            metadata={metadata}
          />
        </div>
        {/* Right Sidebars */}
        <aside className="w-64 flex-shrink-0 border-l border-gray-200 bg-white flex flex-col">
          {/* ToC - fixed height */}
          <div className="h-1/3 border-b border-gray-200 overflow-y-auto">
            <TableOfContents view={editorView} stateVersion={stateVersion} />
          </div>
          {/* Comments - remaining height */}
          <div className="flex-1 overflow-y-auto">
            <CommentsPanel view={editorView} stateVersion={stateVersion} />
          </div>
        </aside>
      </div>
    </main>
  );
}
```

### Step 8.2: Write failing test for EditorArea integration

```typescript
// src/components/Layout/EditorArea.test.tsx
/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EditorArea } from './EditorArea';

// Mock the providers that EditorArea needs
vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    metadata: null,
    onNavigate: vi.fn(),
  }),
}));

// Mock Y.js provider hooks to avoid actual connection
vi.mock('@y-sweet/react', () => ({
  useYDoc: () => ({ getText: () => ({ toString: () => '' }) }),
  useYjsProvider: () => ({
    synced: true,
    awareness: { setLocalState: vi.fn(), on: vi.fn(), off: vi.fn() },
    on: vi.fn(),
    off: vi.fn(),
  }),
}));

describe('EditorArea', () => {
  it('renders CommentsPanel in sidebar', () => {
    render(<EditorArea />);

    // CommentsPanel shows "No document open" initially (before editor ready)
    // or "No comments in document" after editor loads
    // Either indicates CommentsPanel is rendered
    const commentsEmpty = screen.queryByText('No comments in document') ||
                          screen.queryByText('No document open');
    expect(commentsEmpty).toBeInTheDocument();
  });

  it('renders TableOfContents in sidebar', () => {
    render(<EditorArea />);

    // ToC shows similar empty state
    const tocEmpty = screen.queryByText('No headings in document') ||
                     screen.queryByText('No document open');
    expect(tocEmpty).toBeInTheDocument();
  });

  it('renders Comments header', () => {
    render(<EditorArea />);

    // Once a document is open, the Comments header should appear
    // This may require waiting for editor to initialize
    // For a basic smoke test, we verify the component mounts without error
    expect(document.querySelector('.comments-panel') ||
           screen.queryByText(/comments/i)).toBeTruthy();
  });
});
```

### Step 8.3: Run test to verify it fails

Run: `npm test -- src/components/Layout/EditorArea.test.tsx`

Expected: FAIL (module not found or test assertions)

### Step 8.4: Implement EditorArea changes

(Use the implementation from Step 8.1 above)

### Step 8.5: Run test to verify it passes

Run: `npm test -- src/components/Layout/EditorArea.test.tsx`

Expected: PASS (3 tests)

### Step 8.6: Test manually in browser

1. Open the editor
2. Add CriticMarkup comments: `{>>test comment<<}`
3. Verify Comments Panel shows the comment
4. Click comment - verify editor scrolls
5. Click "Add Comment" - verify form appears
6. Add a comment - verify it appears in document
7. Click "Reply" - verify reply form appears
8. Add reply - verify thread groups correctly

### Step 8.8: Commit

```bash
jj describe -m "feat(comments-panel): wire to EditorArea layout

- CommentsPanel added below TableOfContents in right sidebar
- ToC takes 1/3 height, Comments takes remaining
- Both receive view and stateVersion props
- Sidebar width increased to w-64 for better panel fit
- Added EditorArea smoke tests

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: Integration Tests

Write integration tests for the full Comments Panel workflow.

**Files:**
- Create: `src/components/CommentsPanel/CommentsPanel.integration.test.tsx`

### Step 9.1: Write integration tests

```typescript
// src/components/CommentsPanel/CommentsPanel.integration.test.tsx
/**
 * Integration tests for Comments Panel.
 * @vitest-environment happy-dom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createCriticMarkupEditor } from '../../test/codemirror-helpers';
import { CommentsPanel } from './CommentsPanel';

describe('Comments Panel Integration', () => {
  let editorCleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup();
    if (editorCleanup) editorCleanup();
  });

  describe('Full Workflow', () => {
    it('add comment → appears in panel → click → navigates', async () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello world this is a test document',
        10
      );
      editorCleanup = c;

      const { rerender } = render(<CommentsPanel view={view} />);

      // Add a comment
      fireEvent.click(screen.getByRole('button', { name: /add comment/i }));
      const textarea = screen.getByPlaceholderText(/add a comment/i);
      await userEvent.type(textarea, 'This is my note');
      fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

      // Re-render to pick up state change
      rerender(<CommentsPanel view={view} stateVersion={1} />);

      // Comment should appear in panel
      expect(screen.getByText('This is my note')).toBeInTheDocument();

      // Move cursor elsewhere
      view.dispatch({ selection: { anchor: 0 } });

      // Click comment to navigate
      fireEvent.click(screen.getByText('This is my note'));

      // Cursor should be at comment position
      expect(view.state.selection.main.head).toBeGreaterThan(5);
    });

    it('thread reply creates adjacent comment (same thread)', async () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        '{>>first<<} some text',
        0
      );
      editorCleanup = c;

      render(<CommentsPanel view={view} />);

      // Reply to thread
      fireEvent.click(screen.getByRole('button', { name: /reply/i }));
      const textarea = screen.getByPlaceholderText(/reply/i);
      await userEvent.type(textarea, 'my reply');
      fireEvent.click(screen.getByRole('button', { name: /^reply$/i }));

      // Check document - reply should be adjacent (part of same thread)
      const doc = view.state.doc.toString();
      expect(doc).toMatch(/\{>>first<<\}\{>>.*my reply<<\}/);
    });

    it('multiple threads display separately', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        '{>>thread one<<} gap {>>thread two<<}',
        0
      );
      editorCleanup = c;

      render(<CommentsPanel view={view} />);

      expect(screen.getByText('thread one')).toBeInTheDocument();
      expect(screen.getByText('thread two')).toBeInTheDocument();

      // Should have 2 separate reply buttons (one per thread)
      const replyButtons = screen.getAllByRole('button', { name: /reply/i });
      expect(replyButtons).toHaveLength(2);
    });
  });

  describe('Edge Cases', () => {
    it('handles empty document', () => {
      const { view, cleanup: c } = createCriticMarkupEditor('', 0);
      editorCleanup = c;

      render(<CommentsPanel view={view} />);

      expect(screen.getByText('No comments in document')).toBeInTheDocument();
    });

    it('handles document with only non-comment markup', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        '{++added text++} {--deleted--}',
        0
      );
      editorCleanup = c;

      render(<CommentsPanel view={view} />);

      expect(screen.getByText('No comments in document')).toBeInTheDocument();
    });

    it('handles multiline comments', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        '{>>line one\nline two<<}',
        0
      );
      editorCleanup = c;

      render(<CommentsPanel view={view} />);

      expect(screen.getByText(/line one/)).toBeInTheDocument();
    });

    it('handles comment with metadata but no content', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        '{>>{"author":"alice"}@@<<}',
        0
      );
      editorCleanup = c;

      render(<CommentsPanel view={view} />);

      // Should show author even with empty content
      expect(screen.getByText('alice')).toBeInTheDocument();
    });
  });

  describe('Metadata Display', () => {
    it('shows relative time for recent comments', () => {
      const recentTimestamp = Date.now() - 300000; // 5 minutes ago
      const { view, cleanup: c } = createCriticMarkupEditor(
        `{>>{"timestamp":${recentTimestamp}}@@recent comment<<}`,
        0
      );
      editorCleanup = c;

      render(<CommentsPanel view={view} />);

      expect(screen.getByText(/5m ago/)).toBeInTheDocument();
    });

    it('shows date for old comments', () => {
      const oldTimestamp = Date.now() - 864000000; // 10 days ago
      const { view, cleanup: c } = createCriticMarkupEditor(
        `{>>{"timestamp":${oldTimestamp}}@@old comment<<}`,
        0
      );
      editorCleanup = c;

      render(<CommentsPanel view={view} />);

      // Should show month/day format
      expect(screen.getByText(/Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/)).toBeInTheDocument();
    });
  });

  describe('Keyboard Navigation', () => {
    it('pressing Escape closes add comment form', async () => {
      const { view, cleanup: c } = createCriticMarkupEditor('hello world', 5);
      editorCleanup = c;

      render(<CommentsPanel view={view} />);

      fireEvent.click(screen.getByRole('button', { name: /add comment/i }));
      expect(screen.getByPlaceholderText(/add a comment/i)).toBeInTheDocument();

      fireEvent.keyDown(screen.getByPlaceholderText(/add a comment/i), {
        key: 'Escape',
      });

      expect(screen.queryByPlaceholderText(/add a comment/i)).not.toBeInTheDocument();
    });

    it('pressing Enter in form submits comment', async () => {
      const { view, cleanup: c } = createCriticMarkupEditor('hello world', 5);
      editorCleanup = c;

      render(<CommentsPanel view={view} />);

      fireEvent.click(screen.getByRole('button', { name: /add comment/i }));
      const textarea = screen.getByPlaceholderText(/add a comment/i);
      await userEvent.type(textarea, 'quick comment');
      fireEvent.keyDown(textarea, { key: 'Enter' });

      expect(view.state.doc.toString()).toMatch(/quick comment/);
    });
  });
});
```

### Step 9.2: Run integration tests

Run: `npm test -- src/components/CommentsPanel/CommentsPanel.integration.test.tsx`

Expected: PASS

### Step 9.3: Run all CommentsPanel tests

Run: `npm test -- src/components/CommentsPanel`

Expected: All tests PASS

### Step 9.4: Commit

```bash
jj describe -m "test(comments-panel): add integration tests

- Full workflow: add comment → display → navigate
- Thread reply creates adjacent comment
- Multiple threads display separately
- Edge cases: empty doc, multiline, metadata-only
- Keyboard navigation: Escape closes, Enter submits

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Summary

**Tasks completed:**
1. ✅ useComments hook (read from StateField, parse threads)
2. ✅ CommentsPanel base component (empty states)
3. ✅ Comment metadata display (author, timestamp)
4. ✅ Click-to-navigate (scroll to comment)
5. ✅ Thread visual grouping (root + replies)
6. ✅ Add new comment (form + insert at cursor)
7. ✅ Reply to thread (adjacent insertion)
8. ✅ Wire to EditorArea layout
9. ✅ Integration tests

**Files created/modified:**
- `src/components/CommentsPanel/useComments.ts` (new)
- `src/components/CommentsPanel/useComments.test.ts` (new)
- `src/components/CommentsPanel/CommentsPanel.tsx` (new)
- `src/components/CommentsPanel/CommentsPanel.test.tsx` (new)
- `src/components/CommentsPanel/AddCommentForm.tsx` (new)
- `src/components/CommentsPanel/AddCommentForm.test.tsx` (new)
- `src/components/CommentsPanel/index.ts` (new)
- `src/components/CommentsPanel/CommentsPanel.integration.test.tsx` (new)
- `src/components/Layout/EditorArea.tsx` (modified)
- `src/components/Layout/EditorArea.test.tsx` (new)

**Test coverage:**
- Unit tests for useComments hook (7 tests) - includes re-render behavior test
- Unit tests for CommentsPanel component (~15 tests)
- Unit tests for AddCommentForm (~7 tests)
- EditorArea smoke tests (3 tests)
- Integration tests for full workflow (~12 tests)
- ~44 new test cases total

**Key implementation decisions:**
1. **Edit-on-commit pattern** - Changes write to Y.Text only on Enter/Save, not while typing
2. **Adjacent insertion for replies** - No space between comments = same thread
3. **getCurrentAuthor() for metadata** - Reuses existing author context from criticmarkup.ts (defaults to 'anonymous')
4. **stateVersion prop** - Same pattern as TableOfContents for re-render on doc changes
5. **Split sidebar** - ToC 1/3 height, Comments 2/3 height in right sidebar
6. **No useMemo in useComments** - Parent controls re-renders via stateVersion, avoiding stale closure issues

---

*Plan created: 2026-02-04*
*Updated: 2026-02-04 (code review fixes: C1 stale dependency, I1 re-render test, I4 EditorArea test)*
