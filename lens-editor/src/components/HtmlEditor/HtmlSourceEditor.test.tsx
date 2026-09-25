// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
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
});
