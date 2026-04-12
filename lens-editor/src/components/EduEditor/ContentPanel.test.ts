import { describe, it, expect, vi, afterEach } from 'vitest';
import * as Y from 'yjs';
import { render, waitFor, screen } from '@testing-library/react';
import { RELAY_ID } from '../../lib/constants';
import React from 'react';

const mockConnections = new Map<string, { doc: Y.Doc; provider: { destroy: () => void } }>();

// Stable mock refs — must not be recreated on every call (infinite re-render otherwise)
const stableGetOrConnect = vi.fn(async (docId: string) => {
  if (mockConnections.has(docId)) return mockConnections.get(docId)!;
  const doc = new Y.Doc();
  const conn = { doc, provider: { destroy: vi.fn() } };
  mockConnections.set(docId, conn);
  return conn;
});
const stableDisconnect = vi.fn();
const stableDisconnectAll = vi.fn();

vi.mock('../../hooks/useDocConnection', () => ({
  useDocConnection: () => ({
    getOrConnect: stableGetOrConnect,
    disconnect: stableDisconnect,
    disconnectAll: stableDisconnectAll,
  }),
}));

vi.mock('../../hooks/useSectionEditor', () => ({
  useSectionEditor: () => ({ mountRef: { current: null } }),
}));

vi.mock('./ContentPanel/renderers', () => ({
  TextRenderer: ({ content }: { content: string }) =>
    React.createElement('div', { 'data-testid': 'text-renderer' }, content),
  ChatRenderer: ({ title }: { title: string }) =>
    React.createElement('div', { 'data-testid': 'chat-renderer' }, title),
  VideoRenderer: () =>
    React.createElement('div', { 'data-testid': 'video-renderer' }, 'video'),
  ArticleRenderer: () =>
    React.createElement('div', { 'data-testid': 'article-renderer' }, 'article'),
  QuestionRenderer: ({ content }: { content: string }) =>
    React.createElement('div', { 'data-testid': 'question-renderer' }, content),
  HeadingRenderer: ({ label }: { label: string }) =>
    React.createElement('div', { 'data-testid': 'heading-renderer' }, label),
}));

vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    metadata: { 'Lenses/PASTA.md': { id: 'lens-pasta-uuid' } },
  }),
}));

const { ContentPanel } = await import('./ContentPanel');

function seedLensDoc(uuid: string, contents: string) {
  const doc = new Y.Doc();
  doc.getText('contents').insert(0, contents);
  mockConnections.set(`${RELAY_ID}-${uuid}`, {
    doc,
    provider: { destroy: vi.fn() },
  });
}

afterEach(() => { mockConnections.clear(); });

describe('ContentPanel', () => {
  it('renders a lens doc with text and question sections', async () => {
    seedLensDoc(
      'lens-pasta-uuid',
      '---\ntitle: PASTA\n---\n' +
      '#### Text\ncontent::\nPASTA is a framework.\n' +
      '#### Question\ncontent:: Why does it matter?\n',
    );

    render(
      React.createElement(ContentPanel, {
        scope: {
          kind: 'full-doc' as const,
          docId: `${RELAY_ID}-lens-pasta-uuid`,
          docName: 'PASTA',
          docPath: 'Lenses/PASTA.md',
        },
      }),
    );

    await waitFor(() => {
      expect(screen.getByText(/PASTA is a framework\./)).toBeInTheDocument();
    });
    expect(screen.getByText(/Why does it matter\?/)).toBeInTheDocument();
  });

  it('shows a placeholder when scope is null', () => {
    render(React.createElement(ContentPanel, { scope: null }));
    expect(screen.getByText(/pick a lens/i)).toBeInTheDocument();
  });

  it('renders only the subtree when scope.kind is "subtree"', async () => {
    seedLensDoc(
      'lens-pasta-uuid',
      '---\ntitle: Module\n---\n' +
      '# Lens: Welcome\n' +
      '#### Text\ncontent::\nWelcome text\n' +
      '# Learning Outcome:\nsource:: foo\n',
    );

    render(
      React.createElement(ContentPanel, {
        scope: {
          kind: 'subtree' as const,
          docId: `${RELAY_ID}-lens-pasta-uuid`,
          docName: 'Welcome',
          docPath: 'modules/mod.md',
          rootSectionIndex: 1, // "# Lens: Welcome" (0 is frontmatter)
          breadcrumb: 'inside modules/mod.md',
        },
      }),
    );

    await waitFor(() => {
      expect(screen.getByText(/Welcome text/)).toBeInTheDocument();
    });
    // Learning Outcome should NOT render — outside the subtree
    expect(screen.queryByText(/foo/)).not.toBeInTheDocument();
  });

  it('displays the breadcrumb for subtree scope', async () => {
    seedLensDoc(
      'lens-pasta-uuid',
      '---\ntitle: Module\n---\n' +
      '# Lens: Welcome\n' +
      '#### Text\ncontent::\nHello\n',
    );

    render(
      React.createElement(ContentPanel, {
        scope: {
          kind: 'subtree' as const,
          docId: `${RELAY_ID}-lens-pasta-uuid`,
          docName: 'Welcome',
          docPath: 'modules/mod.md',
          rootSectionIndex: 1,
          breadcrumb: 'inside modules/mod.md',
        },
      }),
    );

    await waitFor(() => {
      expect(screen.getByText(/inside modules\/mod\.md/)).toBeInTheDocument();
    });
  });
});
