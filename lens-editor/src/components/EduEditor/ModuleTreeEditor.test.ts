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

vi.mock('./useLODocs', () => ({
  useLODocs: () => ({}),
}));

vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ metadata: {} }),
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
});
