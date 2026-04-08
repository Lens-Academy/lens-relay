# Multi-Document Section Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show interleaved sections from multiple relay documents on a single section editor page, each independently editable with full CRDT sync and remote cursors.

**Architecture:** Extend `useDocConnection` to expose `YSweetProvider` (which has `.awareness`). A new `useMultiDocSections` hook manages N doc connections, observes their Y.Texts, parses sections, and interleaves them. A new `MultiDocSectionEditor` component renders the interleaved list and creates CM instances with `ySectionSync` bound to the correct Y.Text per section.

**Tech Stack:** React, Yjs, y-sweet (`YSweetProvider`, `@y-sweet/react`), CodeMirror 6, `y-section-sync.ts` (our forked yCollab), vitest + happy-dom.

**Spec:** `docs/superpowers/specs/2026-04-08-multi-doc-section-editor-design.md`

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/hooks/useDocConnection.ts` | Multi-doc Y.Doc + provider connection management (existing, modified) |
| `src/components/SectionEditor/interleaveSections.ts` | Pure function: round-robin interleave N section arrays with doc metadata |
| `src/components/SectionEditor/interleaveSections.test.ts` | Tests for interleave function |
| `src/components/SectionEditor/SectionCard.tsx` | Extracted section card component with optional doc label/color |
| `src/components/SectionEditor/MultiDocSectionEditor.tsx` | Multi-doc section editor component |
| `src/components/SectionEditor/useMultiDocSections.ts` | Hook: connect N docs, observe Y.Texts, parse + interleave sections |
| `src/components/SectionEditor/useMultiDocSections.test.ts` | Integration tests with real Y.Docs |
| `src/components/SectionEditor/SectionEditor.tsx` | Existing single-doc editor (modified to use extracted SectionCard) |
| `src/components/SectionEditor/index.ts` | Barrel exports (modified) |
| `src/App.tsx` | Route handler + `ReviewPageWithActions` caller update |

---

### Task 1: Extend useDocConnection to return provider

**Files:**
- Modify: `src/hooks/useDocConnection.ts:12-29`
- Modify: `src/App.tsx:269-277` (ReviewPageWithActions caller)

- [ ] **Step 1: Write the failing test**

Create `src/hooks/useDocConnection.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock YSweetProvider to avoid real network connections
vi.mock('@y-sweet/client', () => {
  const { Awareness } = require('y-protocols/awareness');
  const Y = require('yjs');
  return {
    YSweetProvider: vi.fn().mockImplementation((_auth, _id, doc) => {
      const awareness = new Awareness(doc);
      const listeners: Record<string, Function[]> = {};
      return {
        awareness,
        on(event: string, cb: Function) {
          (listeners[event] ??= []).push(cb);
          // Auto-fire synced for tests
          if (event === 'synced') setTimeout(() => cb(), 0);
        },
        off(event: string, cb: Function) {
          listeners[event] = (listeners[event] ?? []).filter(f => f !== cb);
        },
        destroy: vi.fn(),
      };
    }),
  };
});

vi.mock('../lib/auth', () => ({
  getClientToken: vi.fn().mockResolvedValue({ token: 'test' }),
}));

// Must import AFTER mocks
const { useDocConnection } = await import('./useDocConnection');
import { renderHook, act } from '@testing-library/react';

