import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import * as Y from 'yjs';
import { RELAY_ID } from '../../App';
import { DisplayNameProvider } from '../../contexts/DisplayNameContext';
import { NavigationContext } from '../../contexts/NavigationContext';
import type { DocConnection } from '../../hooks/useDocConnection';
import { __embedDocsTesting } from '../../lib/embed-docs';
import {
  IDEA_MOVED_ERROR,
  PENDING_QUESTIONS_ERROR,
  PENDING_REQUIREMENTS_ERROR,
  QUESTION_MOVED_ERROR,
  ideaAsEdit,
  parseIdea,
} from '../../lib/idea-map';
import { RelayApiError, TrashRefusedError, createDocument, movePath, trashPath } from '../../lib/relay-api';
import { useIdeaMap } from './useIdeaMap';

vi.mock('../../hooks/useDocConnection', () => ({
  connectDoc: vi.fn(),
  teardownProvider: vi.fn(),
}));
vi.mock('../../lib/relay-api', async (original) => ({
  ...(await original<typeof import('../../lib/relay-api')>()),
  createDocument: vi.fn(),
  movePath: vi.fn(),
  trashPath: vi.fn(),
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

## Lenses
- Start with [[../Lenses/A lens|the first lens]] (11 minutes).
- [[../Lenses/Not there]]

## Tests
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
  vi.mocked(movePath).mockReset();
  vi.mocked(trashPath).mockReset();
  __embedDocsTesting.reset();
  __embedDocsTesting.setReader(async (fullId) => {
    const text = texts[fullId.slice(RELAY_ID.length + 1)];
    if (text === undefined) throw new Error('no such doc');
    return text;
  });
});

describe('useIdeaMap', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('reads the idea files directly in the folder, not _Template or subfolders', async () => {
    const { result } = renderMap();
    await waitFor(() => expect(result.current.read).toBe(2));
    expect(result.current.total).toBe(2);
    expect(result.current.ready).toBe(true);
    expect(result.current.graph.nodes.map((n) => n.name)).toEqual(['Instrumental convergence', 'Orthogonality thesis', 'Power-seeking']);
    expect(result.current.fileNames).toEqual(['_Template', 'Instrumental convergence', 'Power-seeking']);
    expect(result.current.folderPath).toBe('/Lens Edu/Context Accelerator LOs');
  });

  it('on a local relay lists the test folders next to the real one, and reads the one asked for', async () => {
    vi.stubEnv('VITE_LOCAL_RELAY', 'true');
    const { result } = renderMap('Context Accelerator LOs (fake 150)');
    await waitFor(() => expect(result.current.read).toBe(1));
    expect(result.current.folders).toEqual(['Context Accelerator LOs', 'Context Accelerator LOs (fake 150)']);
    expect(result.current.graph.nodes.map((n) => n.name)).toEqual(['Wobbly teapot (fake 001)']);
  });

  it('anywhere else knows the real folder only, whatever folder is asked for', async () => {
    const { result } = renderMap('Context Accelerator LOs (fake 150)');
    await waitFor(() => expect(result.current.read).toBe(2));
    expect(result.current.folders).toEqual(['Context Accelerator LOs']);
    expect(result.current.folderPath).toBe('/Lens Edu/Context Accelerator LOs');
    expect(result.current.graph.nodes.map((n) => n.name)).toEqual(['Instrumental convergence', 'Orthogonality thesis', 'Power-seeking']);
  });

  it('finds the file of a link under Lenses and reports a lens that has none', async () => {
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
    it('says so, and does not throw, when the file cannot be opened for writing', async () => {
      __embedDocsTesting.setConnector(async () => { throw new Error('Connection timeout'); });
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));
      let failed: string | null = 'not run';
      await act(async () => {
        failed = await result.current.saveRequirements('power-seeking', { requires: ['Instrumental convergence'], helpful: [] }, { requires: [], helpful: [] });
      });
      expect(failed).toMatch(/could not be opened for writing \(Connection timeout\)/);
    });

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
        // A wrong answer has no box: the platform takes "- [ ]" for a mistake
        '- Rest',
        'shuffle:: true',
        '$',
      ].join('\n')));
      // The panel lists it without waiting for the next read
      await waitFor(() => expect(result.current.graph.byKey.get('power-seeking')!.idea!.questionList).toEqual([
        expect.objectContaining({ type: 'Open', content: 'Why?' }),
        expect.objectContaining({ type: 'Choice', content: 'Which helps with most goals?', other: [{ name: 'shuffle', value: 'true' }] }),
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

  describe('editQuestion and deleteQuestion', () => {
    const TWO = `${POWER}\n#### Question: Choice\nid:: c\ncontent:: Which?\noptions::\n- [x] A\n- B\n`;
    const open = (text: string) => parseIdea(text).questionList[0];

    it('rewrites only the changed field of the question in the live file', async () => {
      // Someone edited a sentence elsewhere after the form opened
      const liveText = TWO.replace('most goals', 'nearly all goals');
      const live = connection(liveText);
      __embedDocsTesting.setConnector(async () => live);
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));
      let failed: string | null = 'not run';
      await act(async () => {
        failed = await result.current.editQuestion('power-seeking', 0, open(POWER), { type: 'Open', content: 'Why?', assessment: '- 60: a\n- 40: b', other: [] });
      });
      expect(failed).toBeNull();
      expect(live.doc.getText('contents').toString()).toBe(liveText.replace('content:: Why?\n', 'content:: Why?\nassessment-instructions::\n- 60: a\n- 40: b\n'));
      await waitFor(() => expect(result.current.graph.byKey.get('power-seeking')!.idea!.questionList[0].assessment).toBe('- 60: a\n- 40: b'));
    });

    it('writes nothing when the question is no longer what the form was opened with', async () => {
      const liveText = TWO.replace('content:: Why?', 'content:: Why not?');
      const live = connection(liveText);
      __embedDocsTesting.setConnector(async () => live);
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));
      expect(await result.current.editQuestion('power-seeking', 0, open(POWER), { type: 'Open', content: 'Why so?' })).toBe(QUESTION_MOVED_ERROR);
      expect(await result.current.deleteQuestion('power-seeking', 0, open(POWER))).toBe(QUESTION_MOVED_ERROR);
      expect(live.doc.getText('contents').toString()).toBe(liveText);
    });

    it('takes one question out of the live file', async () => {
      const live = connection(TWO);
      __embedDocsTesting.setConnector(async () => live);
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));
      let failed: string | null = 'not run';
      await act(async () => {
        failed = await result.current.deleteQuestion('power-seeking', 1, parseIdea(TWO).questionList[1]);
      });
      expect(failed).toBeNull();
      expect(live.doc.getText('contents').toString()).toBe(POWER);
    });
  });

  describe('editIdea', () => {
    const before = ideaAsEdit('Power-seeking', parseIdea(POWER));
    /** A live doc per file, as the relay has them. */
    const liveDocs = (overrides: Record<string, string> = {}) => {
      const docs = new Map<string, DocConnection>();
      __embedDocsTesting.setConnector(async (fullId) => {
        const id = fullId.slice(RELAY_ID.length + 1);
        if (!docs.has(id)) docs.set(id, connection(overrides[id] ?? texts[id]));
        return docs.get(id)!;
      });
      return (id: string) => docs.get(id)?.doc.getText('contents').toString();
    };

    it('writes only the parts that changed into the live file, and renames nothing', async () => {
      // A question was added in the file after the form opened: not this form's part
      const liveText = `${POWER}\n#### Question: Open\ncontent:: Another?\n`;
      const text = liveDocs({ ps: liveText });
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));
      let failed: string | null = 'not run';
      await act(async () => {
        failed = await result.current.editIdea('power-seeking', before, {
          ...before,
          priority: 'low',
          outcome: 'Explain it.\nIn two lines.',
          courses: ['../courses/A'],
          // Itself is never its own requirement
          requires: ['Instrumental convergence', 'power-seeking', 'Goals'],
        });
      });
      expect(failed).toBeNull();
      expect(text('ps')).toBe(liveText
        .replace('priority: high\n', 'priority: low\ncourses:\n  - "[[../courses/A]]"\n')
        .replace('Explain why power helps with most goals.', 'Explain it.\nIn two lines.')
        .replace('- [[Instrumental convergence]]\n', '- [[Instrumental convergence]]\n- [[Goals]]\n'));
      expect(movePath).not.toHaveBeenCalled();
      await waitFor(() => expect(result.current.graph.byKey.get('power-seeking')!.idea!.priority).toBe('low'));
    });

    it('writes the topic line into the live file, and takes it out again', async () => {
      const text = liveDocs();
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));
      await act(async () => {
        expect(await result.current.editIdea('power-seeking', before, { ...before, topic: 'AI: risk' })).toBeNull();
      });
      const withTopic = POWER.replace('priority: high\n', 'priority: high\ntopic: "AI: risk"\n');
      expect(text('ps')).toBe(withTopic);
      await waitFor(() => expect(result.current.graph.byKey.get('power-seeking')!.idea!.topic).toBe('AI: risk'));
      await act(async () => {
        expect(await result.current.editIdea('power-seeking', { ...before, topic: 'AI: risk' }, before)).toBeNull();
      });
      expect(text('ps')).toBe(POWER);
    });

    it('writes nothing when the file no longer says what the form was opened with', async () => {
      const liveText = POWER.replace('most goals', 'nearly all goals');
      const text = liveDocs({ ps: liveText });
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));
      expect(await result.current.editIdea('power-seeking', before, { ...before, name: 'Power', priority: 'low' })).toBe(IDEA_MOVED_ERROR);
      expect(text('ps')).toBe(liveText);
      expect(movePath).not.toHaveBeenCalled();
    });

    it('refuses a part that holds a comment, and a name another file has', async () => {
      const text = liveDocs();
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));
      expect(await result.current.editIdea('power-seeking', before, { ...before, why: 'New.' })).toMatch(/^"Why it matters" of this file has a pending suggestion or a comment/);
      expect(await result.current.editIdea('power-seeking', before, { ...before, name: 'instrumental Convergence', priority: 'low' })).toBe('A file with this name already exists.');
      expect(await result.current.editIdea('power-seeking', before, { ...before, name: '_Template' })).toBe('A name cannot start with _ or a dot.');
      expect(text('ps') ?? POWER).toBe(POWER);
      expect(movePath).not.toHaveBeenCalled();
      expect(await result.current.editIdea('orthogonality thesis', before, before)).toBe('This concept has no file yet.');
    });

    it('renames the file through the relay move, after the other changes, and rewrites the links the relay left', async () => {
      const text = liveDocs();
      vi.mocked(movePath).mockResolvedValue({} as Awaited<ReturnType<typeof movePath>>);
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));
      const convergence = ideaAsEdit('Instrumental convergence', parseIdea(texts.ic));
      let failed: string | null = 'not run';
      await act(async () => {
        failed = await result.current.editIdea('instrumental convergence', convergence, { ...convergence, name: ' Convergence ', priority: 'low' });
      });
      expect(failed).toBeNull();
      expect(movePath).toHaveBeenCalledWith('Lens Edu/Context Accelerator LOs/Instrumental convergence.md', '/Context Accelerator LOs/Convergence.md');
      expect(text('ic')).toBe(texts.ic.replace('priority: high', 'priority: low'));
      // This relay did not rewrite the link in the file that requires it
      expect(text('ps')).toBe(POWER.replace('- [[Instrumental convergence]]', '- [[Convergence]]'));
    });

    it('rewrites the links the relay left in a file that has Helpful first before Requires', async () => {
      const turned = '---\nid: 11111111-1111-4111-8111-111111111111\npriority: high\n---\nExplain it.\n\n## Helpful first\n- [[Instrumental convergence]]\n- [[Kept]]\n\n## Requires\n- [[Instrumental convergence]]\n- [[Other]]\n';
      texts.ps = turned;
      try {
        const text = liveDocs();
        vi.mocked(movePath).mockResolvedValue({} as Awaited<ReturnType<typeof movePath>>);
        const { result } = renderMap();
        await waitFor(() => expect(result.current.read).toBe(2));
        const convergence = ideaAsEdit('Instrumental convergence', parseIdea(texts.ic));
        let failed: string | null = 'not run';
        await act(async () => {
          failed = await result.current.editIdea('instrumental convergence', convergence, { ...convergence, name: 'A much longer name for convergence' });
        });
        expect(failed).toBeNull();
        expect(text('ps')).toBe(turned.replaceAll('[[Instrumental convergence]]', '[[A much longer name for convergence]]'));
      } finally {
        texts.ps = POWER;
      }
    });

    it('leaves a link alone that the relay rewrote already', async () => {
      const text = liveDocs();
      vi.mocked(movePath).mockImplementation(async () => {
        texts.ps = POWER.replace('- [[Instrumental convergence]]', '- [[Convergence]]');
        return {} as Awaited<ReturnType<typeof movePath>>;
      });
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));
      const convergence = ideaAsEdit('Instrumental convergence', parseIdea(texts.ic));
      try {
        let failed: string | null = 'not run';
        await act(async () => {
          failed = await result.current.editIdea('instrumental convergence', convergence, { ...convergence, name: 'Convergence' });
        });
        expect(failed).toBeNull();
        // Not opened for editing at all
        expect(text('ps')).toBeUndefined();
        await waitFor(() => expect(result.current.graph.byKey.get('power-seeking')!.requires).toEqual(['convergence']));
      } finally {
        texts.ps = POWER;
      }
    });

    it('says that the other changes are saved when the rename fails', async () => {
      const text = liveDocs();
      vi.mocked(movePath).mockRejectedValue(new RelayApiError('conflict', 409));
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));
      let failed: string | null = null;
      await act(async () => {
        failed = await result.current.editIdea('power-seeking', before, { ...before, name: 'Power', priority: 'low' });
      });
      expect(failed).toBe('The other changes are saved, but the rename failed: "Power.md" or "Power.html" already exists: a .md and a .html file cannot share a name. Close this form and open it again.');
      expect(text('ps')).toBe(POWER.replace('priority: high', 'priority: low'));
    });

    describe('Needed for and Helpful for', () => {
      // Power-seeking requires Instrumental convergence: the map says so, not its own file
      const convergence = ideaAsEdit('Instrumental convergence', parseIdea(texts.ic), { neededFor: ['Power-seeking'], helpfulFor: [] });
      const PENDING = POWER.replace('- [[Instrumental convergence]]', '- [[Instrumental convergence]]{++ (soon)++}');

      it('takes the idea out of the Requires of an idea it is no longer needed for, and saves its own changes', async () => {
        const text = liveDocs();
        const { result } = renderMap();
        await waitFor(() => expect(result.current.read).toBe(2));
        let failed: string | null = 'not run';
        await act(async () => {
          failed = await result.current.editIdea('instrumental convergence', convergence, { ...convergence, priority: 'low', neededFor: [] });
        });
        expect(failed).toBeNull();
        expect(text('ic')).toBe(texts.ic.replace('priority: high', 'priority: low'));
        expect(text('ps')).toBe(POWER.replace('- [[Instrumental convergence]]\n', ''));
        expect(movePath).not.toHaveBeenCalled();
        // The panel shows it at once
        await waitFor(() => expect(result.current.graph.byKey.get('instrumental convergence')!.neededFor).toEqual([]));
      });

      it('moves the idea to the Helpful first of an idea it is now only helpful for', async () => {
        const text = liveDocs();
        const { result } = renderMap();
        await waitFor(() => expect(result.current.read).toBe(2));
        await act(async () => {
          expect(await result.current.editIdea('instrumental convergence', convergence, { ...convergence, neededFor: [], helpfulFor: ['power-seeking'] })).toBeNull();
        });
        // Its own file had nothing to change
        expect(text('ic')).toBe(texts.ic);
        expect(parseIdea(text('ps')!)).toMatchObject({ requires: [], helpful: ['Instrumental convergence'], why: parseIdea(POWER).why, questions: parseIdea(POWER).questions });
        await waitFor(() => expect(result.current.graph.byKey.get('instrumental convergence')!.helpfulFor).toEqual(['power-seeking']));
      });

      it('turns a requirement around: out of its own Requires, into the Requires of the other', async () => {
        const text = liveDocs();
        const { result } = renderMap();
        await waitFor(() => expect(result.current.read).toBe(2));
        await act(async () => {
          expect(await result.current.editIdea('power-seeking', before, { ...before, requires: [], neededFor: ['Instrumental convergence'] })).toBeNull();
        });
        expect(text('ps')).toBe(POWER.replace('- [[Instrumental convergence]]\n', ''));
        // The heading is added, above Helpful first as in a new file
        expect(text('ic')).toBe(texts.ic.replace('## Helpful first', '## Requires\n- [[Power-seeking]]\n\n## Helpful first'));
        await waitFor(() => expect(result.current.graph.byKey.get('power-seeking')!.neededFor).toEqual(['instrumental convergence']));
      });

      it('checks everything before the first write: a circle, an idea with no file, a file that cannot change', async () => {
        const text = liveDocs();
        const { result } = renderMap();
        await waitFor(() => expect(result.current.read).toBe(2));
        expect(await result.current.editIdea('power-seeking', before, { ...before, priority: 'low', neededFor: ['Instrumental convergence'] }))
          .toBe('Nothing was saved. This makes a circle of requirements: Power-seeking → Instrumental convergence → Power-seeking');
        expect(await result.current.editIdea('power-seeking', before, { ...before, priority: 'low', helpfulFor: ['Orthogonality thesis'] }))
          .toBe('Nothing was saved. "Orthogonality thesis" is not written yet, so it has no file to put the link in. Write that concept first, or add this one to its Requires later.');
        expect(await result.current.editIdea('power-seeking', before, { ...before, priority: 'low', neededFor: ['Instrumental convergence'], helpfulFor: ['instrumental convergence'] }))
          .toBe('Nothing was saved. "instrumental convergence" is under both Needed for and Helpful for. Take it out of one.');
        // Its own file cannot take the change: the other file is not written either
        expect(await result.current.editIdea('power-seeking', before, { ...before, why: 'New.', requires: [], neededFor: ['Instrumental convergence'] }))
          .toMatch(/^"Why it matters" of this file has a pending suggestion or a comment/);
        expect(text('ps') ?? POWER).toBe(POWER);
        expect(text('ic')).toBeUndefined();
      });

      it('saves nothing when the file of the other idea holds a pending suggestion where the link goes', async () => {
        texts.ps = PENDING;
        try {
          const text = liveDocs();
          const { result } = renderMap();
          await waitFor(() => expect(result.current.read).toBe(2));
          expect(await result.current.editIdea('instrumental convergence', convergence, { ...convergence, priority: 'low', neededFor: [] }))
            .toBe(`Nothing was saved. In "Power-seeking": ${PENDING_REQUIREMENTS_ERROR}`);
          expect(text('ic')).toBeUndefined();
        } finally {
          texts.ps = POWER;
        }
      });

      it('says what is saved and what is not when a file changed under it', async () => {
        // The suggestion came after the map read the file
        const text = liveDocs({ ps: PENDING });
        const { result } = renderMap();
        await waitFor(() => expect(result.current.read).toBe(2));
        let failed: string | null = null;
        await act(async () => {
          failed = await result.current.editIdea('instrumental convergence', convergence, { ...convergence, priority: 'low', neededFor: [] });
        });
        expect(failed).toBe(`The concept's own changes are saved. Not changed: Power-seeking. In "Power-seeking": ${PENDING_REQUIREMENTS_ERROR} Close this form and open it again.`);
        expect(text('ic')).toBe(texts.ic.replace('priority: high', 'priority: low'));
        expect(text('ps')).toBe(PENDING);
      });

      it('writes the links under the new name when the idea is renamed in the same save', async () => {
        const text = liveDocs();
        vi.mocked(movePath).mockResolvedValue({} as Awaited<ReturnType<typeof movePath>>);
        const { result } = renderMap();
        await waitFor(() => expect(result.current.read).toBe(2));
        let failed: string | null = 'not run';
        await act(async () => {
          failed = await result.current.editIdea('instrumental convergence', convergence, { ...convergence, name: 'Convergence', neededFor: [], helpfulFor: ['Power-seeking'] });
        });
        expect(failed).toBeNull();
        expect(movePath).toHaveBeenCalledTimes(1);
        expect(parseIdea(text('ps')!)).toMatchObject({ requires: [], helpful: ['Convergence'] });
        expect(text('ps')).not.toContain('Instrumental convergence');
      });

      it('leaves the other files alone when the rename fails', async () => {
        const text = liveDocs();
        vi.mocked(movePath).mockRejectedValue(new RelayApiError('conflict', 409));
        const { result } = renderMap();
        await waitFor(() => expect(result.current.read).toBe(2));
        let failed: string | null = null;
        await act(async () => {
          failed = await result.current.editIdea('instrumental convergence', convergence, { ...convergence, name: 'Convergence', priority: 'low', neededFor: [] });
        });
        expect(failed).toMatch(/^The other changes are saved, but the rename failed: .* Needed for and Helpful for are not changed either\. Close this form and open it again\.$/);
        expect(text('ic')).toBe(texts.ic.replace('priority: high', 'priority: low'));
        expect(text('ps')).toBeUndefined();
      });
    });
  });

  describe('deleteIdea', () => {
    const liveDocs = (overrides: Record<string, string> = {}) => {
      const docs = new Map<string, DocConnection>();
      __embedDocsTesting.setConnector(async (fullId) => {
        const id = fullId.slice(RELAY_ID.length + 1);
        if (!docs.has(id)) docs.set(id, connection(overrides[id] ?? texts[id]));
        return docs.get(id)!;
      });
      return (id: string) => docs.get(id)?.doc.getText('contents').toString();
    };
    const IC = 'Lens Edu/Context Accelerator LOs/Instrumental convergence.md';
    const PS = 'Lens Edu/Context Accelerator LOs/Power-seeking.md';
    const trashed = {} as Awaited<ReturnType<typeof trashPath>>;

    it('moves a file nothing links to into the trash', async () => {
      const text = liveDocs();
      vi.mocked(trashPath).mockResolvedValue(trashed);
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));
      expect(await result.current.deleteIdea('power-seeking')).toBeNull();
      expect(vi.mocked(trashPath).mock.calls).toEqual([[PS]]);
      expect(text('ic')).toBeUndefined();
      expect(result.current.deleteNote).toBe('The file moves to the trash (Lens Edu/_trash). It can be moved back from there until the relay empties the trash (after 10 days, unless it is set otherwise).');
    });

    it('takes its links out of the ideas that list it, then deletes the file', async () => {
      const text = liveDocs();
      vi.mocked(trashPath)
        .mockRejectedValueOnce(new TrashRefusedError('linked', [{ path: PS, count: 1 }]))
        .mockResolvedValue(trashed);
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));
      let failed: string | null = 'not run';
      await act(async () => {
        failed = await result.current.deleteIdea('instrumental convergence');
      });
      expect(failed).toBeNull();
      expect(text('ps')).toBe(POWER.replace('- [[Instrumental convergence]]\n', ''));
      // Asked first without force, so that the relay names what links to it
      expect(vi.mocked(trashPath).mock.calls).toEqual([[IC], [IC, true]]);
      await waitFor(() => expect(result.current.graph.byKey.get('power-seeking')!.requires).toEqual([]));
    });

    it('changes nothing when a file outside the map links to it', async () => {
      const text = liveDocs();
      vi.mocked(trashPath).mockRejectedValue(new TrashRefusedError('linked', [{ path: PS, count: 1 }, { path: 'Lens Edu/courses/A course.md', count: 2 }]));
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));
      expect(await result.current.deleteIdea('instrumental convergence'))
        .toBe('Nothing was deleted: Lens Edu/courses/A course.md links to this concept too. Take that link out first, or delete the file in the file tree.');
      expect(text('ps')).toBeUndefined();
      expect(trashPath).toHaveBeenCalledTimes(1);
    });

    // Prevents: a folder-limited key's refusal that names no documents (the
    // ones linking in are all in other folders, so only counted) being read
    // as "only the map links here", the links taken out and the file forced.
    it('changes nothing when only documents in other folders link to it', async () => {
      liveDocs();
      vi.mocked(trashPath).mockRejectedValue(new TrashRefusedError('linked', [], 2));
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));
      expect(await result.current.deleteIdea('power-seeking'))
        .toBe('Nothing was deleted: 2 documents in other folders link to this concept too. Take that link out first, or delete the file in the file tree.');
      expect(vi.mocked(trashPath).mock.calls).toEqual([[PS]]);
    });

    it('changes nothing when the map and one document in another folder link to it', async () => {
      const text = liveDocs();
      vi.mocked(trashPath).mockRejectedValue(new TrashRefusedError('linked', [{ path: PS, count: 1 }], 1));
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));
      expect(await result.current.deleteIdea('instrumental convergence'))
        .toBe('Nothing was deleted: 1 document in other folders links to this concept too. Take that link out first, or delete the file in the file tree.');
      // Power-seeking keeps its link and nothing is forced
      expect(text('ps')).toBeUndefined();
      expect(vi.mocked(trashPath).mock.calls).toEqual([[IC]]);
    });

    it('names the documents it can see and counts the ones in other folders', async () => {
      liveDocs();
      vi.mocked(trashPath).mockRejectedValue(new TrashRefusedError('linked', [{ path: 'Lens Edu/courses/A course.md', count: 2 }], 3));
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));
      expect(await result.current.deleteIdea('instrumental convergence'))
        .toBe('Nothing was deleted: Lens Edu/courses/A course.md and 3 documents in other folders link to this concept too. Take that link out first, or delete the file in the file tree.');
      expect(trashPath).toHaveBeenCalledTimes(1);
    });

    it('with a count of 0 from other folders still takes its links out and deletes', async () => {
      const text = liveDocs();
      vi.mocked(trashPath)
        .mockRejectedValueOnce(new TrashRefusedError('linked', [{ path: PS, count: 1 }], 0))
        .mockResolvedValue(trashed);
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));
      let failed: string | null = 'not run';
      await act(async () => {
        failed = await result.current.deleteIdea('instrumental convergence');
      });
      expect(failed).toBeNull();
      expect(text('ps')).toBe(POWER.replace('- [[Instrumental convergence]]\n', ''));
      expect(vi.mocked(trashPath).mock.calls).toEqual([[IC], [IC, true]]);
    });

    it('changes nothing when its link in another idea sits beside a pending suggestion', async () => {
      const suggested = POWER.replace('- [[Instrumental convergence]]\n', '- [[Instrumental convergence]]\n{++- [[Suggested]]\n++}');
      texts.ps = suggested;
      try {
        const text = liveDocs();
        const { result } = renderMap();
        await waitFor(() => expect(result.current.read).toBe(2));
        expect(await result.current.deleteIdea('instrumental convergence')).toBe(`Nothing was deleted. In "Power-seeking": ${PENDING_REQUIREMENTS_ERROR}`);
        expect(trashPath).not.toHaveBeenCalled();
        expect(text('ps')).toBeUndefined();
      } finally {
        texts.ps = POWER;
      }
    });

    it('says what the relay said when the delete fails, and refuses an idea without a file', async () => {
      liveDocs();
      vi.mocked(trashPath).mockRejectedValue(new RelayApiError('forbidden', 403));
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));
      expect(await result.current.deleteIdea('power-seeking')).toBe('Your access level cannot delete files');
      expect(await result.current.deleteIdea('orthogonality thesis')).toBe('This concept has no file yet.');
    });
  });

  describe('deleteIdeas', () => {
    const liveDocs = (overrides: Record<string, string> = {}) => {
      const docs = new Map<string, DocConnection>();
      __embedDocsTesting.setConnector(async (fullId) => {
        const id = fullId.slice(RELAY_ID.length + 1);
        if (!docs.has(id)) docs.set(id, connection(overrides[id] ?? texts[id]));
        return docs.get(id)!;
      });
      return (id: string) => docs.get(id)?.doc.getText('contents').toString();
    };
    const IC = 'Lens Edu/Context Accelerator LOs/Instrumental convergence.md';
    const PS = 'Lens Edu/Context Accelerator LOs/Power-seeking.md';
    const trashed = {} as Awaited<ReturnType<typeof trashPath>>;
    const run = async (result: { current: ReturnType<typeof useIdeaMap> }, keys: string[]) => {
      let failed: string | null = 'not run';
      await act(async () => {
        failed = await result.current.deleteIdeas(keys);
      });
      return failed as string | null;
    };

    it('deletes several files; a link between two of them needs no edit', async () => {
      const text = liveDocs();
      vi.mocked(trashPath).mockResolvedValue(trashed);
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));
      expect(await run(result, ['power-seeking', 'Instrumental convergence'])).toBeNull();
      expect(vi.mocked(trashPath).mock.calls).toEqual([[IC], [PS]]);
      // No file was opened for editing
      expect(text('ic')).toBeUndefined();
      expect(text('ps')).toBeUndefined();
    });

    it('takes the links out of the files that stay first, then deletes; forces only past those files', async () => {
      const text = liveDocs();
      vi.mocked(trashPath)
        .mockRejectedValueOnce(new TrashRefusedError('linked', [{ path: PS, count: 1 }]))
        .mockResolvedValue(trashed);
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));
      expect(await run(result, ['instrumental convergence'])).toBeNull();
      expect(text('ps')).toBe(POWER.replace('- [[Instrumental convergence]]\n', ''));
      expect(vi.mocked(trashPath).mock.calls).toEqual([[IC], [IC, true]]);
    });

    it('for a concept that is not written yet takes out every link to it, and deletes no file', async () => {
      const text = liveDocs();
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));
      expect(await run(result, ['orthogonality thesis'])).toBeNull();
      expect(text('ic')).toBe(texts.ic.replace('- [[Orthogonality thesis]]\n', ''));
      expect(trashPath).not.toHaveBeenCalled();
      await waitFor(() => expect(result.current.graph.byKey.has('orthogonality thesis')).toBe(false));
    });

    it('changes nothing when a file outside the map links to one of them', async () => {
      const text = liveDocs();
      const { result, folderDoc } = renderMap();
      // The relay's index of links: the lens and Power-seeking link to Instrumental convergence
      folderDoc.getMap('backlinks_v0').set('ic', ['ps', 'lens']);
      await waitFor(() => expect(result.current.read).toBe(2));
      expect(await run(result, ['instrumental convergence', 'orthogonality thesis']))
        .toBe('Nothing was deleted: Lens Edu/Lenses/A lens.md links to "Instrumental convergence". Take that link out first, or delete the file in the file tree.');
      expect(trashPath).not.toHaveBeenCalled();
      expect(text('ps')).toBeUndefined();
      expect(text('ic')).toBeUndefined();
    });

    it('changes nothing when a link sits beside a pending suggestion', async () => {
      const suggested = POWER.replace('- [[Instrumental convergence]]\n', '- [[Instrumental convergence]]\n{++- [[Suggested]]\n++}');
      texts.ps = suggested;
      try {
        const text = liveDocs();
        const { result } = renderMap();
        await waitFor(() => expect(result.current.read).toBe(2));
        expect(await run(result, ['instrumental convergence'])).toBe(`Nothing was deleted. In "Power-seeking": ${PENDING_REQUIREMENTS_ERROR}`);
        expect(trashPath).not.toHaveBeenCalled();
        expect(text('ps')).toBeUndefined();
      } finally {
        texts.ps = POWER;
      }
    });

    it('says exactly which were deleted when it stops half way', async () => {
      liveDocs();
      vi.mocked(trashPath)
        .mockResolvedValueOnce(trashed)
        .mockRejectedValue(new RelayApiError('forbidden', 403));
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));
      expect(await run(result, ['instrumental convergence', 'power-seeking']))
        .toBe('Deleted: Instrumental convergence. Not deleted: Power-seeking. "Power-seeking": Your access level cannot delete files.');
    });

    it('stops at a file something else links to after all, and says the links are out already', async () => {
      const text = liveDocs();
      vi.mocked(trashPath).mockRejectedValue(new TrashRefusedError('linked', [{ path: PS, count: 1 }, { path: 'Lens Edu/courses/A course.md', count: 2 }]));
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));
      expect(await run(result, ['instrumental convergence']))
        .toBe('Not deleted: Instrumental convergence. "Instrumental convergence": Lens Edu/courses/A course.md links to it. The links to all of them are already taken out of the other concepts.');
      expect(text('ps')).toBe(POWER.replace('- [[Instrumental convergence]]\n', ''));
      expect(trashPath).toHaveBeenCalledTimes(1);
    });

    // Prevents: deleteIdeas forcing a file whose refusal names no documents
    // but counts some in folders a folder-limited key cannot see.
    it('stops at a file that documents in other folders link to, and forces nothing', async () => {
      liveDocs();
      vi.mocked(trashPath).mockRejectedValue(new TrashRefusedError('linked', [], 1));
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));
      expect(await run(result, ['power-seeking']))
        .toBe('Not deleted: Power-seeking. "Power-seeking": 1 document in other folders links to it.');
      expect(vi.mocked(trashPath).mock.calls).toEqual([[PS]]);
    });

    it('with an empty refusal and a count of 0 forces past it as before', async () => {
      liveDocs();
      vi.mocked(trashPath)
        .mockRejectedValueOnce(new TrashRefusedError('linked', [], 0))
        .mockResolvedValue(trashed);
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));
      expect(await run(result, ['power-seeking'])).toBeNull();
      expect(vi.mocked(trashPath).mock.calls).toEqual([[PS], [PS, true]]);
    });

    it('refuses names the map does not have', async () => {
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));
      expect(await run(result, ['nothing like it'])).toBe('These concepts are not on the map any more.');
    });
  });

  describe('createIdea', () => {
    const idea = { name: ' Goal-directedness ', priority: 'low' as const, outcome: 'Say what a goal is.', why: '', requires: ['Power-seeking'], helpful: [] };

    it('creates nothing under a name a file has already (whatever its case), or when the file would not read back as typed', async () => {
      const { result } = renderMap();
      await waitFor(() => expect(result.current.read).toBe(2));
      await expect(result.current.createIdea({ ...idea, name: 'power-Seeking', requires: [] })).rejects.toThrow('Nothing was created. A file with this name already exists.');
      await expect(result.current.createIdea({ ...idea, courses: ['a\\qb'] })).rejects.toThrow(/would not read back as typed/);
      expect(createDocument).not.toHaveBeenCalled();
    });

    it('writes the topic of a new concept into its frontmatter', async () => {
      vi.mocked(createDocument).mockImplementation(async (_folderDoc, _path, _type, text) => {
        texts.created = text!;
        return 'created';
      });
      const { result } = renderMap();
      await act(async () => { await result.current.createIdea({ ...idea, topic: 'Governance and policy' }); });
      expect(texts.created).toMatch(/\npriority: low\ntopic: Governance and policy\ncourses:\n/);
    });

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
        '## Lenses',
        '',
        '## Tests',
        '$',
      ].join('\n')));
      // The folder is there already: it is not created again
      expect(folderDoc.getMap('filemeta_v0').size).toBe(1);
    });

    it('makes the folder first when it does not exist yet (a new test set on a local relay)', async () => {
      vi.stubEnv('VITE_LOCAL_RELAY', 'true');
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

    describe('Needed for and Helpful for', () => {
      const linked = { ...idea, requires: [] as string[], neededFor: ['power-seeking'], helpfulFor: ['Instrumental convergence'] };
      const liveDocs = (overrides: Record<string, string> = {}) => {
        const docs = new Map<string, DocConnection>();
        __embedDocsTesting.setConnector(async (fullId) => {
          const id = fullId.slice(RELAY_ID.length + 1);
          if (!docs.has(id)) docs.set(id, connection(overrides[id] ?? texts[id]));
          return docs.get(id)!;
        });
        return (id: string) => docs.get(id)?.doc.getText('contents').toString();
      };
      const created = (text: (id: string) => string | undefined) => vi.mocked(createDocument).mockImplementation(async (_folderDoc, _path, _type, fileText) => {
        // No other file is touched before the new one exists
        expect(text('ps')).toBeUndefined();
        expect(text('ic')).toBeUndefined();
        texts.created = fileText!;
        return 'created';
      });

      it('creates the file, then names the new idea in the files of the ideas it is needed and helpful for', async () => {
        const text = liveDocs();
        created(text);
        const { result } = renderMap();
        await waitFor(() => expect(result.current.read).toBe(2));
        await act(async () => { await result.current.createIdea(linked); });
        expect(createDocument).toHaveBeenCalledTimes(1);
        // Its own file says nothing about them
        expect(texts.created).toContain('## Requires\n\n## Helpful first\n\n## Why it matters');
        expect(text('ps')).toBe(POWER.replace('- [[Instrumental convergence]]\n', '- [[Instrumental convergence]]\n- [[Goal-directedness]]\n'));
        expect(text('ic')).toBe(`${texts.ic}- [[Goal-directedness]]\n`);
      });

      it('creates nothing when a link cannot be written: a circle, an idea with no file, a pending suggestion', async () => {
        const text = liveDocs();
        created(text);
        const { result } = renderMap();
        await waitFor(() => expect(result.current.read).toBe(2));
        await expect(result.current.createIdea({ ...idea, neededFor: ['Instrumental convergence'] }))
          .rejects.toThrow('Nothing was created. This makes a circle of requirements: Goal-directedness → Power-seeking → Instrumental convergence → Goal-directedness');
        await expect(result.current.createIdea({ ...idea, helpfulFor: ['Orthogonality thesis'] }))
          .rejects.toThrow('Nothing was created. "Orthogonality thesis" is not written yet, so it has no file to put the link in.');
        await expect(result.current.createIdea({ ...idea, neededFor: ['Goal-directedness'] })).rejects.toThrow('Nothing was created. A concept cannot be needed for itself.');
        expect(createDocument).not.toHaveBeenCalled();
        expect(text('ps')).toBeUndefined();
      });

      it('creates nothing when the file of a picked idea holds a pending suggestion where the link goes', async () => {
        texts.ps = POWER.replace('- [[Instrumental convergence]]', '- [[Instrumental convergence]]{++ (soon)++}');
        try {
          const text = liveDocs();
          created(text);
          const { result } = renderMap();
          await waitFor(() => expect(result.current.read).toBe(2));
          await expect(result.current.createIdea(linked)).rejects.toThrow(`Nothing was created. In "Power-seeking": ${PENDING_REQUIREMENTS_ERROR}`);
          expect(createDocument).not.toHaveBeenCalled();
          expect(text('ic')).toBeUndefined();
        } finally {
          texts.ps = POWER;
        }
      });

      it('says what was written when it stops half way', async () => {
        // The suggestion came after the map read the file
        const pending = POWER.replace('- [[Instrumental convergence]]', '- [[Instrumental convergence]]{++ (soon)++}');
        const text = liveDocs({ ps: pending });
        created(text);
        const { result } = renderMap();
        await waitFor(() => expect(result.current.read).toBe(2));
        await act(async () => {
          await expect(result.current.createIdea(linked)).rejects.toThrow(
            `The concept is created and added to Instrumental convergence, but it is not added to Power-seeking. In "Power-seeking": ${PENDING_REQUIREMENTS_ERROR} Close this form; "Edit concept" can add the rest.`,
          );
        });
        expect(createDocument).toHaveBeenCalledTimes(1);
        expect(text('ic')).toBe(`${texts.ic}- [[Goal-directedness]]\n`);
        expect(text('ps')).toBe(pending);
      });
    });
  });
});
