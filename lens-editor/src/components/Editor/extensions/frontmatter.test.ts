import { describe, it, expect, afterEach } from 'vitest';
import type { EditorView } from '@codemirror/view';
import { createTestEditor, moveCursor } from '../../../test/codemirror-helpers';
import { revealFrontmatterPos, setFrontmatterCollapsed } from './frontmatter';

const META = '{"author":"Elias\'s AI","timestamp":1784282820091}';
const HIDDEN_PREF = 'lens-properties-hidden';

function hideProperties(view: EditorView) {
  view.dispatch({ effects: setFrontmatterCollapsed.of(true) });
}

describe('frontmatter as page properties', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => { cleanup?.(); cleanup = null; localStorage.removeItem(HIDDEN_PREF); });

  function editor(content: string, cursor = content.length) {
    const { view, cleanup: c } = createTestEditor(content, cursor);
    cleanup = c;
    return view;
  }

  const rows = (view: EditorView) => Array.from(view.contentDOM.querySelectorAll('.cm-frontmatter-row'));

  it('shows a row per key, with an icon, the key as label and the value', () => {
    const view = editor('---\ntitle: Notes\nstatus: Draft\n---\n\nBody');

    expect(view.contentDOM.querySelector('.cm-frontmatter-bar')).toBeNull();
    expect(rows(view).map((row) => row.textContent)).toEqual(['title: Notes', 'status: Draft']);
    expect(Array.from(view.contentDOM.querySelectorAll('.cm-frontmatter-key')).map((k) => k.textContent))
      .toEqual(['title', 'status']);
    expect(Array.from(view.contentDOM.querySelectorAll('.cm-frontmatter-icon')).map((i) => (i as HTMLElement).dataset.kind))
      .toEqual(['title', 'status']);
    // The closing --- is the divider under the rows
    expect(view.contentDOM.querySelectorAll('.cm-frontmatter-close')).toHaveLength(1);
  });

  it('picks the icon from the kind of value', () => {
    const view = editor('---\ndue: 2026-10-30\ncount: 12\ndone: true\nsource: https://lensacademy.org\nnotes: Plain\n---\n\nBody');

    expect(Array.from(view.contentDOM.querySelectorAll('.cm-frontmatter-icon')).map((i) => (i as HTMLElement).dataset.kind))
      .toEqual(['date', 'number', 'checkbox', 'url', 'text']);
  });

  it('hides ": " and quotes except on the row with the cursor', () => {
    const content = '---\ntitle: "Notes: Q4"\nstatus: Draft\n---\n\nBody';
    const view = editor(content);
    const hidden = () => Array.from(view.contentDOM.querySelectorAll('.cm-frontmatter-hidden')).map((h) => h.textContent);

    expect(hidden()).toEqual([': ', '"', '"', ': ']);

    moveCursor(view, content.indexOf('Notes'));
    expect(hidden()).toEqual([': ']);
    expect(view.contentDOM.querySelector('.cm-frontmatter-colon')?.textContent).toBe(': ');
  });

  it('draws a list under a key as pills, and says Empty for a key without a value', () => {
    const view = editor('---\ntags:\n  - ai\n  - safety\nslug:\n---\n\nBody');

    expect(Array.from(view.contentDOM.querySelectorAll('.cm-frontmatter-pill')).map((p) => p.textContent))
      .toEqual(['ai', 'safety']);
    expect(view.contentDOM.querySelectorAll('.cm-frontmatter-empty')).toHaveLength(1);
    expect(view.contentDOM.querySelector('.cm-frontmatter-icon')?.getAttribute('data-kind')).toBe('list');
  });

  it('leaves YAML that looks like markdown unstyled: no bullets, no heading', () => {
    // "  - ai" parses as a list item, and the last key over --- as a heading
    const view = editor('---\ntags:\n  - ai\nsummary: one line\n---\n\n- A real bullet');

    expect(view.contentDOM.querySelectorAll('.cm-bullet')).toHaveLength(1);
    expect(view.contentDOM.querySelector('.cm-frontmatter-line [class*="cm-heading"]')).toBeNull();
  });

  it('leaves the icon line out of the rows: it is the page icon above the title', () => {
    const view = editor('---\nicon: 📚\ntitle: Notes\n---\n\nBody');

    expect(rows(view).map((row) => row.textContent)).toEqual(['title: Notes']);
    expect(view.contentDOM.textContent).not.toContain('icon');
    expect(view.dom.classList.contains('cm-has-properties')).toBe(true);
  });

  it('shows nothing when the only property is the page icon', () => {
    const view = editor('---\nicon: 📚\n---\n\nBody');

    expect(view.contentDOM.querySelector('.cm-frontmatter-line')).toBeNull();
    expect(view.contentDOM.querySelector('.cm-frontmatter-bar')).toBeNull();
    expect(view.contentDOM.textContent).toBe('Body');
    expect(view.dom.classList.contains('cm-has-properties')).toBe(false);
  });

  it('keeps an icon line with a suggestion in it, so it can be reviewed', () => {
    const view = editor(`---\nicon: {++${META}@@📚++}\n---\n\nBody`);

    expect(rows(view)).toHaveLength(1);
  });

  it('"Hide properties" hides them as "N properties" for this browser, and the row shows them again', () => {
    const content = '---\nicon: 📚\ntitle: Notes\nstatus: Draft\n---\n\nBody';
    const view = editor(content);

    const hide = view.contentDOM.querySelector('.cm-frontmatter-hide') as HTMLElement;
    hide.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    const bar = view.contentDOM.querySelector('.cm-frontmatter-bar') as HTMLElement;
    expect(bar.textContent).toBe('2 properties');
    expect(rows(view)).toHaveLength(0);
    expect(localStorage.getItem(HIDDEN_PREF)).toBe('1');

    // A page opened later starts with them hidden
    const { view: next, cleanup: c } = createTestEditor(content, content.length);
    expect(next.contentDOM.querySelector('.cm-frontmatter-bar')).not.toBeNull();
    c();

    bar.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(rows(view)).toHaveLength(2);
    expect(localStorage.getItem(HIDDEN_PREF)).toBe('0');
    expect(view.state.doc.toString()).toBe(content);
  });
});

