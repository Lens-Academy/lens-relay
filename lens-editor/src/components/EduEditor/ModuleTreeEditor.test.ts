import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { parseSections } from '../SectionEditor/parseSections';

// Stable mock refs
import * as Y from 'yjs';

const mockConnections = new Map<string, { doc: Y.Doc; provider: { destroy: () => void } }>();
const stableGetOrConnect = vi.fn(async (docId: string) => {
  if (mockConnections.has(docId)) return mockConnections.get(docId)!;
  const doc = new Y.Doc();
  const conn = { doc, provider: { destroy: vi.fn() } };
  mockConnections.set(docId, conn);
  return conn;
});
vi.mock('../../hooks/useDocConnection', () => ({
  useDocConnection: () => ({
    getOrConnect: stableGetOrConnect,
    disconnect: vi.fn(),
    disconnectAll: vi.fn(),
  }),
}));

vi.mock('../../hooks/useSectionEditor', () => ({
  useSectionEditor: () => ({ mountRef: { current: null } }),
}));

// Controllable useLODocs mock
const loDocsMock = vi.fn(() => ({}));
vi.mock('./useLODocs', () => ({
  useLODocs: (...args: any[]) => loDocsMock(...args),
}));

// Mutable metadata ref so per-test overrides work even with hoisting
let mockMetadata: Record<string, { id: string }> = {};
vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ metadata: mockMetadata }),
}));

const { ModuleTreeEditor } = await import('./ModuleTreeEditor');

describe('ModuleTreeEditor', () => {
  it('renders the module header with title from frontmatter', () => {
    const sections = parseSections('---\ntitle: Cognitive Superpowers\nslug: cognitive\n---\n');
    render(
      React.createElement(ModuleTreeEditor, {
        moduleSections: sections,
        modulePath: 'modules/cognitive.md',
        activeSelection: null,
        onSelect: () => {},
      }),
    );
    expect(screen.getByText('Cognitive Superpowers')).toBeInTheDocument();
  });

  it('renders a tree entry for an inline # Lens: section', () => {
    const text =
      '---\ntitle: Mod\n---\n' +
      '# Lens: Welcome\n' +
      '#### Text\ncontent::\nhi\n';
    const sections = parseSections(text);
    render(
      React.createElement(ModuleTreeEditor, {
        moduleSections: sections,
        modulePath: 'modules/mod.md',
        moduleDocId: 'relay-mod-uuid',
        activeSelection: null,
        onSelect: () => {},
      }),
    );
    expect(screen.getByText('Welcome')).toBeInTheDocument();
    expect(screen.getByText('Lens')).toBeInTheDocument(); // badge
  });

  it('renders an LO card with title, definition, and nested lenses', () => {
    // Use root-level paths so wikilinks resolve without subdirectory prefix
    // resolveWikilinkToUuid('[[LOs/LO-Title.md]]', 'test-module.md', metadata)
    //   → resolveRelativePath('LOs/LO-Title.md', 'test-module.md') → 'LOs/LO-Title.md'
    mockMetadata = {
      'LOs/LO-Title.md': { id: 'lo-uuid' },
      'Lenses/PASTA.md': { id: 'lens-pasta-uuid' },
    };

    // LO doc text: loPath is 'LOs/LO-Title.md', so [[Lenses/PASTA.md]] resolves from that dir
    // resolveRelativePath('Lenses/PASTA.md', 'LOs/LO-Title.md') → 'LOs/Lenses/PASTA.md' — no good
    // Use a loPath at root level too: loPath = 'LO-Title.md'
    // Then [[Lenses/PASTA.md]] from root resolves to 'Lenses/PASTA.md' ✓
    const loText =
      '---\nlearning-outcome: Definition text\n---\n' +
      '## Lens:\nsource:: [[Lenses/PASTA.md]]\n' +
      '## Test:\n' +
      '#### Question\ncontent::\nWhat is PASTA?\n';
    const loSections = parseSections(loText);

    // Configure useLODocs to return this LO entry
    loDocsMock.mockReturnValue({
      'lo-uuid': {
        loPath: 'LO-Title.md',  // root-level path so [[Lenses/PASTA.md]] resolves to 'Lenses/PASTA.md'
        title: 'LO-Title',
        frontmatter: new Map([['learning-outcome', 'Definition text']]),
        sections: loSections,
      },
    });

    // Module text with one # Learning Outcome: that references the LO
    const moduleText =
      '---\ntitle: Test Module\n---\n' +
      '# Learning Outcome:\nsource:: [[LOs/LO-Title.md]]\n';
    const moduleSections = parseSections(moduleText);

    render(
      React.createElement(ModuleTreeEditor, {
        moduleSections,
        modulePath: 'test-module.md',  // root-level so [[LOs/LO-Title.md]] → 'LOs/LO-Title.md'
        activeSelection: null,
        onSelect: () => {},
      }),
    );

    // LO title shows
    expect(screen.getByText('LO-Title')).toBeInTheDocument();
    // LO definition shows
    expect(screen.getByText('Definition text')).toBeInTheDocument();
    // Lens name shows (resolved from source wikilink)
    expect(screen.getByText('PASTA.md')).toBeInTheDocument();
    // Test count shows
    expect(screen.getByText('Test (1 questions)')).toBeInTheDocument();
  });

  it('shows editing UI when the LO definition is clicked', async () => {
    mockMetadata = {
      'LOs/LO-Click.md': { id: 'lo-click-uuid' },
    };

    // Seed a real Y.Doc with frontmatter so getOrConnect returns something usable
    const loDoc = new Y.Doc();
    loDoc.getText('contents').insert(0, '---\nlearning-outcome: Click to edit me\n---\n');
    mockConnections.set(`cb696037-0f72-4e93-8717-4e433129d789-lo-click-uuid`, {
      doc: loDoc,
      provider: { destroy: vi.fn() },
    });

    const loText = '---\nlearning-outcome: Click to edit me\n---\n';
    const loSections = parseSections(loText);

    loDocsMock.mockReturnValue({
      'lo-click-uuid': {
        loPath: 'LO-Click.md',
        title: 'Click LO',
        frontmatter: new Map([['learning-outcome', 'Click to edit me']]),
        sections: loSections,
      },
    });

    const moduleText =
      '---\ntitle: Click Module\n---\n' +
      '# Learning Outcome:\nsource:: [[LOs/LO-Click.md]]\n';
    const moduleSections = parseSections(moduleText);

    render(
      React.createElement(ModuleTreeEditor, {
        moduleSections,
        modulePath: 'click-module.md',
        activeSelection: null,
        onSelect: () => {},
      }),
    );

    // Definition text is visible before clicking
    expect(screen.getByText('Click to edit me')).toBeInTheDocument();

    // Click the definition text to start editing
    fireEvent.click(screen.getByText('Click to edit me'));

    // Editing UI should appear after async getOrConnect resolves
    await waitFor(() => {
      expect(screen.getByText('Editing definition')).toBeInTheDocument();
    });
  });
});
