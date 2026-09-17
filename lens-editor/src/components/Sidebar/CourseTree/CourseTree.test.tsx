/**
 * CourseTree with the doc connection mocked: each requested uuid resolves to
 * a Y.Doc seeded from CONTENTS, so the tree loads and parses real text.
 *
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { CourseTree } from './CourseTree';
import { NavigationContext } from '../../../contexts/NavigationContext';
import { RELAY_ID } from '../../../lib/constants';

const CONTENTS: Record<string, string> = {
  c1: `---
title: Demo Course
---

# Module: [[../modules/Demo Module|Demo Module]]

# Meeting: Kick-off
survey:: [[../surveys/Demo Survey]]

# Module: [[../modules/Second Module]]
`,
  m1: `# Lens:
source:: [[../Lenses/Demo Lens]]

# Lens:
source:: [[../Lenses/Missing Lens]]
`,
  l1: `#### Article
source:: [[../articles/demo-article]]
`,
  m2: `# Lens:
source:: [[../Lenses/Demo Lens]]
`,
  a1: '---\ntitle: Article\n---\nProse.',
  s1: 'Survey.',
};

const connected: string[] = [];
const getOrConnect = vi.fn(async (docId: string) => {
  const uuid = docId.slice(RELAY_ID.length + 1);
  connected.push(uuid);
  const doc = new Y.Doc();
  doc.getText('contents').insert(0, CONTENTS[uuid] ?? '');
  return { doc, provider: {} as never };
});
vi.mock('../../../hooks/useDocConnection', () => ({
  useDocConnection: () => ({ getOrConnect, disconnect: vi.fn(), disconnectAll: vi.fn() }),
}));

const md = (id: string) => ({ id, type: 'markdown' as const, version: 0 });
const metadata = {
  '/Lens Edu/courses/Demo Course.md': md('c1'),
  '/Lens Edu/modules/Demo Module.md': md('m1'),
  '/Lens Edu/modules/Second Module.md': md('m2'),
  '/Lens Edu/Lenses/Demo Lens.md': md('l1'),
  '/Lens Edu/articles/demo-article.md': md('a1'),
  '/Lens Edu/surveys/Demo Survey.md': md('s1'),
};

function folderDoc(): Y.Doc {
  const doc = new Y.Doc();
  const map = doc.getMap<string[]>('backlinks_v0');
  map.set('m1', ['c1']);
  map.set('m2', ['c1']);
  map.set('l1', ['m1', 'm2']);
  map.set('a1', ['l1']);
  map.set('s1', ['c1']);
  return doc;
}

function renderTree(activeUuid: string | null, onNavigate = vi.fn()) {
  const tree = (uuid: string | null) => (
    <NavigationContext.Provider
      value={{
        metadata,
        folderDocs: new Map([['Lens Edu', folderDoc()]]),
        folderNames: ['Lens Edu'],
        errors: new Map(),
        onNavigate,
        justCreatedRef: { current: false },
      }}
    >
      <CourseTree activeUuid={uuid} />
    </NavigationContext.Provider>
  );
  const { rerender } = render(tree(activeUuid));
  return { onNavigate, setActive: (uuid: string | null) => rerender(tree(uuid)) };
}

const rows = () => screen.getAllByRole('treeitem');
const labels = () => rows().map(r => r.textContent);

beforeEach(() => {
  connected.length = 0;
  getOrConnect.mockClear();
});

describe('CourseTree', () => {
  it('lists every course collapsed and loads nothing until one is opened', () => {
    renderTree(null);
    expect(labels()).toEqual(['CourseDemo Course']);
    expect(rows()[0]).toHaveAttribute('aria-expanded', 'false');
    expect(getOrConnect).not.toHaveBeenCalled();
  });

  it('opens the course down to the active document and marks it', async () => {
    renderTree('l1');
    await waitFor(() => expect(labels()).toEqual([
      'CourseDemo Course',
      'ModuleDemo Module',
      'LensDemo Lens',
      'Articledemo-article',
      'LensMissing Lens',
      'MeetingKick-off',
      // the lens is also used here, so this module opens too
      'ModuleSecond Module',
      'LensDemo Lens',
      'Articledemo-article',
    ]));
    const lens = rows()[2];
    expect(lens).toHaveAttribute('aria-selected', 'true');
    expect(lens).toHaveClass('bg-blue-100');
    // the article is a leaf once loaded: no chevron to expand
    await waitFor(() => expect(rows()[3]).not.toHaveAttribute('aria-expanded'));
    // the missing lens is flagged and not navigable
    expect(within(rows()[4]).getByText('Missing Lens')).toHaveClass('line-through');
    // meetings without a file expand to their survey links
    expect(rows()[5]).toHaveAttribute('aria-expanded', 'false');
    // only what is on screen was connected
    expect(new Set(connected)).toEqual(new Set(['c1', 'm1', 'l1', 'a1', 'm2']));
  });

  it('reveals the new document without closing what was open', async () => {
    const { setActive } = renderTree('a1');
    await waitFor(() => expect(labels()).toContain('Articledemo-article'));
    const user = userEvent.setup();
    // open the meeting by hand: not on the path to any document
    await user.click(within(rows()[5]).getByRole('button', { name: 'Expand' }));
    await waitFor(() => expect(labels()).toContain('surveyDemo Survey'));

    setActive('m1');
    await waitFor(() => expect(rows()[1]).toHaveAttribute('aria-selected', 'true'));
    expect(labels()).toEqual([
      'CourseDemo Course',
      'ModuleDemo Module',
      'LensDemo Lens',
      'Articledemo-article',
      'LensMissing Lens',
      'MeetingKick-off',
      'surveyDemo Survey',
      'ModuleSecond Module',
      'LensDemo Lens',
      'Articledemo-article',
    ]);
    expect(rows()[3]).toHaveAttribute('aria-selected', 'false');
  });

  it('navigates on click, opens a new tab on cmd-click, and toggles on the chevron', async () => {
    const { onNavigate } = renderTree('l1');
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    await waitFor(() => expect(labels()).toContain('ModuleDemo Module'));
    const user = userEvent.setup();

    await user.click(within(rows()[1]).getByText('Demo Module'));
    expect(onNavigate).toHaveBeenCalledWith(`${RELAY_ID}-m1`);

    await user.keyboard('{Meta>}');
    await user.click(within(rows()[1]).getByText('Demo Module'));
    await user.keyboard('{/Meta}');
    expect(openSpy).toHaveBeenCalledWith(expect.stringContaining('/m1/Lens-Edu/modules/Demo-Module.md'), '_blank');

    await user.click(within(rows()[0]).getByRole('button', { name: 'Collapse' }));
    expect(labels()).toEqual(['CourseDemo Course']);
    expect(onNavigate).toHaveBeenCalledTimes(1);

    await user.click(within(rows()[0]).getByRole('button', { name: 'Expand' }));
    await waitFor(() => expect(labels()).toContain('ModuleDemo Module'));
    openSpy.mockRestore();
  });

  it('says so when the open document belongs to no course', () => {
    renderTree('zzz');
    expect(screen.getByText('The open document is not part of a course.')).toBeInTheDocument();
  });

  it('explains an empty result', () => {
    render(
      <NavigationContext.Provider
        value={{
          metadata: { '/Lens/Welcome.md': md('w1') },
          folderDocs: new Map([['Lens', new Y.Doc()]]),
          folderNames: ['Lens'],
          errors: new Map(),
          onNavigate: vi.fn(),
          justCreatedRef: { current: false },
        }}
      >
        <CourseTree activeUuid={null} />
      </NavigationContext.Provider>
    );
    expect(screen.getByText(/No courses found/)).toBeInTheDocument();
  });
});
