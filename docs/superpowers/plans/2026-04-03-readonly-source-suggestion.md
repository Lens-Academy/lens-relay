# Read-Only Source Mode in Suggestion Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the editor read-only when both source mode and suggestion mode are active, with a banner guiding the user to switch modes.

**Architecture:** Lift `isSourceMode` state from `SourceModeToggle` into `EditorArea` (which already owns the editor view). Read `isSuggestionMode` from the editor's `suggestionModeField`. When both are true, reconfigure a new `sourceReadOnlyCompartment` to inject `EditorView.editable.of(false)` + `EditorState.readOnly.of(true)`, and render a banner above the editor with buttons to switch to live preview or editing mode.

**Tech Stack:** React, CodeMirror 6 (Compartments, Facets), TypeScript

**Spec:** `docs/superpowers/specs/2026-04-03-readonly-source-in-suggestion-mode.md`

---

### Task 1: Lift source mode state into EditorArea

Currently `isSourceMode` lives in `SourceModeToggle` as local state. `EditorArea` needs it to render the banner and control read-only. Lift it up.

**Files:**
- Modify: `lens-editor/src/components/Layout/EditorArea.tsx`
- Modify: `lens-editor/src/components/SourceModeToggle/SourceModeToggle.tsx`

- [ ] **Step 1: Add `isSourceMode` state and callback to EditorArea**

In `EditorArea.tsx`, add state after the existing `synced` state (line 43):

```typescript
const [isSourceMode, setIsSourceMode] = useState(false);
```

- [ ] **Step 2: Update SourceModeToggle to accept controlled state**

In `SourceModeToggle.tsx`, change the interface and component to accept external state:

```typescript
interface SourceModeToggleProps {
  editorView: EditorView | null;
  isSourceMode: boolean;
  onSourceModeChange: (sourceMode: boolean) => void;
}

export function SourceModeToggle({ editorView, isSourceMode, onSourceModeChange }: SourceModeToggleProps) {
  const handleChange = (value: SegmentedValue) => {
    if (!editorView) return;
    const newSourceMode = value === 'left';
    onSourceModeChange(newSourceMode);
    toggleSourceMode(editorView, newSourceMode);
  };

  return (
    <SegmentedToggle
      leftLabel={<SourceIcon />}
      rightLabel={<PreviewIcon />}
      leftTitle="Source Mode"
      rightTitle="Live Preview"
      value={isSourceMode ? 'left' : 'right'}
      onChange={handleChange}
      disabled={!editorView}
      ariaLabel="Toggle between source and preview mode"
    />
  );
}
```

Remove the `useState` from inside the component — the state now comes from props.

- [ ] **Step 3: Pass state to SourceModeToggle in EditorArea**

In `EditorArea.tsx`, update both places where `<SourceModeToggle>` is rendered (lines 169 and 177):

```tsx
<SourceModeToggle editorView={editorView} isSourceMode={isSourceMode} onSourceModeChange={setIsSourceMode} />
```

- [ ] **Step 4: Build to verify compilation**

Run: `cd lens-editor && npx tsc --noEmit`

Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
jj describe -m "refactor: lift source mode state from SourceModeToggle into EditorArea"
jj new
```

---

### Task 2: Track suggestion mode in EditorArea

`EditorArea` needs to know when suggestion mode is active. Read it from the editor's `suggestionModeField` state field, updating on every state change.

**Files:**
- Modify: `lens-editor/src/components/Layout/EditorArea.tsx`

- [ ] **Step 1: Add suggestion mode tracking**

In `EditorArea.tsx`, add after the `isSourceMode` state:

```typescript
const [isSuggestionMode, setIsSuggestionMode] = useState(false);
```

Add an effect that listens to editor state changes (after the existing `handleEditorReady` callback):

```typescript
// Track suggestion mode from editor state
useEffect(() => {
  if (!editorView) return;
  // Read initial value
  setIsSuggestionMode(editorView.state.field(suggestionModeField));
  // Listen for changes via updateListener
  const listener = EditorView.updateListener.of((update) => {
    if (update.state.field(suggestionModeField) !== update.startState.field(suggestionModeField)) {
      setIsSuggestionMode(update.state.field(suggestionModeField));
    }
  });
  editorView.dispatch({ effects: StateEffect.appendConfig.of(listener) });
}, [editorView]);
```

Add imports at the top:

```typescript
import { StateEffect } from '@codemirror/state';
import { suggestionModeField } from '../Editor/extensions/criticmarkup';
```

(`suggestionModeField` is already imported at line 4 — verify, and add `StateEffect` to the `@codemirror/state` imports if not present.)

- [ ] **Step 2: Build to verify compilation**

Run: `cd lens-editor && npx tsc --noEmit`

Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
jj describe -m "feat: track suggestion mode state in EditorArea"
jj new
```

