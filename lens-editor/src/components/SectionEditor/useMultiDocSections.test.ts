import { describe, it, expect, vi, afterEach } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { DisplayNameProvider } from '../../contexts/DisplayNameContext';

const mockConnections = new Map<string, { doc: Y.Doc; provider: any }>();

vi.mock('../../hooks/useDocConnection', () => ({
  useDocConnection: () => ({
    getOrConnect: vi.fn(async (docId: string) => {
      if (mockConnections.has(docId)) return mockConnections.get(docId)!;
      const doc = new Y.Doc();
      const awareness = new Awareness(doc);
      const provider = {
        awareness,
        on: vi.fn(),
        off: vi.fn(),
        destroy: vi.fn(),
      };
      const conn = { doc, provider };
      mockConnections.set(docId, conn);
      return conn;
    }),
    disconnect: vi.fn((docId: string) => {
      const conn = mockConnections.get(docId);
      if (conn) { conn.provider.destroy(); conn.doc.destroy(); mockConnections.delete(docId); }
    }),
    disconnectAll: vi.fn(() => {
      for (const [, conn] of mockConnections) { conn.provider.destroy(); conn.doc.destroy(); }
      mockConnections.clear();
    }),
  }),
}));

const { useMultiDocSections } = await import('./useMultiDocSections');

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(DisplayNameProvider, null, children);
}

afterEach(() => { mockConnections.clear(); });

describe('useMultiDocSections', () => {
  it('returns empty sections when no doc IDs provided', async () => {
    const { result } = renderHook(() => useMultiDocSections([]), { wrapper });
    expect(result.current.sections).toEqual([]);
  });

  it('connects to docs and parses sections', async () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    doc.getText('contents').insert(0, '---\ntitle: Test\n---\n#### Video\nSome video content\n');
    mockConnections.set('relay-doc0', {
      doc, provider: { awareness, on: vi.fn(), off: vi.fn(), destroy: vi.fn() },
    });

    const { result } = renderHook(() => useMultiDocSections(['relay-doc0']), { wrapper });

    await vi.waitFor(() => { expect(result.current.synced).toBe(true); });
    expect(result.current.sections.length).toBeGreaterThan(0);
    expect(result.current.sections[0].compoundDocId).toBe('relay-doc0');
  });

  it('interleaves sections from two docs', async () => {
    const docA = new Y.Doc();
    docA.getText('contents').insert(0, '#### Video\nA video\n#### Text\nA text\n');
    mockConnections.set('doc-a', {
      doc: docA, provider: { awareness: new Awareness(docA), on: vi.fn(), off: vi.fn(), destroy: vi.fn() },
    });

    const docB = new Y.Doc();
    docB.getText('contents').insert(0, '#### Text\nB text\n');
    mockConnections.set('doc-b', {
      doc: docB, provider: { awareness: new Awareness(docB), on: vi.fn(), off: vi.fn(), destroy: vi.fn() },
    });

    const { result } = renderHook(() => useMultiDocSections(['doc-a', 'doc-b']), { wrapper });

    await vi.waitFor(() => { expect(result.current.synced).toBe(true); });
    expect(result.current.sections.length).toBe(3);
    expect(result.current.sections[0].docIndex).toBe(0);
    expect(result.current.sections[1].docIndex).toBe(1);
    expect(result.current.sections[2].docIndex).toBe(0);
  });

  it('updates sections when Y.Text changes externally', async () => {
    const doc = new Y.Doc();
    doc.getText('contents').insert(0, '#### Video\nOriginal\n');
    mockConnections.set('doc-live', {
      doc, provider: { awareness: new Awareness(doc), on: vi.fn(), off: vi.fn(), destroy: vi.fn() },
    });

    const { result } = renderHook(() => useMultiDocSections(['doc-live']), { wrapper });

    await vi.waitFor(() => { expect(result.current.synced).toBe(true); });
    const initialCount = result.current.sections.length;

    act(() => {
      doc.getText('contents').insert(doc.getText('contents').length, '#### Text\nNew section\n');
    });

    await vi.waitFor(() => { expect(result.current.sections.length).toBe(initialCount + 1); });
  });
});