describe('frontmatter suggestions badge', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => { cleanup?.(); cleanup = null; });

  function badge(view: { contentDOM: HTMLElement }): HTMLElement | null {
    return view.contentDOM.querySelector('.cm-frontmatter-suggestions-badge');
  }

  function hiddenEditor(content: string) {
    const { view, cleanup: c } = createTestEditor(content, content.length);
    cleanup = c;
    hideProperties(view);
    return view;
  }

  it('shows the badge on the hidden properties when frontmatter has a pending edit', () => {
    const view = hiddenEditor(`---\ntitle: Repro {++${META}@@ Renamed++}\n---\n\nBody text`);

    expect(badge(view)?.textContent).toBe('1 suggested edit');
  });

  it('pluralizes for multiple pending edits', () => {
    const view = hiddenEditor(`---\ntitle: A {++${META}@@x++}\ntldr: B {++${META}@@y++}\n---\n\nBody`);

    expect(badge(view)?.textContent).toBe('2 suggested edits');
  });

  it('shows no badge when the only pending edit is in the body', () => {
    const view = hiddenEditor(`---\ntitle: Clean\n---\n\nBody {++${META}@@added++}`);

    expect(view.contentDOM.querySelector('.cm-frontmatter-bar')).not.toBeNull();
    expect(badge(view)).toBeNull();
  });

  it('removes the badge when the edit is resolved', () => {
    const markup = `{++${META}@@ Renamed++}`;
    const content = `---\ntitle: Repro ${markup}\n---\n\nBody`;
    const view = hiddenEditor(content);
    expect(badge(view)).not.toBeNull();

    const from = content.indexOf(markup);
    view.dispatch({ changes: { from, to: from + markup.length, insert: ' Renamed' } });
    expect(badge(view)).toBeNull();
  });
});

describe('revealFrontmatterPos', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => { cleanup?.(); cleanup = null; });

  function hiddenEditor(content: string) {
    const { view, cleanup: c } = createTestEditor(content, 0);
    cleanup = c;
    hideProperties(view);
    return view;
  }

  it('shows hidden properties when pos is inside them', () => {
    const content = `---\ntitle: Repro {++${META}@@ Renamed++}\n---\n\nBody`;
    const view = hiddenEditor(content);
    expect(view.contentDOM.querySelector('.cm-frontmatter-row')).toBeNull();

    revealFrontmatterPos(view, content.indexOf('title:'));
    expect(view.contentDOM.querySelector('.cm-frontmatter-bar')).toBeNull();
    expect(view.contentDOM.querySelector('.cm-frontmatter-row')).not.toBeNull();
  });

  it('keeps them hidden when pos is in the body', () => {
    const content = `---\ntitle: Clean\n---\n\nBody text`;
    const view = hiddenEditor(content);

    revealFrontmatterPos(view, content.indexOf('Body'));
    expect(view.contentDOM.querySelector('.cm-frontmatter-bar')).not.toBeNull();
  });
});
