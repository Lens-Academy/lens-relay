import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import * as Y from 'yjs';
import { NavigationContext } from '../../contexts/NavigationContext';
import type { FolderMetadata } from '../../hooks/useFolderMetadata';
import { parseConceptFile, type RowEntry } from '../../lib/concept-rows';
import { ConceptRowCard, type RowCardProps } from './ConceptRowCard';
import { EditorView } from '@codemirror/view';
import { waitFor } from '@testing-library/react';
import { __embedDocsTesting } from '../../lib/embed-docs';
import type { DocConnection } from '../../hooks/useDocConnection';

vi.mock('../../hooks/useDocConnection', () => ({
  connectDoc: vi.fn(),
  teardownProvider: vi.fn(),
}));

const ARTICLE = 'pan-a-taxonomy-of-barriers-to-trading-with-early-misaligned-ais';
const metadata: FolderMetadata = {
  '/Lens Edu/Concepts/Trading.md': { id: 'c1', type: 'markdown', version: 0 },
  [`/Lens Edu/articles/${ARTICLE}.md`]: { id: 'a1', type: 'markdown', version: 0 },
  '/Lens Edu/articles/other.md': { id: 'a2', type: 'markdown', version: 0 },
};
const text = `## Relationships\n\n### [[../articles/${ARTICLE}]]\nFirst line of the note.\n`;
const entry: RowEntry = {
  conceptId: 'c1',
  conceptPath: '/Lens Edu/Concepts/Trading.md',
  conceptName: 'Trading with early misaligned AIs',
  row: parseConceptFile(text).rows[0],
  index: 0,
  body: 'First line of the note.',
};

const onNavigate = vi.fn();

function Card(props: Partial<RowCardProps>) {
  const [expanded, setExpanded] = useState(false);
  return (
    <NavigationContext.Provider value={{
      metadata,
      folderDocs: new Map([['Lens Edu', new Y.Doc()]]),
      folderNames: ['Lens Edu'],
      errors: new Map(),
      onNavigate,
      justCreatedRef: { current: false },
    }}>
      <ConceptRowCard
        entry={entry}
        target="a1"
        targetName={ARTICLE}
        targetKeyword="This article"
        section="Relationships"
        metadata={metadata}
        canEdit={false}
        canAcceptReject={false}
        getActor={() => 'human:test'}
        expanded={expanded}
        onExpandedChange={setExpanded}
        {...props}
      />
    </NavigationContext.Provider>
  );
}

