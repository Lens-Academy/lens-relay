import { afterEach, describe, expect, it } from 'vitest';
import { StateEffect } from '@codemirror/state';
import { createTestEditor } from '../../test/codemirror-helpers';
import { revealFrontmatterPos } from '../Editor/extensions/frontmatter';
import { panelHostField, setPanelHost } from './panelHost';

describe('Concepts panel host widget', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => { cleanup?.(); cleanup = null; });

  function editorWithPanel(content: string) {
    const { view, cleanup: c } = createTestEditor(content, content.length);
    cleanup = c;
    const host = document.createElement('div');
    view.dispatch({ effects: StateEffect.appendConfig.of(panelHostField) });
    view.dispatch({ effects: setPanelHost.of(host) });
    return { view, host };
  }

  const before = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  const content = '---\ntitle: X\ntldr: Y\n---\n\nBody text';

  it('sits above the collapsed frontmatter bar', () => {
    const { view, host } = editorWithPanel(content);
    const bar = view.contentDOM.querySelector('.cm-frontmatter-bar')!;
    expect(view.contentDOM.contains(host)).toBe(true);
    expect(before(host, bar)).toBe(true);
  });

  it('sits above the expanded frontmatter header, not between it and the fields', () => {
    const { view, host } = editorWithPanel(content);
    revealFrontmatterPos(view, content.indexOf('title:'));
    const header = view.contentDOM.querySelector('.cm-frontmatter-header')!;
    expect(header).not.toBeNull();
    expect(before(host, header)).toBe(true);
  });

  it('goes away when the host is cleared', () => {
    const { view, host } = editorWithPanel(content);
    view.dispatch({ effects: setPanelHost.of(null) });
    expect(view.contentDOM.contains(host)).toBe(false);
  });
});