---

### Task 3: Add read-only compartment for source+suggestion mode

When both modes are active, inject read-only extensions via a compartment.

**Files:**
- Modify: `lens-editor/src/components/Editor/extensions/livePreview.ts`
- Modify: `lens-editor/src/components/Layout/EditorArea.tsx`

- [ ] **Step 1: Create and export the compartment**

In `livePreview.ts`, add after the existing `livePreviewCompartment` definition (line 656):

```typescript
/**
 * Compartment for making editor read-only when source mode + suggestion mode are both active.
 * Reconfigured from EditorArea when either mode changes.
 */
export const sourceReadOnlyCompartment = new Compartment();
```

- [ ] **Step 2: Include the compartment in the editor's initial extensions**

In `Editor.tsx`, import the compartment:

```typescript
import { livePreviewCompartment, toggleSourceMode, sourceReadOnlyCompartment } from './extensions/livePreview';
```

In the `useEffect` that creates the editor state (find where extensions are assembled), add the compartment with an empty initial value:

```typescript
sourceReadOnlyCompartment.of([]),
```

Add it near the existing `livePreviewCompartment.of(...)` line.

- [ ] **Step 3: Reconfigure the compartment from EditorArea**

In `EditorArea.tsx`, import the compartment:

```typescript
import { toggleSourceMode, sourceReadOnlyCompartment } from '../Editor/extensions/livePreview';
```

Add an effect that reconfigures the compartment whenever `isSourceMode` or `isSuggestionMode` changes:

```typescript
// Make editor read-only when both source mode and suggestion mode are active
useEffect(() => {
  if (!editorView) return;
  const shouldBeReadOnly = isSourceMode && isSuggestionMode;
  editorView.dispatch({
    effects: sourceReadOnlyCompartment.reconfigure(
      shouldBeReadOnly
        ? [EditorView.editable.of(false), EditorState.readOnly.of(true)]
        : []
    ),
  });
}, [editorView, isSourceMode, isSuggestionMode]);
```

Add `EditorState` to imports:

```typescript
import { EditorState } from '@codemirror/state';
```

(Or add to the existing `@codemirror/state` import.)

- [ ] **Step 4: Build to verify compilation**

Run: `cd lens-editor && npx tsc --noEmit`

Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
jj describe -m "feat: make editor read-only when source mode + suggestion mode are both active"
jj new
```

---

### Task 4: Add the banner component

Show a banner above the editor when both modes are active, with buttons to switch to live preview or editing.

**Files:**
- Create: `lens-editor/src/components/SourceSuggestionBanner/SourceSuggestionBanner.tsx`
- Modify: `lens-editor/src/components/Layout/EditorArea.tsx`

- [ ] **Step 1: Create the banner component**

Create `lens-editor/src/components/SourceSuggestionBanner/SourceSuggestionBanner.tsx`:

```typescript
import { useAuth } from '../../contexts/AuthContext';

interface SourceSuggestionBannerProps {
  onSwitchToPreview: () => void;
  onSwitchToEditing: () => void;
}

/**
 * Banner shown when source mode and suggestion mode are both active.
 * The editor is read-only in this state to prevent nested CriticMarkup.
 */
