import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import * as Y from 'yjs';
import { RELAY_ID } from '../../App';
import { DisplayNameProvider } from '../../contexts/DisplayNameContext';
import { NavigationContext } from '../../contexts/NavigationContext';
import type { DocConnection } from '../../hooks/useDocConnection';
import { __embedDocsTesting } from '../../lib/embed-docs';
import { PENDING_QUESTIONS_ERROR, PENDING_REQUIREMENTS_ERROR } from '../../lib/idea-map';
import { createDocument } from '../../lib/relay-api';
import { useIdeaMap } from './useIdeaMap';

vi.mock('../../hooks/useDocConnection', () => ({
  connectDoc: vi.fn(),
  teardownProvider: vi.fn(),
}));
vi.mock('../../lib/relay-api', async (original) => ({
  ...(await original<typeof import('../../lib/relay-api')>()),
  createDocument: vi.fn(),
}));

const md = (id: string) => ({ id, type: 'markdown' as const, version: 0 });
const metadata = {
  '/Lens Edu/Context Accelerator LOs': { id: 'folder', type: 'folder' as const, version: 0 },
  '/Lens Edu/Context Accelerator LOs/_Template.md': md('template'),
  '/Lens Edu/Context Accelerator LOs/Instrumental convergence.md': md('ic'),
  '/Lens Edu/Context Accelerator LOs/Power-seeking.md': md('ps'),
  '/Lens Edu/Context Accelerator LOs/drafts/Half an idea.md': md('draft'),
  '/Lens Edu/Context Accelerator LOs (fake 150)/Wobbly teapot (fake 001).md': md('fake'),
  '/Lens Edu/Lenses/A lens.md': md('lens'),
};

const POWER = `---
id: 11111111-1111-4111-8111-111111111111
priority: high
---
Explain why power helps with most goals.

## Requires
- [[Instrumental convergence]]

## Why it matters
It is the core of the risk argument. %% keep this %%

## Learn
- Start with [[../Lenses/A lens|the first lens]] (11 minutes).
- [[../Lenses/Not there]]

## Questions
#### Question: Open
id:: 22222222-2222-4222-8222-222222222222
content:: Why?
`;
const texts: Record<string, string> = {
  ic: '---\nid: 33333333-3333-4333-8333-333333333333\npriority: high\n---\nExplain it.\n\n## Helpful first\n- [[Orthogonality thesis]]\n',
  ps: POWER,
  fake: '---\nid: 44444444-4444-4444-8444-444444444444\npriority: low\n---\nFake.\n',
};

function connection(text: string): DocConnection {
  const doc = new Y.Doc();
  doc.getText('contents').insert(0, text);
  const provider = { hasLocalChanges: false, on: () => {}, off: () => {} };
  return { doc, provider: provider as unknown as DocConnection['provider'] };
}

function renderMap(folder?: string) {
  const folderDoc = new Y.Doc();
  folderDoc.getMap('filemeta_v0').set('/Context Accelerator LOs', { id: 'folder', type: 'folder', version: 0 });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <DisplayNameProvider>
      <NavigationContext.Provider value={{
        metadata,
        folderDocs: new Map([['Lens Edu', folderDoc]]),
        folderNames: ['Lens Edu'],
        errors: new Map(),
        onNavigate: vi.fn(),
        justCreatedRef: { current: false },
      }}>
        {children}
      </NavigationContext.Provider>
    </DisplayNameProvider>
  );
  return { folderDoc, ...renderHook(() => useIdeaMap(folder), { wrapper }) };
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(createDocument).mockReset();
  __embedDocsTesting.reset();
  __embedDocsTesting.setReader(async (fullId) => {
    const text = texts[fullId.slice(RELAY_ID.length + 1)];
    if (text === undefined) throw new Error('no such doc');
    return text;
  });
});

