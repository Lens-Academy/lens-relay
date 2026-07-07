import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { MobileEditToolbar } from './MobileEditToolbar';

let view: EditorView | null = null;
let viewParent: HTMLElement | null = null;

function makeView(): EditorView {
  viewParent = document.createElement('div');
  document.body.appendChild(viewParent);
  view = new EditorView({
    state: EditorState.create({ doc: 'hello' }),
    parent: viewParent,
  });
  return view;
}

afterEach(() => {
  cleanup();
  view?.destroy();
  view = null;
  viewParent?.remove();
  viewParent = null;
});

describe('MobileEditToolbar', () => {
  it('puts add comment first in the type bar', () => {
    render(<MobileEditToolbar view={makeView()} onAddComment={vi.fn()} />);

    const toolbar = document.getElementById('mobile-edit-toolbar');
    expect(toolbar).not.toBeNull();
    const buttons = within(toolbar!).getAllByRole('button');

    expect(buttons[0]).toBe(screen.getByRole('button', { name: 'Add comment' }));
  });
});