export function SourceSuggestionBanner({ onSwitchToPreview, onSwitchToEditing }: SourceSuggestionBannerProps) {
  const { canEdit } = useAuth();

  return (
    <div className="mx-auto max-w-[700px] w-full px-6">
      <div className="flex items-center gap-3 px-4 py-2.5 bg-amber-50 border border-amber-200 rounded-md text-sm text-amber-800">
        <span className="flex-1">Source mode is read-only while suggesting.</span>
        <button
          onClick={onSwitchToPreview}
          className="px-3 py-1 rounded bg-amber-100 hover:bg-amber-200 font-medium transition-colors cursor-pointer"
        >
          Live Preview
        </button>
        {canEdit && (
          <button
            onClick={onSwitchToEditing}
            className="px-3 py-1 rounded bg-amber-100 hover:bg-amber-200 font-medium transition-colors cursor-pointer"
          >
            Switch to Editing
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Render the banner in EditorArea**

In `EditorArea.tsx`, import the banner:

```typescript
import { SourceSuggestionBanner } from '../SourceSuggestionBanner/SourceSuggestionBanner';
```

Import `toggleSuggestionMode` from criticmarkup:

```typescript
import { suggestionModeField, toggleSuggestionMode } from '../Editor/extensions/criticmarkup';
```

Add handler callbacks (after the existing callbacks):

```typescript
const handleSwitchToPreview = useCallback(() => {
  if (!editorView) return;
  setIsSourceMode(false);
  toggleSourceMode(editorView, false);
}, [editorView]);

const handleSwitchToEditing = useCallback(() => {
  if (!editorView) return;
  editorView.dispatch({ effects: toggleSuggestionMode.of(false) });
}, [editorView]);
```

Render the banner just before the `<Editor>` component (inside the editor column div, after the divider on line 206, before the `<div className="flex-1 min-h-0">` on line 208):

```tsx
{isSourceMode && isSuggestionMode && (
  <SourceSuggestionBanner
    onSwitchToPreview={handleSwitchToPreview}
    onSwitchToEditing={handleSwitchToEditing}
  />
)}
```

- [ ] **Step 3: Build to verify compilation**

Run: `cd lens-editor && npx tsc --noEmit`

Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
jj describe -m "feat: add banner for read-only source mode during suggestion mode"
jj new
```

---

### Task 5: Unit test for SourceSuggestionBanner

**Files:**
- Create: `lens-editor/src/components/SourceSuggestionBanner/SourceSuggestionBanner.test.tsx`

- [ ] **Step 1: Write the test**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SourceSuggestionBanner } from './SourceSuggestionBanner';
import { AuthProvider } from '../../contexts/AuthContext';

function renderBanner(role: 'edit' | 'suggest' | 'view', handlers = { onSwitchToPreview: vi.fn(), onSwitchToEditing: vi.fn() }) {
  return render(
    <AuthProvider role={role} folderUuid={null} isAllFolders={true}>
      <SourceSuggestionBanner {...handlers} />
    </AuthProvider>
  );
}

describe('SourceSuggestionBanner', () => {
  it('shows Live Preview button for all roles', () => {
    renderBanner('suggest');
    expect(screen.getByText('Live Preview')).toBeInTheDocument();
  });

  it('shows Switch to Editing button for edit role', () => {
    renderBanner('edit');
    expect(screen.getByText('Switch to Editing')).toBeInTheDocument();
  });

  it('does NOT show Switch to Editing button for suggest role', () => {
    renderBanner('suggest');
    expect(screen.queryByText('Switch to Editing')).not.toBeInTheDocument();
  });

  it('calls onSwitchToPreview when Live Preview clicked', async () => {
    const handlers = { onSwitchToPreview: vi.fn(), onSwitchToEditing: vi.fn() };
    renderBanner('edit', handlers);
    await userEvent.click(screen.getByText('Live Preview'));
    expect(handlers.onSwitchToPreview).toHaveBeenCalledOnce();
  });

  it('calls onSwitchToEditing when Switch to Editing clicked', async () => {
    const handlers = { onSwitchToPreview: vi.fn(), onSwitchToEditing: vi.fn() };
    renderBanner('edit', handlers);
    await userEvent.click(screen.getByText('Switch to Editing'));
    expect(handlers.onSwitchToEditing).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lens-editor && npx vitest run src/components/SourceSuggestionBanner/SourceSuggestionBanner.test.tsx`

Expected: FAIL — component doesn't exist yet (or tests fail against the implementation if running after Task 4).

Note: If running after Task 4, all tests should pass. If running before Task 4, use the TDD flow: write test first, verify fail, then implement in Task 4.

- [ ] **Step 3: Verify tests pass after Task 4 implementation**

Run: `cd lens-editor && npx vitest run src/components/SourceSuggestionBanner/SourceSuggestionBanner.test.tsx`

Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
jj describe -m "test: add unit tests for SourceSuggestionBanner"
jj new
```

---

### Task 6: Manual testing with Chrome DevTools MCP

- [ ] **Step 1: Restart Vite**

```bash
lsof -ti:5173 | xargs kill; sleep 1; cd lens-editor && VITE_LOCAL_RELAY=true npm run dev
```

- [ ] **Step 2: Open with an edit + all-folders token**

Navigate to the editor with an edit token. Switch to suggestion mode, then switch to source mode.

Verify:
- Editor becomes read-only (cannot type)
- Banner appears: "Source mode is read-only while suggesting." with "Live Preview" and "Switch to Editing" buttons
- Clicking "Live Preview" switches back to preview mode, editor becomes editable again
- Clicking "Switch to Editing" turns off suggestion mode, editor becomes editable in source mode

- [ ] **Step 3: Open with a suggest + folder 1 token**

Navigate with a suggest token. The editor is already in suggestion mode.

Switch to source mode. Verify:
- Editor becomes read-only
- Banner appears with only "Live Preview" button (no "Switch to Editing" — suggest users can't toggle suggestion mode)
- Clicking "Live Preview" restores editability

- [ ] **Step 4: Open with a view token**

Switch to source mode. Verify:
- Editor is already read-only (view role)
- Banner does NOT appear (the read-only state is from the view role, not from source+suggestion)
