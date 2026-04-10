import { describe, it, expect, vi, afterEach } from 'vitest';
import * as Y from 'yjs';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Section } from '../SectionEditor/parseSections';
import { RELAY_ID } from '../../lib/constants';

const mockConnections = new Map<string, { doc: Y.Doc; provider: { destroy: () => void } }>();

vi.mock('../../hooks/useDocConnection', () => ({
  useDocConnection: () => ({
    getOrConnect: vi.fn(async (docId: string) => {
      if (mockConnections.has(docId)) return mockConnections.get(docId)!;
      const doc = new Y.Doc();
      const provider = { destroy: vi.fn() };
      const conn = { doc, provider };
      mockConnections.set(docId, conn);
      return conn;
    }),
    disconnect: vi.fn(),
    disconnectAll: vi.fn(),
  }),
}));

vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    metadata: {
      'modules/cognitive.md': { id: 'fc1c3de9-6429-45fd-913f-76a032180d50' },
      'Learning Outcomes/LO-One.md': { id: 'lo-one-uuid' },
      'Learning Outcomes/LO-Two.md': { id: 'lo-two-uuid' },
    },
  }),
}));

// Import after mocks are set up
const { useLODocs } = await import('./useLODocs');

function seedLODoc(uuid: string, contents: string) {
  const doc = new Y.Doc();
  doc.getText('contents').insert(0, contents);
  mockConnections.set(`${RELAY_ID}-${uuid}`, {
    doc,
    provider: { destroy: vi.fn() },
  });
  return doc;
}

function loRef(source: string): Section {
  return {
    type: 'lo-ref',
    label: 'Learning Outcome',
    level: 1,
    from: 0,
    to: 0,
    content: `# Learning Outcome:\nsource:: ${source}\n`,
  };
}

afterEach(() => { mockConnections.clear(); });

describe('useLODocs', () => {
  it('returns empty when module has no LO refs', async () => {
    const { result } = renderHook(() => useLODocs([], 'modules/cognitive.md'));
    expect(result.current).toEqual({});
  });

  it('fetches each LO referenced by the module', async () => {
    seedLODoc('lo-one-uuid', '---\nlearning-outcome: "Explain X"\n---\n## Lens:\nsource:: [[../Lenses/A]]\n');
    seedLODoc('lo-two-uuid', '---\nlearning-outcome: "Analyze Y"\n---\n## Test:\n');

    const sections: Section[] = [
      loRef('[[../Learning Outcomes/LO-One]]'),
      loRef('[[../Learning Outcomes/LO-Two]]'),
    ];

    const { result } = renderHook(() => useLODocs(sections, 'modules/cognitive.md'));

    await waitFor(() => {
      expect(Object.keys(result.current).sort()).toEqual(['lo-one-uuid', 'lo-two-uuid']);
    });

    expect(result.current['lo-one-uuid'].title).toBe('LO-One');
    expect(result.current['lo-one-uuid'].sections.length).toBeGreaterThan(0);
    expect(result.current['lo-one-uuid'].frontmatter.get('learning-outcome')).toBe('Explain X');
  });

  it('updates when an LO\'s Y.Text changes', async () => {
    const doc = seedLODoc('lo-one-uuid', '---\nlearning-outcome: "Old"\n---\n');

    const sections: Section[] = [loRef('[[../Learning Outcomes/LO-One]]')];

    const { result } = renderHook(() => useLODocs(sections, 'modules/cognitive.md'));

    await waitFor(() => {
      expect(result.current['lo-one-uuid']?.frontmatter.get('learning-outcome')).toBe('Old');
    });

    act(() => {
      const text = doc.getText('contents');
      text.delete(0, text.length);
      text.insert(0, '---\nlearning-outcome: "New definition"\n---\n');
    });

    await waitFor(() => {
      expect(result.current['lo-one-uuid'].frontmatter.get('learning-outcome')).toBe('New definition');
    });
  });

  it('deduplicates when multiple refs resolve to the same LO uuid', async () => {
    seedLODoc('lo-one-uuid', '---\nlearning-outcome: "X"\n---\n');

    const sections: Section[] = [
      loRef('[[../Learning Outcomes/LO-One]]'),
      loRef('[[../Learning Outcomes/LO-One]]'),
    ];

    const { result } = renderHook(() => useLODocs(sections, 'modules/cognitive.md'));

    await waitFor(() => {
      expect(Object.keys(result.current)).toEqual(['lo-one-uuid']);
    });
  });
});