describe('useIdeaMap', () => {
  it('reads the idea files directly in the folder, not _Template or subfolders', async () => {
    const { result } = renderMap();
    await waitFor(() => expect(result.current.read).toBe(2));
    expect(result.current.total).toBe(2);
    expect(result.current.ready).toBe(true);
    expect(result.current.graph.nodes.map((n) => n.name)).toEqual(['Instrumental convergence', 'Orthogonality thesis', 'Power-seeking']);
    expect(result.current.fileNames).toEqual(['_Template', 'Instrumental convergence', 'Power-seeking']);
    expect(result.current.folderPath).toBe('/Lens Edu/Context Accelerator LOs');
  });

  it('lists the test folders next to the real one, and reads the one asked for', async () => {
    const { result } = renderMap('Context Accelerator LOs (fake 150)');
    await waitFor(() => expect(result.current.read).toBe(1));
    expect(result.current.folders).toEqual(['Context Accelerator LOs', 'Context Accelerator LOs (fake 150)']);
    expect(result.current.graph.nodes.map((n) => n.name)).toEqual(['Wobbly teapot (fake 001)']);
  });

  it('finds the file of a Learn link and reports a lens that has none', async () => {
    const { result } = renderMap();
    await waitFor(() => expect(result.current.read).toBe(2));
    expect(result.current.lensDoc('../Lenses/A lens')).toBe('lens');
    expect(result.current.lensDoc('../Lenses/Not there')).toBeNull();
    const problems = result.current.graph.byKey.get('power-seeking')!.problems.map((p) => p.text);
    expect(problems).toContain('Lens not found: Not there');
  });

  it('marks a file that cannot be read instead of dropping it', async () => {
    __embedDocsTesting.setReader(async () => { throw new Error('offline'); });
    const { result } = renderMap();
    await waitFor(() => expect(result.current.read).toBe(2));
    expect(result.current.graph.byKey.get('power-seeking')!.problems.map((p) => p.kind)).toEqual(['unread']);
  });

  describe('saveRequirements', () => {
    it('changes only the lines under Requires and Helpful first of the live file', async () => {
      // Someone else added a requirement and edited a sentence after the form opened
      const liveText = POWER
        .replace('- [[Instrumental convergence]]\n', '- [[Instrumental convergence]]\n- [[Added by someone else]]\n')
        .replace('most goals', 'nearly all goals');
      const live = connection(liveText);
      __embedDocsTesting.setConnector(async () => live);
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));

      let failed: string | null = 'not run';
      await act(async () => {
        failed = await result.current.saveRequirements(
          'power-seeking',
          { requires: ['Instrumental convergence'], helpful: [] },
          { requires: ['Goal-directedness'], helpful: ['Orthogonality thesis'] },
        );
      });

      expect(failed).toBeNull();
      expect(live.doc.getText('contents').toString()).toBe(liveText.replace(
        '## Requires\n- [[Instrumental convergence]]\n- [[Added by someone else]]\n',
        '## Requires\n- [[Added by someone else]]\n- [[Goal-directedness]]\n\n## Helpful first\n- [[Orthogonality thesis]]\n',
      ));
      // The map shows the saved text without waiting for the next read
      await waitFor(() => expect(result.current.graph.byKey.get('power-seeking')!.requires).toEqual(['added by someone else', 'goal-directedness']));
    });

    it('writes nothing and says why when the lines hold a pending suggestion', async () => {
      const liveText = POWER.replace('- [[Instrumental convergence]]\n', '- [[Instrumental convergence]]\n{++- [[Suggested]]\n++}');
      const live = connection(liveText);
      __embedDocsTesting.setConnector(async () => live);
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));

      let failed: string | null = null;
      await act(async () => {
        failed = await result.current.saveRequirements('power-seeking', { requires: ['Instrumental convergence'], helpful: [] }, { requires: [], helpful: [] });
      });

      expect(failed).toBe(PENDING_REQUIREMENTS_ERROR);
      expect(live.doc.getText('contents').toString()).toBe(liveText);
    });

    it('refuses an idea that has no file', async () => {
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));
      expect(await result.current.saveRequirements('orthogonality thesis', { requires: [], helpful: [] }, { requires: ['Power-seeking'], helpful: [] }))
        .toBe('This concept has no file yet.');
    });
  });

  describe('addQuestion', () => {
    it('appends a typed question with a fresh id to the live file, and nothing else', async () => {
      const liveText = POWER.replace('most goals', 'nearly all goals');
      const live = connection(liveText);
      __embedDocsTesting.setConnector(async () => live);
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));

      let failed: string | null = 'not run';
      await act(async () => {
        failed = await result.current.addQuestion('power-seeking', {
          type: 'Choice',
          content: 'Which helps with most goals?',
          options: [{ text: 'Power', correct: true }, { text: 'Rest', correct: false }],
        });
      });

      expect(failed).toBeNull();
      const text = live.doc.getText('contents').toString();
      expect(text.startsWith(liveText)).toBe(true);
      expect(text.slice(liveText.length)).toMatch(new RegExp([
        '^',
        '#### Question: Choice',
        'id:: [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',
        'content:: Which helps with most goals\\?',
        'options::',
        '- \\[x\\] Power',
        '- \\[ \\] Rest',
        'shuffle:: true',
        '$',
      ].join('\n')));
      // The panel lists it without waiting for the next read
      await waitFor(() => expect(result.current.graph.byKey.get('power-seeking')!.idea!.questionList).toEqual([
        { type: 'Open', content: 'Why?' },
        { type: 'Choice', content: 'Which helps with most goals?' },
      ]));
    });

    it('writes nothing and says why for a question that cannot be added', async () => {
      const live = connection(POWER);
      __embedDocsTesting.setConnector(async () => live);
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));
      expect(await result.current.addQuestion('power-seeking', { type: 'Open', content: ' ' })).toBe('Write the question.');
      expect(live.doc.getText('contents').toString()).toBe(POWER);
    });

    it('writes nothing while the questions hold a pending suggestion', async () => {
      const liveText = `${POWER}{++more++}\n`;
      const live = connection(liveText);
      __embedDocsTesting.setConnector(async () => live);
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));
      let failed: string | null = null;
      await act(async () => {
        failed = await result.current.addQuestion('power-seeking', { type: 'Open', content: 'Why?' });
      });
      expect(failed).toBe(PENDING_QUESTIONS_ERROR);
      expect(live.doc.getText('contents').toString()).toBe(liveText);
    });
  });

  describe('createIdea', () => {
    const idea = { name: ' Goal-directedness ', priority: 'low' as const, outcome: 'Say what a goal is.', why: '', requires: ['Power-seeking'], helpful: [] };

    it('creates the file in the folder through createDocument, in the spec format', async () => {
      vi.mocked(createDocument).mockImplementation(async (_folderDoc, _path, _type, text) => {
        texts.created = text!;
        return 'created';
      });
      const { result, folderDoc } = renderMap();
      await act(async () => { await result.current.createIdea(idea); });

      expect(createDocument).toHaveBeenCalledTimes(1);
      const [doc, path, type, text] = vi.mocked(createDocument).mock.calls[0];
      expect(doc).toBe(folderDoc);
      expect(path).toBe('/Context Accelerator LOs/Goal-directedness.md');
      expect(type).toBe('markdown');
      expect(text).toMatch(new RegExp([
        '^---',
        'id: [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',
        'priority: low',
        'courses:',
        '  - "\\[\\[\\.\\./courses/in-development/Context Accelerator\\]\\]"',
        '---',
        'Say what a goal is\\.',
        '',
        '## Requires',
        '- \\[\\[Power-seeking\\]\\]',
        '',
        '## Helpful first',
        '',
        '## Why it matters',
        '',
        '## Learn',
        '',
        '## Questions',
        '$',
      ].join('\n')));
      // The folder is there already: it is not created again
      expect(folderDoc.getMap('filemeta_v0').size).toBe(1);
    });

    it('makes the folder first when it does not exist yet', async () => {
      vi.mocked(createDocument).mockImplementation(async (_folderDoc, _path, _type, text) => {
        texts.created = text!;
        return 'created';
      });
      const { result, folderDoc } = renderMap('Context Accelerator LOs (new set)');
      await act(async () => { await result.current.createIdea(idea); });
      expect(folderDoc.getMap<{ type: string }>('filemeta_v0').get('/Context Accelerator LOs (new set)')?.type).toBe('folder');
      expect(vi.mocked(createDocument).mock.calls[0][1]).toBe('/Context Accelerator LOs (new set)/Goal-directedness.md');
    });

    it('fails when the text of the new file did not arrive', async () => {
      vi.mocked(createDocument).mockImplementation(async () => {
        texts.created = '';
        return 'created';
      });
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));
      await act(async () => {
        await expect(result.current.createIdea(idea)).rejects.toThrow('its text was not written');
      });
    });
  });
});
