import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as Y from 'yjs';
import { NavigationContext } from '../../contexts/NavigationContext';
import { __embedDocsTesting } from '../../lib/embed-docs';
import { RELAY_ID } from '../../App';
import { ConceptGraphPanel } from './ConceptGraphPanel';

const md = (id: string) => ({ id, type: 'markdown' as const, version: 0 });
const fm = (...parents: string[]) =>
  `---\nparent-concepts:\n${parents.map((p) => `  - "[[${p}]]"`).join('\n')}\n---\n# x\n`;

const metadata = {
  '/Lens Edu/Concepts/AI Control.md': md('control'),
  '/Lens Edu/Concepts/Control protocols.md': md('protocols'),
  '/Lens Edu/Concepts/Low-stakes control.md': md('low'),
  '/Lens Edu/Concepts/Monitoring.md': md('mon'),
  '/Lens Edu/Concepts/Trusted monitoring.md': md('tm'),
  '/Lens Edu/Concepts/Collusion.md': md('col'),
  '/Lens Edu/Concepts/Cycle A.md': md('ca'),
  '/Lens Edu/Concepts/Cycle B.md': md('cb'),
};
const texts: Record<string, string> = {
  control: '# AI Control\n',
  protocols: fm('AI Control'),
  low: fm('Control protocols'),
  mon: '# Monitoring\n',
  tm: fm('Low-stakes control', 'Monitoring', 'Control protocols'),
  col: fm('Trusted monitoring'),
  ca: fm('Cycle B'),
  cb: fm('Cycle A'),
};
const backlinks: Record<string, string[]> = {
  control: ['protocols'],
  protocols: ['low', 'tm'],
  low: ['tm'],
  mon: ['tm'],
  tm: ['col'],
  ca: ['cb'],
  cb: ['ca'],
};

function renderPanel(id: string, text: string) {
  const folder = new Y.Doc();
  for (const [k, v] of Object.entries(backlinks)) folder.getMap<string[]>('backlinks_v0').set(k, v);
  const ytext = new Y.Doc().getText('contents');
  ytext.insert(0, text);
  const path = Object.entries(metadata).find(([, m]) => m.id === id)![0];
  return render(
    <NavigationContext.Provider value={{
      metadata,
      folderDocs: new Map([['Lens Edu', folder]]),
      folderNames: ['Lens Edu'],
      errors: new Map(),
      onNavigate: vi.fn(),
      justCreatedRef: { current: false },
    }}>
      <ConceptGraphPanel docId={`${RELAY_ID}-${id}`} path={path} ytext={ytext} />
    </NavigationContext.Provider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  __embedDocsTesting.setReader(async (fullId) => {
    const id = Object.keys(texts).find((k) => fullId.endsWith(`-${k}`));
    return id ? texts[id] : '';
  });
});

afterEach(() => {
  __embedDocsTesting.reset();
});

describe('ConceptGraphPanel', () => {
  it('draws every ancestor and the children, and lists parents in order and children with counts', async () => {
    renderPanel('tm', texts.tm);
    const drawing = await screen.findByTestId('concept-graph-drawing');
    expect(drawing.getAttribute('aria-hidden')).toBe('true');
    await waitFor(() => expect(within(drawing).getByText('AI Control')).toBeTruthy());
    expect(within(drawing).getByText('Trusted monitoring').closest('[data-kind]')?.getAttribute('data-kind')).toBe('self');
    expect(within(drawing).getByText('Collusion')).toBeTruthy();
    // Drawn links are real links, kept out of the tab order (the lists are the accessible version).
    expect(within(drawing).getByText('Monitoring').closest('a')?.getAttribute('tabindex')).toBe('-1');

    const parents = screen.getByTestId('concept-graph-parents');
    expect([...parents.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Low-stakes control', 'Monitoring', 'Control protocols']);
    expect(parents.textContent).toContain('primary');
    expect(screen.getByTestId('concept-graph-children').textContent).toContain('Collusion');
  });

  it('a top-level concept says so, and shows its children with "+N"', async () => {
    renderPanel('control', texts.control);
    expect(screen.getByTestId('concept-graph-parents').textContent).toContain('none (top-level concept)');
    await waitFor(() => expect(screen.getByTestId('concept-graph-children').textContent).toMatch(/Control protocols\+2\+/));
  });

  it('unresolved parents: "none resolved" and a red note, not "top-level"', async () => {
    renderPanel('low', fm('Nowhere'));
    expect(screen.getByTestId('concept-graph-parents').textContent).toContain('none resolved');
    expect(screen.getByTestId('concept-graph-parents').textContent).not.toContain('top-level');
    expect(screen.getByTestId('concept-graph-unresolved').textContent).toBe('Parent not found: [[Nowhere]]');
  });

  it('a cycle through the file is noted', async () => {
    renderPanel('ca', texts.ca);
    expect((await screen.findByTestId('concept-graph-cycle')).textContent).toBe('A cycle runs through this file');
  });

  it('collapses, remembers it, and shows the main path when collapsed', async () => {
    const { unmount } = renderPanel('tm', texts.tm);
    await screen.findByTestId('concept-graph-drawing');
    fireEvent.click(screen.getByRole('button', { name: /Concept graph/ }));
    expect(screen.queryByTestId('concept-graph-body')).toBeNull();
    expect(localStorage.getItem('lens-editor:concept-graph-open')).toBe('false');
    await waitFor(() => expect(screen.getByTestId('concept-graph-panel').textContent).toContain('AI Control › Control protocols › Low-stakes control'));
    unmount();
    renderPanel('tm', texts.tm);
    expect(screen.queryByTestId('concept-graph-body')).toBeNull();
  });
});
