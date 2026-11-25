// src/components/Editor/extensions/criticmarkup-context-menu.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { createCriticMarkupEditor, createCriticMarkupEditorWithSelection } from '../../../test/codemirror-helpers';
import { getContextMenuItems } from './criticmarkup-context-menu';
import { acceptChangeAtCursor } from './criticmarkup-commands';

describe('CriticMarkup Context Menu', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    if (cleanup) cleanup();
  });

  it('returns accept/reject items when cursor inside markup', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello {++world++} end',
      10
    );
    cleanup = c;

    const items = getContextMenuItems(view);

    expect(items).toHaveLength(2);
    expect(items[0].label).toBe('Accept Change');
    expect(items[1].label).toBe('Reject Change');
  });

  it('returns empty array when cursor outside markup', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello {++world++} end',
      3
    );
    cleanup = c;

    const items = getContextMenuItems(view);

    expect(items).toHaveLength(0);
  });

  it('accept item executes acceptChangeAtCursor', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello {++world++} end',
      10
    );
    cleanup = c;

    const items = getContextMenuItems(view);
    items[0].action();

    expect(view.state.doc.toString()).toBe('hello world end');
  });

  it('reject item executes rejectChangeAtCursor', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello {++world++} end',
      10
    );
    cleanup = c;

    const items = getContextMenuItems(view);
    items[1].action();

    expect(view.state.doc.toString()).toBe('hello  end');
  });

  describe('atPosition parameter', () => {
    it('returns items when atPosition is inside markup even if cursor is outside', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        3 // cursor outside
      );
      cleanup = c;

      // atPosition=10 is inside the markup
      const items = getContextMenuItems(view, 10);

      expect(items).toHaveLength(2);
    });

    it('returns empty array when atPosition is outside markup', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        10 // cursor inside
      );
      cleanup = c;

      // atPosition=3 is outside the markup
      const items = getContextMenuItems(view, 3);

      expect(items).toHaveLength(0);
    });

    it('action moves cursor to position before accepting', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        3 // cursor outside
      );
      cleanup = c;

      const items = getContextMenuItems(view, 10);
      items[0].action();

      expect(view.state.doc.toString()).toBe('hello world end');
    });
  });

  describe('selections and comments', () => {
    // Two suggestions (a deletion+addition pair, an addition), a highlighted comment with a reply
    const DOC = 'a {--old--}{++new++} b {++x++} c {==seen==}{>>a note<<}{>>a reply<<} d';
    const NOTES = '{==seen==}{>>a note<<}{>>a reply<<}';

    it('offers the suggestions in a selection, a deletion+addition pair as one, and no comments', () => {
      const { view, cleanup: c } = createCriticMarkupEditorWithSelection(DOC, 0, DOC.length);
      cleanup = c;

      const items = getContextMenuItems(view, 1);

      expect(items.map((i) => i.label)).toEqual(['Accept 2 Changes', 'Reject 2 Changes']);
      items[0].action();
      expect(view.state.doc.toString()).toBe(`a new b x c ${NOTES} d`);
    });

    it('rejecting them leaves the comments too', () => {
      const { view, cleanup: c } = createCriticMarkupEditorWithSelection(DOC, 0, DOC.length);
      cleanup = c;

      getContextMenuItems(view, 1)[1].action();

      expect(view.state.doc.toString()).toBe(`a old b  c ${NOTES} d`);
    });

    it('a selection over one suggestion and a comment offers that one change', () => {
      const doc = 'a {++x++} b {>>a note<<} c';
      const { view, cleanup: c } = createCriticMarkupEditorWithSelection(doc, 0, doc.length);
      cleanup = c;

      const items = getContextMenuItems(view, 1);

      expect(items.map((i) => i.label)).toEqual(['Accept 1 Change', 'Reject 1 Change']);
      items[0].action();
      expect(view.state.doc.toString()).toBe('a x b {>>a note<<} c');
    });

    it('nothing to accept or reject in a selection with only comments and highlights', () => {
      const doc = `a ${NOTES} b`;
      const { view, cleanup: c } = createCriticMarkupEditorWithSelection(doc, 0, doc.length);
      cleanup = c;

      expect(getContextMenuItems(view, doc.indexOf('seen') + 1)).toEqual([]);
    });

    it('nothing to accept or reject on a comment, at either edge or inside', () => {
      const doc = 'a {>>a note<<} b';
      const { view, cleanup: c } = createCriticMarkupEditor(doc, 0);
      cleanup = c;

      for (const pos of [2, 6, doc.indexOf(' b')]) {
        expect(getContextMenuItems(view, pos).map((i) => i.label)).not.toContain('Accept Change');
      }
    });

    it('nothing on a badge right after a suggestion, though the click lands in the suggestion', () => {
      const doc = 'a {++x++}{>>a note<<} b';
      const { view, cleanup: c } = createCriticMarkupEditor(doc, 0);
      cleanup = c;
      const badge = view.contentDOM.querySelector('.cm-comment-badge');
      expect(badge).not.toBeNull();

      // posAtCoords can put a right-click on the badge in the hidden ++} before it
      expect(getContextMenuItems(view, doc.indexOf('++}') + 1, badge)).toEqual([]);
      // The suggestion's own text still has them
      expect(getContextMenuItems(view, doc.indexOf('x'))).toHaveLength(2);
    });

    it('nothing on a badge with a selection either', () => {
      const doc = 'a {++x++} b {++y++}{>>a note<<} c';
      const { view, cleanup: c } = createCriticMarkupEditorWithSelection(doc, 0, doc.length);
      cleanup = c;
      const badge = view.contentDOM.querySelector('.cm-comment-badge');

      expect(getContextMenuItems(view, doc.indexOf('{>>'), badge)).toEqual([]);
      expect(getContextMenuItems(view, 1).map((i) => i.label)).toEqual(['Accept 2 Changes', 'Reject 2 Changes']);
    });
  });
});

describe('Resolve Comment', () => {
  const comment = '{>>{"author":"ann","timestamp":1}@@why?<<}';
  const doc = `We {==ship it==}${comment} soon.`;

  it('is offered on commented text, and removes the comment and the highlight', () => {
    const { view, cleanup } = createCriticMarkupEditor(doc, doc.indexOf('ship') + 1);
    const items = getContextMenuItems(view);
    expect(items.map((i) => i.label)).toEqual(['Resolve Comment']);
    items[0].action();
    expect(view.state.doc.toString()).toBe('We ship it soon.');
    cleanup();
  });

  it('accepting the highlight also removes its comment', () => {
    const { view, cleanup } = createCriticMarkupEditor(doc, doc.indexOf('ship') + 1);
    acceptChangeAtCursor(view);
    expect(view.state.doc.toString()).toBe('We ship it soon.');
    cleanup();
  });
});
