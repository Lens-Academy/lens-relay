import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { parseSections } from '../SectionEditor/parseSections';

// Stable mock refs
const stableGetOrConnect = vi.fn(async () => ({ doc: {} as any, provider: { destroy: vi.fn() } }));
vi.mock('../../hooks/useDocConnection', () => ({
  useDocConnection: () => ({
    getOrConnect: stableGetOrConnect,
    disconnect: vi.fn(),
    disconnectAll: vi.fn(),
  }),
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
});
