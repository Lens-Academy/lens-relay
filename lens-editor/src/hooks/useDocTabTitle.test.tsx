/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import * as Y from 'yjs';
import { NavigationContext } from '../contexts/NavigationContext';

const RELAY_ID = vi.hoisted(() => 'cb696037-0f72-4e93-8717-4e433129d789');
vi.mock('../App', () => ({ RELAY_ID }));

import { useDocTabTitle, docDisplayName } from './useDocTabTitle';

function Probe({ docId }: { docId: string }) {
  useDocTabTitle(docId);
  return null;
}

function renderWith(path: string, uuid: string, type: string) {
  return render(
    <NavigationContext.Provider
      value={{
        metadata: { [path]: { id: uuid, type, version: 0 } } as any,
        folderDocs: new Map([['Lens', new Y.Doc()]]),
        folderNames: ['Lens'],
        errors: new Map(),
        onNavigate: vi.fn(),
        justCreatedRef: { current: false },
      }}
    >
      <Probe docId={`${RELAY_ID}-${uuid}`} />
    </NavigationContext.Provider>
  );
}

describe('useDocTabTitle', () => {
  it('names the tab after a Markdown file', () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    const { unmount } = renderWith('/Lens/Notes/Weekly plan.md', uuid, 'markdown');
    expect(document.title).toBe('Weekly plan - Editor');
    unmount();
    expect(document.title).toBe('Editor');
  });

  it('names the tab after an HTML file, without the extension', () => {
    const uuid = '22222222-2222-4222-8222-222222222222';
    renderWith('/Lens/Pages/Course map.html', uuid, 'file');
    expect(document.title).toBe('Course map - Editor');
  });

  it('strips only a trailing .md or .html', () => {
    expect(docDisplayName('/Lens/a.html.md')).toBe('a.html');
    expect(docDisplayName('/Lens/notes.txt')).toBe('notes.txt');
    expect(docDisplayName(null)).toBe('');
  });
});
