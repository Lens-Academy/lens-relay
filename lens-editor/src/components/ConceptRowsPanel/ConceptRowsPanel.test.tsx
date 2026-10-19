import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as Y from 'yjs';
import { NavigationContext } from '../../contexts/NavigationContext';
import { DisplayNameProvider } from '../../contexts/DisplayNameContext';
import type { FolderMetadata } from '../../hooks/useFolderMetadata';
import { __embedDocsTesting } from '../../lib/embed-docs';
import { RELAY_ID } from '../../App';
import { ConceptRowsPanel } from './ConceptRowsPanel';

vi.mock('../../hooks/useDocConnection', () => ({
  connectDoc: vi.fn(),
  teardownProvider: vi.fn(),
}));

afterEach(() => __embedDocsTesting.reset());

const md = (id: string) => ({ id, type: 'markdown' as const, version: 0 });
const metadata: FolderMetadata = {
  '/Lens Edu/articles/a.md': md('art'),
  '/Lens Edu/articles/other.md': md('other'),
  '/Lens Edu/Lenses/Lens One.md': md('l1'),
  '/Lens Edu/Lenses/Lens Two.md': md('l2'),
  '/Lens Edu/Concepts/Shared.md': md('cs'),
  '/Lens Edu/Concepts/Only lens.md': md('co'),
};

const SHARED = '## Relationships\n### [[../articles/a]]\nArticle note.\n### [[../Lenses/Lens One]]\nLens one note.\n';
const ONLY_LENS = '## Relationships\n### [[../Lenses/Lens Two]]\nLens two note.\n';

function renderPanel(texts: Record<string, string>) {
  const folder = new Y.Doc();
  const backlinks = folder.getMap<string[]>('backlinks_v0');
  backlinks.set('art', ['l1', 'l2', 'cs']);
  backlinks.set('l1', ['cs']);
  backlinks.set('l2', ['co']);
  __embedDocsTesting.setReader(async (id) => texts[id.slice(RELAY_ID.length + 1)] ?? '');
  return render(
    <NavigationContext.Provider value={{
      metadata,
      folderDocs: new Map([['Lens Edu', folder]]),
      folderNames: ['Lens Edu'],
      errors: new Map(),
      onNavigate: vi.fn(),
      justCreatedRef: { current: false },
    }}>
      <DisplayNameProvider>
        <ConceptRowsPanel docId={`${RELAY_ID}-art`} path="/Lens Edu/articles/a.md" ytext={new Y.Doc().getText('contents')} />
      </DisplayNameProvider>
    </NavigationContext.Provider>,
  );
}

const card = (concept: string) => document.querySelector(`.concept-row[data-concept="${concept}"]`) as HTMLElement;

describe('ConceptRowsPanel on an article', () => {
  it('groups lens rows with the article row of the same concept, and lens-only concepts last', async () => {
    renderPanel({ l1: 'source:: [[../articles/a]]\n', l2: 'source:: [[../articles/a]]\n', cs: SHARED, co: ONLY_LENS });
    await waitFor(() => expect(screen.getByText('Only linked to the lenses that use it')).toBeInTheDocument());

    // Its own row, collapsed, with a hint of the lens row nested under it.
    const shared = card('Shared');
    expect(within(shared).getByText('Article note.')).toBeInTheDocument();
    expect(within(shared).getByText('+1 lens row')).toBeInTheDocument();
    expect(within(shared).queryByText('Lens one note.')).toBeNull();

    // A concept reached only through a lens: named, not its row twice.
    const group = screen.getByTestId('concept-context-group');
    const only = within(group).getByText('Only lens').closest('.concept-row') as HTMLElement;
    expect(within(only).getByText('1 lens row: Lens Two')).toBeInTheDocument();
    expect(within(only).getByRole('button', { name: 'Add for this article too' })).toBeInTheDocument();

    // Expand all reaches the nested lens rows too.
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getAllByRole('button', { name: 'Collapse row' })).toHaveLength(4);
    expect(screen.queryAllByRole('button', { name: 'Expand row' })).toHaveLength(0);
    const lensOne = screen.getByRole('link', { name: 'Lens One' });
    expect(lensOne.closest('.concept-row-label')?.textContent).toBe('Lens: Lens One');
    expect(lensOne.getAttribute('href')).toBeTruthy();
    expect(screen.getByText('Lens one note.')).toBeInTheDocument();
    expect(screen.getByText('Lens two note.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse all' })).toBeInTheDocument();
  });

  it('names the lens in the heading when one lens uses the article, and says the article has no rows yet', async () => {
    renderPanel({ l1: 'source:: [[../articles/other]]\n', l2: 'source:: [[../articles/a]]\n', cs: '# Shared\n', co: ONLY_LENS });
    await waitFor(() => expect(screen.getByText('Only linked to Lens: Lens Two')).toBeInTheDocument());
    expect(screen.getByText('No relationships for this article yet')).toBeInTheDocument();
    expect(screen.queryByText('No concept relationships yet')).toBeNull();
  });

  it('shows a CRLF concept file without crashing', async () => {
    // Rows of several lines: CodeMirror reads each \r\n as one line break.
    const crlf = '## Relationships\n### [[../articles/a]]\nArticle note.\nSecond line.\n### [[../Lenses/Lens One]]\nLens one note.\nMore.\n'
      .replace(/\n/g, '\r\n');
    renderPanel({ l1: 'source:: [[../articles/a]]\r\n', l2: '', cs: crlf, co: '' });
    await waitFor(() => expect(within(card('Shared')).getByText('Article note.')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getAllByRole('button', { name: 'Collapse row' })).toHaveLength(2);
    // Shown, read-only (edited in the concept file), both rows.
    expect(screen.getAllByText(/Windows line endings/)).toHaveLength(2);
    expect(screen.getByText('Second line.')).toBeInTheDocument();
  });
});
