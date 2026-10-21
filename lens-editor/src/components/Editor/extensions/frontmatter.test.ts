import { describe, it, expect, afterEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createTestEditor } from '../../../test/codemirror-helpers';
import { frontmatterField, frontmatterPlugin, revealFrontmatterPos } from './frontmatter';

const META = '{"author":"Elias\'s AI","timestamp":1784282820091}';

describe('frontmatter suggestions badge', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => { cleanup?.(); cleanup = null; });

  function badge(view: { contentDOM: HTMLElement }): HTMLElement | null {
    return view.contentDOM.querySelector('.cm-frontmatter-suggestions-badge');
  }

  it('shows the badge on the collapsed bar when frontmatter has a pending edit', () => {
    const content = `---\ntitle: Repro {++${META}@@ Renamed++}\n---\n\nBody text`;
    const { view, cleanup: c } = createTestEditor(content, content.length);
    cleanup = c;

    expect(badge(view)?.textContent).toBe('1 suggested edit');
  });

  it('pluralizes for multiple pending edits', () => {
    const content = `---\ntitle: A {++${META}@@x++}\ntldr: B {++${META}@@y++}\n---\n\nBody`;
    const { view, cleanup: c } = createTestEditor(content, content.length);
    cleanup = c;

    expect(badge(view)?.textContent).toBe('2 suggested edits');
  });

  it('shows no badge when the only pending edit is in the body', () => {
    const content = `---\ntitle: Clean\n---\n\nBody {++${META}@@added++}`;
    const { view, cleanup: c } = createTestEditor(content, content.length);
    cleanup = c;

    expect(view.contentDOM.querySelector('.cm-frontmatter-bar')).not.toBeNull();
    expect(badge(view)).toBeNull();
  });

  it('removes the badge when the edit is resolved', () => {
    const markup = `{++${META}@@ Renamed++}`;
    const content = `---\ntitle: Repro ${markup}\n---\n\nBody`;
    const { view, cleanup: c } = createTestEditor(content, content.length);
    cleanup = c;
    expect(badge(view)).not.toBeNull();

    const from = content.indexOf(markup);
    view.dispatch({ changes: { from, to: from + markup.length, insert: ' Renamed' } });
    expect(badge(view)).toBeNull();
  });
});

describe('revealFrontmatterPos', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => { cleanup?.(); cleanup = null; });

  it('expands collapsed frontmatter when pos is inside it', () => {
    const content = `---\ntitle: Repro {++${META}@@ Renamed++}\n---\n\nBody`;
    const { view, cleanup: c } = createTestEditor(content, 0);
    cleanup = c;
    expect(view.contentDOM.querySelector('.cm-frontmatter-header')).toBeNull();

    revealFrontmatterPos(view, content.indexOf('title:'));
    expect(view.contentDOM.querySelector('.cm-frontmatter-header')).not.toBeNull();
  });

  it('stays collapsed when pos is in the body', () => {
    const content = `---\ntitle: Clean\n---\n\nBody text`;
    const { view, cleanup: c } = createTestEditor(content, 0);
    cleanup = c;

    revealFrontmatterPos(view, content.indexOf('Body'));
    expect(view.contentDOM.querySelector('.cm-frontmatter-header')).toBeNull();
  });
});

describe('expanded frontmatter delimiters', () => {
  // Hidden with a mark, every dash had the same x, and a click on the row (or
  // ArrowDown onto it) landed between them (e2e/live-preview-frontmatter.spec.ts)
  it('hides each --- line as one widget', () => {
    const contents = [
      '---\ntitle: Notes\nstatus: draft\n---\n\nBody', // closing --- under key: value
      '---\ntags:\n  - notes\n---\nBody', // under a YAML list
      '---  \ntitle: Notes\n\n--- \nBody', // trailing spaces
    ];
    for (const content of contents) {
      // The frontmatter extension alone: a closing --- under `key: value` is
      // also a setext heading's underline, which live preview hides too
      const view = new EditorView({
        parent: document.body,
        state: EditorState.create({ doc: content, extensions: [frontmatterField, frontmatterPlugin] }),
      });
      try {
        revealFrontmatterPos(view, 0);
        const lines = view.contentDOM.querySelectorAll('.cm-frontmatter-line');
        for (const line of [lines[0], lines[lines.length - 1]]) {
          const delimiter = line.querySelectorAll('.cm-frontmatter-delimiter');
          expect(delimiter).toHaveLength(1);
          expect(delimiter[0].getAttribute('contenteditable')).toBe('false'); // a widget
          expect(Array.from(delimiter[0].childNodes, (node) => node.nodeType)).toEqual([Node.TEXT_NODE]);
          expect(line.textContent).toBe(delimiter[0].textContent);
        }
      } finally {
        view.destroy();
      }
    }
  });
});