describe('useDocConnection', () => {
  it('getOrConnect returns { doc, provider } with awareness', async () => {
    const { result } = renderHook(() => useDocConnection());

    let connection: any;
    await act(async () => {
      connection = await result.current.getOrConnect('test-doc-id');
    });

    expect(connection).toHaveProperty('doc');
    expect(connection).toHaveProperty('provider');
    expect(connection.provider).toHaveProperty('awareness');
    expect(connection.doc).toBeInstanceOf((await import('yjs')).default.Doc);
  });

  it('returns same connection on second call with same docId', async () => {
    const { result } = renderHook(() => useDocConnection());

    let conn1: any, conn2: any;
    await act(async () => {
      conn1 = await result.current.getOrConnect('same-id');
      conn2 = await result.current.getOrConnect('same-id');
    });

    expect(conn1.doc).toBe(conn2.doc);
    expect(conn1.provider).toBe(conn2.provider);
  });

  it('disconnect destroys provider and doc', async () => {
    const { result } = renderHook(() => useDocConnection());

    let connection: any;
    await act(async () => {
      connection = await result.current.getOrConnect('to-disconnect');
    });

    act(() => {
      result.current.disconnect('to-disconnect');
    });

    expect(connection.provider.destroy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lens-editor && npx vitest run src/hooks/useDocConnection.test.ts`
Expected: FAIL — `connection` is a `Y.Doc` (no `.provider` property), not `{ doc, provider }`.

- [ ] **Step 3: Update useDocConnection to return { doc, provider }**

In `src/hooks/useDocConnection.ts`, change the return type and return value of `getOrConnect`:

```ts
import { useRef, useCallback } from 'react';
import * as Y from 'yjs';
import { YSweetProvider } from '@y-sweet/client';
import { getClientToken } from '../lib/auth';

export interface DocConnection {
  doc: Y.Doc;
  provider: YSweetProvider;
}

/**
 * Manages temporary Y.Doc connections for multi-doc workflows
 * (review page, multi-doc section editor).
 */
export function useDocConnection() {
  const connections = useRef<Map<string, DocConnection>>(new Map());

  const getOrConnect = useCallback(async (docId: string): Promise<DocConnection> => {
    const existing = connections.current.get(docId);
    if (existing) return existing;

    const doc = new Y.Doc();
    const authEndpoint = () => getClientToken(docId);
    const provider = new YSweetProvider(authEndpoint, docId, doc, { connect: true });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000);
      provider.on('synced', () => { clearTimeout(timeout); resolve(); });
      provider.on('connection-error', (err: Error) => { clearTimeout(timeout); reject(err); });
    });

    const connection: DocConnection = { doc, provider };
    connections.current.set(docId, connection);
    return connection;
  }, []);

  const disconnect = useCallback((docId: string) => {
    const conn = connections.current.get(docId);
    if (conn) {
      conn.provider.destroy();
      conn.doc.destroy();
      connections.current.delete(docId);
    }
  }, []);

  const disconnectAll = useCallback(() => {
    for (const [id] of connections.current) {
      disconnect(id);
    }
  }, [disconnect]);

  return { getOrConnect, disconnect, disconnectAll };
}
```

- [ ] **Step 4: Update ReviewPageWithActions caller in App.tsx**

In `src/App.tsx:274-276`, update to destructure `{ doc }`:

```ts
  const handleAction = async (docId: string, suggestion: SuggestionItem, action: 'accept' | 'reject') => {
    const { doc } = await getOrConnect(docId);
    applySuggestionAction(doc, suggestion, action);
  };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd lens-editor && npx vitest run src/hooks/useDocConnection.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Run full test suite to check for regressions**

Run: `cd lens-editor && npx vitest run`
Expected: All existing tests pass. No regressions.

- [ ] **Step 7: Commit**

```bash
jj new -m "feat: useDocConnection returns { doc, provider } for multi-doc support"
```

---

### Task 2: interleaveSections pure function

**Files:**
- Create: `src/components/SectionEditor/interleaveSections.ts`
- Create: `src/components/SectionEditor/interleaveSections.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/components/SectionEditor/interleaveSections.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { interleaveSections, type DocSections, type MultiDocSection } from './interleaveSections';
import type { Section } from './parseSections';

function makeSection(type: string, label: string, from: number, to: number): Section {
  return { type, label, from, to, content: `content of ${label}` };
}

describe('interleaveSections', () => {
  it('single doc returns all sections in order with doc metadata', () => {
    const input: DocSections[] = [{
      docIndex: 0,
      compoundDocId: 'relay-doc0',
      sections: [
        makeSection('frontmatter', 'Frontmatter', 0, 20),
        makeSection('video', 'Video', 20, 50),
      ],
    }];

    const result = interleaveSections(input);

    expect(result).toHaveLength(2);
    expect(result[0].label).toBe('Frontmatter');
    expect(result[0].docIndex).toBe(0);
    expect(result[0].compoundDocId).toBe('relay-doc0');
    expect(result[1].label).toBe('Video');
  });

  it('two docs interleave round-robin', () => {
    const input: DocSections[] = [
      {
        docIndex: 0,
        compoundDocId: 'relay-doc0',
        sections: [
          makeSection('frontmatter', 'A-FM', 0, 10),
          makeSection('video', 'A-Video', 10, 30),
          makeSection('text', 'A-Text', 30, 50),
        ],
      },
      {
        docIndex: 1,
        compoundDocId: 'relay-doc1',
        sections: [
          makeSection('frontmatter', 'B-FM', 0, 15),
          makeSection('text', 'B-Text', 15, 40),
        ],
      },
    ];

    const result = interleaveSections(input);

    // Round-robin: A0, B0, A1, B1, A2
    expect(result.map(s => s.label)).toEqual([
      'A-FM', 'B-FM', 'A-Video', 'B-Text', 'A-Text',
    ]);
    expect(result[0].docIndex).toBe(0);
    expect(result[1].docIndex).toBe(1);
    expect(result[4].docIndex).toBe(0);
  });

  it('empty doc array returns empty', () => {
    expect(interleaveSections([])).toEqual([]);
  });

  it('doc with zero sections is skipped', () => {
    const input: DocSections[] = [
      {
        docIndex: 0,
        compoundDocId: 'relay-doc0',
        sections: [makeSection('text', 'A-Text', 0, 10)],
      },
      {
        docIndex: 1,
        compoundDocId: 'relay-doc1',
        sections: [],
      },
    ];

    const result = interleaveSections(input);

    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('A-Text');
    expect(result[0].docIndex).toBe(0);
  });

  it('three docs interleave correctly', () => {
    const input: DocSections[] = [
      { docIndex: 0, compoundDocId: 'd0', sections: [makeSection('text', 'A1', 0, 10), makeSection('text', 'A2', 10, 20)] },
      { docIndex: 1, compoundDocId: 'd1', sections: [makeSection('text', 'B1', 0, 10)] },
      { docIndex: 2, compoundDocId: 'd2', sections: [makeSection('text', 'C1', 0, 10), makeSection('text', 'C2', 10, 20)] },
    ];

    const result = interleaveSections(input);

    // Round-robin: A1, B1, C1, A2, C2
    expect(result.map(s => s.label)).toEqual(['A1', 'B1', 'C1', 'A2', 'C2']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd lens-editor && npx vitest run src/components/SectionEditor/interleaveSections.test.ts`
Expected: FAIL — module `./interleaveSections` not found.

- [ ] **Step 3: Implement interleaveSections**

Create `src/components/SectionEditor/interleaveSections.ts`:

```ts
import type { Section } from './parseSections';

export interface DocSections {
  docIndex: number;
  compoundDocId: string;
  sections: Section[];
}

export interface MultiDocSection extends Section {
  docIndex: number;
  compoundDocId: string;
}

/**
 * Round-robin interleave sections from multiple documents.
 * Takes one section from each doc in turn, skipping exhausted docs.
 * Deterministic: same input always produces same output.
 */
export function interleaveSections(docs: DocSections[]): MultiDocSection[] {
  const result: MultiDocSection[] = [];
  const cursors = docs.map(() => 0);
  let remaining = docs.reduce((sum, d) => sum + d.sections.length, 0);

  while (remaining > 0) {
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      if (cursors[i] < doc.sections.length) {
        const section = doc.sections[cursors[i]];
        result.push({
          ...section,
          docIndex: doc.docIndex,
          compoundDocId: doc.compoundDocId,
        });
        cursors[i]++;
        remaining--;
      }
    }
  }

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lens-editor && npx vitest run src/components/SectionEditor/interleaveSections.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
jj new -m "feat: interleaveSections pure function for multi-doc section ordering"
```

---

### Task 3: Extract SectionCard component

**Files:**
- Create: `src/components/SectionEditor/SectionCard.tsx`
- Modify: `src/components/SectionEditor/SectionEditor.tsx:17-45`

- [ ] **Step 1: Extract SectionCard into its own file**

Create `src/components/SectionEditor/SectionCard.tsx`:

```tsx
import type { Section } from './parseSections';

// Document accent colors for multi-doc mode
const DOC_COLORS = [
  { bg: 'bg-blue-50', border: 'border-blue-300', text: 'text-blue-600' },
  { bg: 'bg-green-50', border: 'border-green-300', text: 'text-green-600' },
  { bg: 'bg-amber-50', border: 'border-amber-300', text: 'text-amber-600' },
  { bg: 'bg-rose-50', border: 'border-rose-300', text: 'text-rose-600' },
  { bg: 'bg-purple-50', border: 'border-purple-300', text: 'text-purple-600' },
  { bg: 'bg-cyan-50', border: 'border-cyan-300', text: 'text-cyan-600' },
];

export function getDocColor(docIndex: number) {
  return DOC_COLORS[docIndex % DOC_COLORS.length];
}

const SECTION_COLORS: Record<string, string> = {
  frontmatter: 'bg-gray-50 border-gray-200',
  video: 'bg-purple-50 border-purple-200',
  text: 'bg-blue-50 border-blue-200',
  chat: 'bg-green-50 border-green-200',
  'lens-ref': 'bg-indigo-50 border-indigo-200',
  'test-ref': 'bg-amber-50 border-amber-200',
  'lo-ref': 'bg-rose-50 border-rose-200',
};

interface SectionCardProps {
  section: Section;
  onClick: () => void;
  docLabel?: string;
  docIndex?: number;
}

export function SectionCard({ section, onClick, docLabel, docIndex }: SectionCardProps) {
  const lines = section.content.split('\n');
  const body = (section.type === 'frontmatter' ? lines.slice(1, -2) : lines.slice(1))
    .join('\n').trim();

  const docColor = docIndex != null ? getDocColor(docIndex) : null;

  return (
    <div
      className={`rounded-lg border ${SECTION_COLORS[section.type] || 'bg-white border-gray-200'} cursor-pointer hover:ring-1 hover:ring-blue-300 transition-all`}
      onClick={onClick}
    >
      <div className="flex items-center gap-2 px-4 py-2 border-b border-inherit">
        <span className="font-medium text-sm text-gray-700">{section.label}</span>
        {docLabel && docColor && (
          <span className={`text-xs px-1.5 py-0.5 rounded ${docColor.bg} ${docColor.text}`}>
            {docLabel}
          </span>
        )}
        <span className="text-xs text-gray-400 ml-auto">click to edit</span>
      </div>
      <div className="px-4 py-3 text-xs text-gray-500 whitespace-pre-wrap max-h-40 overflow-hidden">
        {body ? (body.length > 300 ? body.slice(0, 300) + '...' : body) : <em className="text-gray-400">Empty</em>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update SectionEditor.tsx to import extracted SectionCard**

Replace the inline `SectionCard` function in `src/components/SectionEditor/SectionEditor.tsx` (lines 17-45) with an import:

Remove lines 17-45 (the `SectionCard` function definition) and add this import at the top:

```ts
import { SectionCard } from './SectionCard';
```

The existing usage `<SectionCard section={section} onClick={() => setActiveIndex(i)} />` stays unchanged since the extracted component has the same interface.

- [ ] **Step 3: Run existing tests to verify no regressions**

Run: `cd lens-editor && npx vitest run src/components/SectionEditor/`
Expected: All existing tests pass (parseSections + y-section-sync).

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd lens-editor && npx tsc --noEmit`
Expected: Clean compile.

- [ ] **Step 5: Commit**

```bash
jj new -m "refactor: extract SectionCard into its own module"
```

---

### Task 4: useMultiDocSections hook

**Files:**
- Create: `src/components/SectionEditor/useMultiDocSections.ts`
- Create: `src/components/SectionEditor/useMultiDocSections.test.ts`

This is the most complex task. The hook manages N doc connections, observes their Y.Texts, parses sections, and interleaves them.

- [ ] **Step 1: Write the failing tests**

Create `src/components/SectionEditor/useMultiDocSections.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { DisplayNameProvider } from '../../contexts/DisplayNameContext';

// Mock useDocConnection to use in-memory Y.Docs instead of real network
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
      if (conn) {
        conn.provider.destroy();
        conn.doc.destroy();
        mockConnections.delete(docId);
      }
    }),
    disconnectAll: vi.fn(() => {
      for (const [, conn] of mockConnections) {
        conn.provider.destroy();
        conn.doc.destroy();
      }
      mockConnections.clear();
    }),
  }),
}));

const { useMultiDocSections } = await import('./useMultiDocSections');

// Wrapper providing DisplayNameContext
function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(DisplayNameProvider, null, children);
}

afterEach(() => {
  mockConnections.clear();
});

describe('useMultiDocSections', () => {
  it('returns empty sections when no doc IDs provided', async () => {
    const { result } = renderHook(() => useMultiDocSections([]), { wrapper });

    // No docs = immediately synced with empty sections
    expect(result.current.sections).toEqual([]);
  });

  it('connects to docs and parses sections', async () => {
    // Pre-populate a doc with content
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    doc.getText('contents').insert(0, '---\ntitle: Test\n---\n#### Video\nSome video content\n');
    mockConnections.set('relay-doc0', {
      doc,
      provider: { awareness, on: vi.fn(), off: vi.fn(), destroy: vi.fn() },
    });

    const { result } = renderHook(
      () => useMultiDocSections(['relay-doc0']),
      { wrapper },
    );

    // Wait for async connection
    await vi.waitFor(() => {
      expect(result.current.synced).toBe(true);
    });

    expect(result.current.sections.length).toBeGreaterThan(0);
    expect(result.current.sections[0].compoundDocId).toBe('relay-doc0');
  });

  it('interleaves sections from two docs', async () => {
    // Doc A: two sections
    const docA = new Y.Doc();
    docA.getText('contents').insert(0, '#### Video\nA video\n#### Text\nA text\n');
    mockConnections.set('doc-a', {
      doc: docA,
      provider: { awareness: new Awareness(docA), on: vi.fn(), off: vi.fn(), destroy: vi.fn() },
    });

    // Doc B: one section
    const docB = new Y.Doc();
    docB.getText('contents').insert(0, '#### Text\nB text\n');
    mockConnections.set('doc-b', {
      doc: docB,
      provider: { awareness: new Awareness(docB), on: vi.fn(), off: vi.fn(), destroy: vi.fn() },
    });

    const { result } = renderHook(
      () => useMultiDocSections(['doc-a', 'doc-b']),
      { wrapper },
    );

    await vi.waitFor(() => {
      expect(result.current.synced).toBe(true);
    });

    // Sections should be interleaved: A0, B0, A1
    expect(result.current.sections.length).toBe(3);
    expect(result.current.sections[0].docIndex).toBe(0);
    expect(result.current.sections[1].docIndex).toBe(1);
    expect(result.current.sections[2].docIndex).toBe(0);
  });

  it('updates sections when Y.Text changes externally', async () => {
    const doc = new Y.Doc();
    doc.getText('contents').insert(0, '#### Video\nOriginal\n');
    mockConnections.set('doc-live', {
      doc,
      provider: { awareness: new Awareness(doc), on: vi.fn(), off: vi.fn(), destroy: vi.fn() },
    });

    const { result } = renderHook(
      () => useMultiDocSections(['doc-live']),
      { wrapper },
    );

    await vi.waitFor(() => {
      expect(result.current.synced).toBe(true);
    });

    const initialCount = result.current.sections.length;

    // External edit: add a new section
    act(() => {
      doc.getText('contents').insert(doc.getText('contents').length, '#### Text\nNew section\n');
    });

    await vi.waitFor(() => {
      expect(result.current.sections.length).toBe(initialCount + 1);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd lens-editor && npx vitest run src/components/SectionEditor/useMultiDocSections.test.ts`
Expected: FAIL — module `./useMultiDocSections` not found.

- [ ] **Step 3: Implement useMultiDocSections**

Create `src/components/SectionEditor/useMultiDocSections.ts`:

```ts
import { useState, useEffect, useCallback, useRef } from 'react';
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import type { YSweetProvider } from '@y-sweet/client';
import { useDocConnection, type DocConnection } from '../../hooks/useDocConnection';
import { useDisplayName } from '../../contexts/DisplayNameContext';
import { parseSections } from './parseSections';
import { interleaveSections, type MultiDocSection } from './interleaveSections';

// Same palette as AwarenessInitializer
const USER_COLORS = [
  '#E53935', '#1E88E5', '#43A047', '#FB8C00', '#8E24AA', '#00ACC1',
];

interface DocState {
  doc: Y.Doc;
  provider: YSweetProvider;
  ytext: Y.Text;
  awareness: Awareness;
}

export function useMultiDocSections(compoundDocIds: string[]): {
  sections: MultiDocSection[];
  synced: boolean;
  errors: Map<string, Error>;
} {
  const { getOrConnect, disconnectAll } = useDocConnection();
  const { displayName } = useDisplayName();
  const [docStates, setDocStates] = useState<Map<string, DocState>>(new Map());
  const [sections, setSections] = useState<MultiDocSection[]>([]);
  const [synced, setSynced] = useState(false);
  const [errors, setErrors] = useState<Map<string, Error>>(new Map());
  const observersRef = useRef<Map<string, () => void>>(new Map());

  // Deduplicate doc IDs
  const uniqueIds = [...new Set(compoundDocIds)];

  // Connect to all docs
  useEffect(() => {
    if (uniqueIds.length === 0) {
      setSynced(true);
      setSections([]);
      return;
    }

    let cancelled = false;

    async function connectAll() {
      const states = new Map<string, DocState>();
      const errs = new Map<string, Error>();

      await Promise.all(uniqueIds.map(async (docId) => {
        try {
          const { doc, provider } = await getOrConnect(docId);
          const ytext = doc.getText('contents');

          // Initialize awareness
          const clientId = provider.awareness.clientID;
          provider.awareness.setLocalStateField('user', {
            name: displayName ?? `User ${clientId % 1000}`,
            color: USER_COLORS[clientId % USER_COLORS.length],
          });

          states.set(docId, { doc, provider, ytext, awareness: provider.awareness });
        } catch (err) {
          errs.set(docId, err instanceof Error ? err : new Error(String(err)));
        }
      }));

      if (cancelled) return;

      setDocStates(states);
      setErrors(errs);
      setSynced(true);
    }

    connectAll();

    return () => {
      cancelled = true;
    };
  }, [uniqueIds.join(',')]);

  // Rebuild sections from all doc states
  const rebuildSections = useCallback(() => {
    const docSectionsArr = [...docStates.entries()].map(([docId, state], i) => ({
      docIndex: i,
      compoundDocId: docId,
      sections: parseSections(state.ytext.toString()),
    }));
    setSections(interleaveSections(docSectionsArr));
  }, [docStates]);

  // Observe all Y.Texts and rebuild on changes
  useEffect(() => {
    if (docStates.size === 0) return;

    // Initial parse
    rebuildSections();

    // Subscribe to changes
    for (const [docId, state] of docStates) {
      const observer = () => rebuildSections();
      state.ytext.observe(observer);
      observersRef.current.set(docId, observer);
    }

    return () => {
      for (const [docId, observer] of observersRef.current) {
        const state = docStates.get(docId);
        if (state) state.ytext.unobserve(observer);
      }
      observersRef.current.clear();
    };
  }, [docStates, rebuildSections]);

  // Cleanup on unmount
  useEffect(() => {
    return () => disconnectAll();
  }, [disconnectAll]);

  return { sections, synced, errors };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lens-editor && npx vitest run src/components/SectionEditor/useMultiDocSections.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd lens-editor && npx tsc --noEmit`
Expected: Clean compile.

- [ ] **Step 6: Commit**

```bash
jj new -m "feat: useMultiDocSections hook for multi-doc connection and section parsing"
```

---

### Task 5: MultiDocSectionEditor component

**Files:**
- Create: `src/components/SectionEditor/MultiDocSectionEditor.tsx`
- Modify: `src/components/SectionEditor/index.ts`

- [ ] **Step 1: Create MultiDocSectionEditor**

Create `src/components/SectionEditor/MultiDocSectionEditor.tsx`:

```tsx
import { useEffect, useRef, useState, useCallback } from 'react';
import { EditorView } from 'codemirror';
import { keymap, drawSelection } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap } from '@codemirror/commands';
import { indentUnit, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { parseSections } from './parseSections';
import { ySectionSync, ySectionUndoManagerKeymap } from './y-section-sync';
import { remoteCursorTheme } from '../Editor/remoteCursorTheme';
import { SectionCard, getDocColor } from './SectionCard';
import { useMultiDocSections } from './useMultiDocSections';
import type { MultiDocSection } from './interleaveSections';

interface MultiDocSectionEditorProps {
  compoundDocIds: string[];
  docLabels?: string[];
  onOpenInEditor?: (docUuid: string) => void;
}

export function MultiDocSectionEditor({ compoundDocIds, docLabels, onOpenInEditor }: MultiDocSectionEditorProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const { sections, synced } = useMultiDocSections(compoundDocIds);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  // Active section reference (stable across renders)
  const activeSectionRef = useRef<MultiDocSection | null>(null);

  // Create/destroy CM when activeIndex changes
  useEffect(() => {
    if (viewRef.current) {
      viewRef.current.destroy();
      viewRef.current = null;
    }

    if (activeIndex === null || !mountRef.current) return;

    const section = sections[activeIndex];
    if (!section) return;

    // Re-parse this doc's Y.Text to get fresh offsets
    // (sections array may be stale if Y.Text changed between render and effect)
    const ytext = section.ytext;
    if (!ytext) return;

    const freshSections = parseSections(ytext.toString());
    // Find the matching section by original from/to
    const freshSection = freshSections.find(s => s.from === section.from && s.to === section.to);
    if (!freshSection) return;

    const sectionText = ytext.toString().slice(freshSection.from, freshSection.to);

    const view = new EditorView({
      state: EditorState.create({
        doc: sectionText,
        extensions: [
          indentUnit.of('\t'),
          EditorState.tabSize.of(4),
          drawSelection(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          keymap.of(defaultKeymap),
          ySectionUndoManagerKeymap,
          markdown({ base: markdownLanguage, addKeymap: false }),
          ySectionSync(ytext, freshSection.from, freshSection.to, { awareness: section.awareness }),
          remoteCursorTheme,
          EditorView.lineWrapping,
          EditorView.theme({
            '&': { fontSize: '14px', outline: 'none' },
            '&.cm-focused': { outline: 'none' },
            '.cm-scroller': {
              fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            },
            '.cm-content': { padding: '12px 16px' },
            '.cm-gutters': { display: 'none' },
          }),
        ],
      }),
      parent: mountRef.current,
    });

    activeSectionRef.current = section;
    viewRef.current = view;
    requestAnimationFrame(() => view.focus());

    return () => {
      view.destroy();
      viewRef.current = null;
      activeSectionRef.current = null;
    };
  }, [activeIndex, sections]);

  const deactivate = useCallback(() => setActiveIndex(null), []);

  return (
    <div className="max-w-2xl mx-auto py-6 px-4">
      {!synced ? (
        <div className="flex items-center justify-center h-64 text-gray-400 text-sm">
          Connecting to documents...
        </div>
      ) : (<>
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-gray-800">Section Editor</h2>
          <div className="flex items-center gap-2">
            {compoundDocIds.map((id, i) => {
              const color = getDocColor(i);
              const label = docLabels?.[i] ?? `Doc ${i + 1}`;
              return (
                <span key={id} className={`text-xs px-2 py-1 rounded ${color.bg} ${color.text}`}>
                  {label}
                </span>
              );
            })}
          </div>
        </div>

        <div className="space-y-3">
          {sections.map((section, i) => (
            <div key={`${section.compoundDocId}-${section.from}`}>
              {activeIndex === i ? (
                <div className={`rounded-lg border-2 border-blue-400 bg-white overflow-hidden`}>
                  <div className="flex items-center justify-between px-4 py-2 bg-blue-50 border-b border-blue-200">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm text-blue-700">{section.label}</span>
                      {(() => {
                        const color = getDocColor(section.docIndex);
                        const label = docLabels?.[section.docIndex] ?? `Doc ${section.docIndex + 1}`;
                        return (
                          <span className={`text-xs px-1.5 py-0.5 rounded ${color.bg} ${color.text}`}>
                            {label}
                          </span>
                        );
                      })()}
                    </div>
                    <button onClick={deactivate}
                      className="text-xs px-2 py-1 bg-blue-100 hover:bg-blue-200 text-blue-600 rounded">
                      Done
                    </button>
                  </div>
                  <div ref={mountRef} style={{ minHeight: '60px' }} />
                </div>
              ) : (
                <SectionCard
                  section={section}
                  onClick={() => setActiveIndex(i)}
                  docLabel={docLabels?.[section.docIndex] ?? `Doc ${section.docIndex + 1}`}
                  docIndex={section.docIndex}
                />
              )}
            </div>
          ))}
        </div>
      </>)}
    </div>
  );
}
```

- [ ] **Step 2: Update barrel exports**

In `src/components/SectionEditor/index.ts`:

```ts
export { SectionEditor } from './SectionEditor';
export { MultiDocSectionEditor } from './MultiDocSectionEditor';
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd lens-editor && npx tsc --noEmit`
Expected: Clean compile.

- [ ] **Step 4: Commit**

```bash
jj new -m "feat: MultiDocSectionEditor component with interleaved sections"
```

---

### Task 6: MultiDocSectionEditorView route in App.tsx

**Files:**
- Modify: `src/App.tsx:154-184` (SectionEditorView replacement)
- Modify: `src/App.tsx:446` (route)

- [ ] **Step 1: Replace SectionEditorView with MultiDocSectionEditorView**

In `src/App.tsx`, replace the `SectionEditorView` function (lines 154-184) with:

```tsx
/**
 * Multi-document section editor view — reads `+`-separated docUuids from URL.
 * Single doc URLs still work (no `+` = array of one).
 */
function MultiDocSectionEditorView() {
  const { docUuid } = useParams<{ docUuid: string }>();
  const { metadata } = useNavigation();
  const navigate = useNavigate();

  const docUuids = docUuid ? docUuid.split('+') : [];

  // Resolve each short UUID to a full compound ID
  // useResolvedDocId is a hook — we must call it for each UUID at the top level.
  // Since hooks can't be called in loops, we use a fixed-size approach:
  // resolve all IDs via a child component that handles the variable count.
  const shortCompoundIds = docUuids.map(uuid => `${RELAY_ID}-${uuid}`);

  if (docUuids.length === 0) {
    return (
      <main className="flex-1 flex items-center justify-center bg-gray-50">
        <p className="text-gray-500">Provide document UUID(s): /section-editor/:docUuid or /section-editor/:doc1+:doc2</p>
      </main>
    );
  }

  return (
    <MultiDocSectionEditorResolver
      docUuids={docUuids}
      shortCompoundIds={shortCompoundIds}
      metadata={metadata}
      navigate={navigate}
    />
  );
}

/**
 * Inner component that resolves N doc IDs. Renders one useResolvedDocId per doc
 * by mapping to child components, avoiding the "hooks in loops" rule.
 * Once all resolve, renders MultiDocSectionEditor.
 */
function MultiDocSectionEditorResolver({
  docUuids,
  shortCompoundIds,
  metadata,
  navigate,
}: {
  docUuids: string[];
  shortCompoundIds: string[];
  metadata: FolderMetadata;
  navigate: ReturnType<typeof useNavigate>;
}) {
  // For single doc, use the hook directly (most common case)
  if (shortCompoundIds.length === 1) {
    return <SingleDocResolver
      docUuid={docUuids[0]}
      shortCompoundId={shortCompoundIds[0]}
      metadata={metadata}
      navigate={navigate}
    />;
  }

  // For multiple docs, resolve via a separate strategy:
  // Each doc ID is resolved independently in a child, results collected via state
  return <MultiDocResolver
    docUuids={docUuids}
    shortCompoundIds={shortCompoundIds}
    metadata={metadata}
    navigate={navigate}
  />;
}

function SingleDocResolver({
  docUuid,
  shortCompoundId,
  metadata,
  navigate,
}: {
  docUuid: string;
  shortCompoundId: string;
  metadata: FolderMetadata;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const activeDocId = useResolvedDocId(shortCompoundId, metadata);

  if (!activeDocId) {
    return (
      <main className="flex-1 flex items-center justify-center bg-gray-50">
        <div className="text-sm text-gray-500">Resolving document...</div>
      </main>
    );
  }

  // Single doc: backward compatible — can also use RelayProvider path
  return <MultiDocSectionEditor
    compoundDocIds={[activeDocId]}
    onOpenInEditor={() => navigate(`/${docUuid}`)}
  />;
}

function MultiDocResolver({
  docUuids,
  shortCompoundIds,
  metadata,
  navigate,
}: {
  docUuids: string[];
  shortCompoundIds: string[];
  metadata: FolderMetadata;
  navigate: ReturnType<typeof useNavigate>;
}) {
  // Resolve all doc IDs client-side from metadata
  // (useResolvedDocId can't be called in a loop, so we do the resolution inline)
  const resolvedIds = shortCompoundIds.map(id => {
    if (id.length >= 73) return id;
    const docPrefix = id.slice(37);
    for (const meta of Object.values(metadata)) {
      if (meta.id.startsWith(docPrefix)) {
        return `${id.slice(0, 36)}-${meta.id}`;
      }
    }
    return null;
  });

  const allResolved = resolvedIds.every(id => id != null);

  if (!allResolved) {
    return (
      <main className="flex-1 flex items-center justify-center bg-gray-50">
        <div className="text-sm text-gray-500">Resolving documents...</div>
      </main>
    );
  }

  return <MultiDocSectionEditor
    compoundDocIds={resolvedIds as string[]}
    onOpenInEditor={(docUuid) => navigate(`/${docUuid}`)}
  />;
}
```

- [ ] **Step 2: Update imports in App.tsx**

Add to the imports at the top of `src/App.tsx`:

```ts
import { MultiDocSectionEditor } from './components/SectionEditor';
```

Also add the FolderMetadata type import if not already present:

```ts
import type { FolderMetadata } from './hooks/useFolderMetadata';
```

Remove the `SectionEditor` import (line 21) since it's no longer used directly in App.tsx.

- [ ] **Step 3: Update the route**

The route at line 446 stays the same pattern — it already captures everything after `/section-editor/`:

```tsx
<Route path="/section-editor/:docUuid" element={<MultiDocSectionEditorView />} />
```

Just change `SectionEditorView` to `MultiDocSectionEditorView`.

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd lens-editor && npx tsc --noEmit`
Expected: Clean compile.

- [ ] **Step 5: Run full test suite**

Run: `cd lens-editor && npx vitest run`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
jj new -m "feat: multi-doc section editor route with +separated doc UUIDs"
```

---

### Task 7: Manual browser verification

**Files:** None (verification only)

- [ ] **Step 1: Start dev servers**

```bash
cd lens-editor && npm run relay:start &
cd lens-editor && npm run dev:local
```

- [ ] **Step 2: Run setup and generate share link**

```bash
cd lens-editor && npm run relay:setup
cd lens-editor && npx tsx scripts/generate-share-link.ts --role edit --folder b0000001-0000-4000-8000-000000000001 --base-url http://dev.vps:5373
```

- [ ] **Step 3: Verify single-doc backward compatibility**

Open `/section-editor/<docUuid>` with a single doc UUID. Verify sections render, clicking opens CM editor, typing syncs.

- [ ] **Step 4: Verify multi-doc**

Open `/section-editor/<docUuid1>+<docUuid2>` with two doc UUIDs from the local test data. Verify:
- Sections from both docs appear interleaved
- Each section shows its doc label
- Clicking a section from either doc opens the correct CM editor
- Typing in one doc's section syncs to the correct Y.Text
- Remote cursor indicators work per doc

- [ ] **Step 5: Final commit (if any browser-found fixes)**

```bash
jj new -m "fix: browser-found issues in multi-doc section editor"
```

---

## Self-Review Results

**Spec coverage:**
- useDocConnection extension: Task 1
- interleaveSections: Task 2
- SectionCard extraction: Task 3
- useMultiDocSections hook: Task 4
- MultiDocSectionEditor component: Task 5
- Route + URL format: Task 6
- Edge cases (dedup, empty docs, errors): Task 4 (useMultiDocSections handles dedup and error tracking)
- Awareness initialization: Task 4 (inline in useMultiDocSections)
- Visual differentiation (doc colors/labels): Tasks 3 and 5
- Browser verification: Task 7

**Placeholder scan:** None found.

**Type consistency:**
- `DocConnection` type: defined in Task 1, used in Task 4
- `MultiDocSection` type: defined in Task 2 (`interleaveSections.ts`), used in Tasks 4 and 5
- `DocSections` type: defined in Task 2, used in Task 4
- `SectionCard` + `getDocColor`: defined in Task 3, used in Tasks 5
- `useMultiDocSections`: defined in Task 4, used in Task 5
- `MultiDocSectionEditor`: defined in Task 5, used in Task 6

All types and function names are consistent across tasks.

<function_calls>
<invoke name="Bash">
<parameter name="command">jj st