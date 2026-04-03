import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { criticMarkupExtension } from './criticmarkup';

/**
 * Tests for role-based gating of accept/reject buttons in CriticMarkup.
 *
 * Bug: read-only and suggest users can see and click accept/reject buttons.
 * Expected: only edit-role users should see accept/reject buttons.
 */

function createEditorWithContent(content: string, canAcceptReject: boolean): EditorView {
  const state = EditorState.create({
    doc: content,
    extensions: [criticMarkupExtension({ canAcceptReject })],
  });
  // Headless EditorView (no DOM parent) — sufficient for decoration inspection
  return new EditorView({ state });
}

describe('criticmarkup role gating', () => {
  const docWithSuggestion = 'Hello {++world++} end';

  it('should show accept/reject buttons for edit role (canAcceptReject=true)', () => {
    const view = createEditorWithContent(docWithSuggestion, true);

    // Place cursor inside the CriticMarkup range
    view.dispatch({ selection: { anchor: 10 } }); // inside "world"

    // Check decorations for AcceptRejectWidget
    const container = view.contentDOM;
    const buttons = container.querySelectorAll('.cm-criticmarkup-accept, .cm-criticmarkup-reject');
    expect(buttons.length).toBeGreaterThan(0);

    view.destroy();
  });

  it('should NOT show accept/reject buttons for suggest role (canAcceptReject=false)', () => {
    const view = createEditorWithContent(docWithSuggestion, false);

    // Place cursor inside the CriticMarkup range
    view.dispatch({ selection: { anchor: 10 } });

    const container = view.contentDOM;
    const buttons = container.querySelectorAll('.cm-criticmarkup-accept, .cm-criticmarkup-reject');
    expect(buttons.length).toBe(0);

    view.destroy();
  });
});
