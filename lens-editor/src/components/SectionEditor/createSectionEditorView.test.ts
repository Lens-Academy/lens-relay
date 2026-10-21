import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import { runScopeHandlers, type EditorView } from '@codemirror/view';
import { createSectionEditorView } from './createSectionEditorView';
import { setCurrentAuthor } from '../Editor/extensions/criticmarkup';
import { getContextMenuItems } from '../Editor/extensions/criticmarkup-context-menu';

const ELIAS = '{"author":"Elias","timestamp":1000}';
// Someone else's suggestions and a comment, as a course editor field holds them
const TEXT = `Hello {++${ELIAS}@@world++} and {--${ELIAS}@@old --}end.{>>${ELIAS}@@Check this<<}`;
const IN_WORLD = TEXT.indexOf('world') + 2;

describe('createSectionEditorView: accepting and rejecting suggestions', () => {
  const views: EditorView[] = [];
  let ytext: Y.Text;

  function sectionEditor(opts: { canAcceptReject?: boolean; suggesting?: boolean } = {}): EditorView {
    ytext = new Y.Doc().getText('contents');
    ytext.insert(0, TEXT);
    const view = createSectionEditorView({
      ytext,
      sectionFrom: 0,
      sectionTo: TEXT.length,
      parent: document.body,
      enableCriticMarkup: true,
      initialSuggestionMode: opts.suggesting,
      canAcceptReject: opts.canAcceptReject,
    });
    views.push(view);
    view.dispatch({ selection: { anchor: IN_WORLD } });
    return view;
  }

  const buttons = (view: EditorView) =>
    view.contentDOM.querySelectorAll('.cm-criticmarkup-accept, .cm-criticmarkup-reject');
  const menuLabels = (view: EditorView) => getContextMenuItems(view, IN_WORLD).map((item) => item.label);

  beforeEach(() => setCurrentAuthor('Mark'));
  afterEach(() => {
    views.splice(0).forEach((view) => view.destroy());
    setCurrentAuthor('anonymous');
  });

  it('gives users who may accept and reject the ✓ ✗ buttons and the right-click items', () => {
    const view = sectionEditor({ canAcceptReject: true });

    expect(buttons(view)).toHaveLength(2);
    expect(menuLabels(view)).toEqual(['Accept Change', 'Reject Change']);
  });

  it('gives a suggest-role user no ✓ ✗ buttons and no right-click Accept or Reject', () => {
    const view = sectionEditor({ canAcceptReject: false });

    expect(buttons(view)).toHaveLength(0);
    expect(menuLabels(view)).toEqual([]);

    // Nor the bulk ✓ ✗ for a selection over several suggestions
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    expect(buttons(view)).toHaveLength(0);
    expect(getContextMenuItems(view)).toEqual([]);
  });

  it('leaves the suggestion alone when a suggest-role user presses Ctrl+Enter or Ctrl+Backspace', () => {
    for (const key of ['Enter', 'Backspace']) {
      const view = sectionEditor({ canAcceptReject: false });
      runScopeHandlers(view, new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true }), 'editor');

      // Accepting would drop its markup, rejecting the whole addition
      expect(ytext.toString()).toContain(`{++${ELIAS}@@`);
    }
  });

  it('offers no accept or reject unless the caller allows it', () => {
    const view = sectionEditor();

    expect(buttons(view)).toHaveLength(0);
    expect(menuLabels(view)).toEqual([]);
  });

  it('still shows a suggest-role user the suggestions and comments, and makes their typing a suggestion', () => {
    const view = sectionEditor({ canAcceptReject: false, suggesting: true });

    expect(view.contentDOM.querySelector('.cm-addition')?.textContent).toBe('world');
    expect(view.contentDOM.querySelector('.cm-deletion')?.textContent).toBe('old ');
    expect(view.contentDOM.querySelector('.cm-comment-badge')).not.toBeNull();

    view.dispatch({ selection: { anchor: 0 } });
    view.dispatch({ changes: { from: 0, insert: 'Oh, ' }, userEvent: 'input.type' });
    expect(ytext.toString()).toMatch(/^\{\+\+\{"author":"Mark"[^}]*\}@@Oh, \+\+\}Hello \{\+\+/);
  });
});
