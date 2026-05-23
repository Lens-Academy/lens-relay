// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { EditorView } from 'codemirror';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { HtmlSourceEditor } from './HtmlSourceEditor';

describe('HtmlSourceEditor', () => {
  afterEach(() => cleanup());

  it('mounts a CodeMirror editor seeded from existing Y.Text content', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<h1>Hi</h1>');
    const awareness = new Awareness(doc);

    const { container } = render(
      <HtmlSourceEditor ytext={ytext} awareness={awareness} />
    );

    expect(container.querySelector('.cm-editor')).not.toBeNull();
    expect(container.querySelector('.cm-content')?.textContent).toContain('<h1>Hi</h1>');
  });

  it('renders highlight decorations for each range', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>click here</p><p>click here</p>');
    const awareness = new Awareness(doc);

    const { container } = render(
      <HtmlSourceEditor
        ytext={ytext}
        awareness={awareness}
        highlightRanges={[{ from: 3, to: 13 }, { from: 20, to: 30 }]}
      />,
    );

    expect(container.querySelectorAll('.cm-lens-candidate').length).toBeGreaterThanOrEqual(2);
  });

  it('updates highlight decorations without recreating the editor', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>click here</p><p>click here</p>');
    const awareness = new Awareness(doc);

    const { container, rerender } = render(
      <HtmlSourceEditor ytext={ytext} awareness={awareness} highlightRanges={[{ from: 3, to: 13 }]} />,
    );
    const editor = container.querySelector('.cm-editor');
    expect(container.querySelectorAll('.cm-lens-candidate')).toHaveLength(1);

    rerender(
      <HtmlSourceEditor
        ytext={ytext}
        awareness={awareness}
        highlightRanges={[{ from: 3, to: 13 }, { from: 20, to: 30 }]}
      />,
    );

    expect(container.querySelector('.cm-editor')).toBe(editor);
    expect(container.querySelectorAll('.cm-lens-candidate').length).toBeGreaterThanOrEqual(2);
  });

  it('clears highlight decorations when ranges are removed', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>click here</p>');
    const awareness = new Awareness(doc);

    const { container, rerender } = render(
      <HtmlSourceEditor ytext={ytext} awareness={awareness} highlightRanges={[{ from: 3, to: 13 }]} />,
    );
    expect(container.querySelectorAll('.cm-lens-candidate')).toHaveLength(1);

    rerender(<HtmlSourceEditor ytext={ytext} awareness={awareness} />);

    expect(container.querySelectorAll('.cm-lens-candidate')).toHaveLength(0);
  });

  it('calls onClickAtPosition with the doc offset when armed', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>abc</p>');
    const awareness = new Awareness(doc);
    const onClick = vi.fn();
    const posAtCoords = vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue(3);

    try {
      const { container } = render(
        <HtmlSourceEditor
          ytext={ytext}
          awareness={awareness}
          onClickAtPosition={onClick}
        />,
      );
      const editor = container.querySelector('.cm-content') as HTMLElement;

      editor.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 100, clientY: 50 }));

      expect(onClick).toHaveBeenCalledWith(3);
    } finally {
      posAtCoords.mockRestore();
    }
  });
});
