# Read-Only Source Mode During Suggestion Mode

**Date:** 2026-04-03
**Status:** Design

## Problem

When suggestion mode is active, all edits are wrapped in CriticMarkup syntax (`{++added++}`, `{--deleted--}`). If the user switches to source mode, the raw CriticMarkup delimiters are visible and editable. Editing in source mode while suggestion mode is on creates nested CriticMarkup — the suggestion filter wraps changes to already-wrapped markup, producing a mess.

## Solution

Make the editor read-only when both suggestion mode and source mode are active. Show a banner explaining how to make changes.

## Behavior

**Trigger:** Suggestion mode active AND source mode active (regardless of user role).

**Editor state:**
- `EditorView.editable` set to `false`
- `EditorState.readOnly` set to `true`
- User can scroll, select text, and copy, but cannot type or delete

**Banner:** Rendered above the editor content area. Text:

> "Source mode is read-only while suggesting."

With action buttons:
- **"Live Preview"** — switches back to live preview mode (always shown)
- **"Switch to Editing"** — turns off suggestion mode (only shown for edit-role users who can toggle suggestion mode)

**Accept/reject buttons:** Hidden (read-only state means no mutations; the `canAcceptRejectFacet` already handles this for non-edit roles, and for edit-role users the read-only state prevents the transaction from going through anyway).

**Reversal:** Read-only state is removed when either:
- User switches back to live preview (source mode off), OR
- User switches to editing mode (suggestion mode off, edit-role only)

## Implementation

**State tracking:** Add a `sourceModeFacet` to the editor state (currently source mode is only tracked in React local state). This lets the `suggestionModeFilter` and read-only logic check both states from within CodeMirror.

**Read-only enforcement:** Use a new compartment (`suggestionSourceReadOnlyCompartment`) that is reconfigured whenever source mode or suggestion mode changes. When both are active, it provides `EditorView.editable.of(false)` and `EditorState.readOnly.of(true)`. Otherwise it provides empty extensions.

**Banner:** A React component (`SourceSuggestionBanner`) rendered in `EditorArea.tsx`, conditionally shown when both `isSourceMode` and `isSuggestionMode` are true. The banner dispatches `toggleSourceMode(view, false)` for "Live Preview" and `toggleSuggestionMode.of(false)` for "Switch to Editing".

## Scope

- Applies to all roles when suggestion mode + source mode are both active
- No changes to how source mode or suggestion mode work independently
- No changes to the token/auth system
- No new tests for role-based behavior (existing `canAcceptReject` tests cover that)