describe('ConceptRowCard', () => {
  it('expands and collapses from the same header bar, and from the triangle', () => {
    render(<Card />);
    const triangle = screen.getByRole('button', { name: 'Expand row' });
    expect(triangle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(screen.getByText('First line of the note.'));
    expect(screen.getByRole('button', { name: 'Collapse row' })).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(document.querySelector('.concept-row-header')!);
    expect(screen.getByRole('button', { name: 'Expand row' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand row' }));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse row' }));
    expect(screen.getByRole('button', { name: 'Expand row' })).toBeInTheDocument();
  });

  it('does not toggle when the concept link is clicked; the link has a real href', () => {
    render(<Card />);
    const link = screen.getByRole('link', { name: entry.conceptName });
    expect(link.getAttribute('href')).toBe('/c1/Lens-Edu/Concepts/Trading.md');
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith(expect.stringMatching(/-c1$/));
    expect(screen.getByRole('button', { name: 'Expand row' })).toBeInTheDocument();
  });

  it('shows keyword chips with the full names in their tooltips', () => {
    render(<Card />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand row' }));
    expect(screen.getByText('Concept')).toHaveAttribute('title', entry.conceptName);
    expect(screen.getByText('This article')).toHaveAttribute('title', ARTICLE);
  });

  it('shows no source tag on the collapsed line', () => {
    render(<Card sourceRows={[{ sourceId: 'a1', sourceName: ARTICLE, kind: 'Article', rows: [entry] }]} targetKeyword="This lens" />);
    expect(screen.queryByText(/^lens/)).toBeNull();
  });

  it('labels and chips each article block on a lens', () => {
    render(<Card sourceRows={[{ sourceId: 'a1', sourceName: ARTICLE, kind: 'Article', rows: [entry] }]} targetKeyword="This lens" />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand row' }));
    expect(screen.getByText('This lens')).toBeInTheDocument();
    expect(screen.getByText('Article')).toHaveAttribute('title', ARTICLE);
    expect(screen.getByText(`Article: ${ARTICLE}`)).toHaveAttribute('title', `Article: ${ARTICLE}`);
  });

  it('shows a source-only concept as its source blocks, chipped by kind, with no lens block', () => {
    render(
      <Card
        context
        targetKeyword="Video"
        sourceRows={[
          { sourceId: 'a1', sourceName: ARTICLE, kind: 'Article', rows: [entry] },
          { sourceId: 'v1', sourceName: 'a-long-video-transcript-name', kind: 'Video', rows: [{ ...entry, body: 'Video note.' }] },
        ]}
        onAddForLens={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Expand row' }));
    expect(screen.queryByText('This lens')).toBeNull();
    expect(screen.getByText('Video')).toHaveAttribute('title', 'a-long-video-transcript-name');
    expect(screen.getByText('Video: a-long-video-transcript-name')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add for this lens too' })).toHaveLength(1);
  });

  it('edits an empty row followed directly by a heading without touching that heading (keyboard path)', async () => {
    const live = `## Relationships\n### [[../articles/${ARTICLE}]]\n### [[../articles/other]]\n`;
    const doc = new Y.Doc();
    doc.getText('contents').insert(0, live);
    const provider = { hasLocalChanges: false, on: () => {}, off: () => {} };
    __embedDocsTesting.setConnector(async () => ({ doc, provider } as unknown as DocConnection));
    const row = parseConceptFile(live).rows[0];
    render(<Card canEdit entry={{ ...entry, row, body: '' }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Expand row' }));
    const textButton = screen.getByRole('button', { name: `Edit notes on ${entry.conceptName}` });
    fireEvent.keyDown(textButton, { key: 'Enter' });
    await waitFor(() => expect(document.querySelector('.concept-row')).toHaveAttribute('data-state', 'live'));

    const view = EditorView.findFromDOM(document.querySelector('.concept-row [contenteditable=true]') as HTMLElement)!;
    view.dispatch({ changes: { from: view.state.doc.length, insert: 'TYPED' } });
    expect(doc.getText('contents').toString())
      .toBe(`## Relationships\n### [[../articles/${ARTICLE}]]\nTYPED\n### [[../articles/other]]\n`);

    // Escape ends the edit and gives the keyboard back to the row's toggle
    fireEvent.keyDown(view.contentDOM, { key: 'Escape' });
    await waitFor(() => expect(document.querySelector('.concept-row')).toHaveAttribute('data-state', 'idle'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Collapse row' })));
    __embedDocsTesting.reset();
  });

  it('writes nothing when an empty row is opened and left without typing', async () => {
    const live = `## Relationships\n### [[../articles/${ARTICLE}]]\n### [[../articles/other]]\n`;
    const doc = new Y.Doc();
    doc.getText('contents').insert(0, live);
    const provider = { hasLocalChanges: false, on: () => {}, off: () => {} };
    __embedDocsTesting.setConnector(async () => ({ doc, provider } as unknown as DocConnection));
    render(<Card canEdit entry={{ ...entry, row: parseConceptFile(live).rows[0], body: '' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand row' }));
    fireEvent.keyDown(screen.getByRole('button', { name: `Edit notes on ${entry.conceptName}` }), { key: 'Enter' });
    await waitFor(() => expect(document.querySelector('.concept-row')).toHaveAttribute('data-state', 'live'));
    const view = EditorView.findFromDOM(document.querySelector('.concept-row [contenteditable=true]') as HTMLElement)!;
    fireEvent.keyDown(view.contentDOM, { key: 'Escape' });
    await waitFor(() => expect(document.querySelector('.concept-row')).toHaveAttribute('data-state', 'idle'));
    expect(doc.getText('contents').toString()).toBe(live);
    __embedDocsTesting.reset();
  });

  it('offers Retry after a failed open, and still collapses', async () => {
    const doc = new Y.Doc();
    doc.getText('contents').insert(0, text);
    const provider = { hasLocalChanges: false, on: () => {}, off: () => {} };
    let fail = true;
    __embedDocsTesting.setConnector(async () => {
      if (fail) throw new Error('offline');
      return { doc, provider } as unknown as DocConnection;
    });
    render(<Card canEdit />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand row' }));
    fireEvent.keyDown(screen.getByRole('button', { name: `Edit notes on ${entry.conceptName}` }), { key: 'Enter' });
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.getByText(/Could not open/)).toBeInTheDocument();

    // The toggle still works: collapse clears the error
    fireEvent.click(screen.getByRole('button', { name: 'Collapse row' }));
    expect(screen.getByRole('button', { name: 'Expand row' })).toBeInTheDocument();
    expect(screen.queryByText(/Could not open/)).toBeNull();
    expect(retry).not.toBeInTheDocument();

    // Fail again, then Retry once the connection works
    fireEvent.click(screen.getByRole('button', { name: 'Expand row' }));
    fireEvent.keyDown(screen.getByRole('button', { name: `Edit notes on ${entry.conceptName}` }), { key: 'Enter' });
    const retryAgain = await screen.findByRole('button', { name: 'Retry' });
    fail = false;
    fireEvent.click(retryAgain);
    await waitFor(() => expect(document.querySelector('.concept-row')).toHaveAttribute('data-state', 'live'));
    __embedDocsTesting.reset();
  });

  it('follows the main editor\'s Suggesting mode, also when it is switched while the row is open', async () => {
    const live = `## Relationships\n### [[../articles/${ARTICLE}]]\nNotes.\n`;
    const doc = new Y.Doc();
    doc.getText('contents').insert(0, live);
    const provider = { hasLocalChanges: false, on: () => {}, off: () => {} };
    __embedDocsTesting.setConnector(async () => ({ doc, provider } as unknown as DocConnection));
    const row = parseConceptFile(live).rows[0];
    const { rerender } = render(<Card canEdit suggestionMode entry={{ ...entry, row, body: 'Notes.' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand row' }));
    fireEvent.keyDown(screen.getByRole('button', { name: `Edit notes on ${entry.conceptName}` }), { key: 'Enter' });
    await waitFor(() => expect(document.querySelector('.concept-row')).toHaveAttribute('data-state', 'live'));
    const view = EditorView.findFromDOM(document.querySelector('.concept-row [contenteditable=true]') as HTMLElement)!;

    view.dispatch({ changes: { from: view.state.doc.length, insert: ' More' }, userEvent: 'input.type' });
    const suggested = doc.getText('contents').toString();
    expect(suggested).toMatch(/\{\+\+.* More\+\+\}/);

    rerender(<Card canEdit suggestionMode={false} entry={{ ...entry, row, body: 'Notes.' }} />);
    view.dispatch({ changes: { from: view.state.doc.length, insert: ' Direct' }, userEvent: 'input.type' });
    expect(doc.getText('contents').toString()).toBe(`${suggested.slice(0, -1)} Direct\n`);
    __embedDocsTesting.reset();
  });
});
