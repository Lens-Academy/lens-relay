import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../../contexts/AuthContext';
import { NavigationContext } from '../../contexts/NavigationContext';
import { buildIdeaGraph, ideaAsEdit } from '../../lib/idea-map';
import type { UserRole } from '../../../shared/types';
import { ConceptMapPage } from './ConceptMapPage';
import { useIdeaMap, type IdeaMap, type IdeaProfiles } from './useIdeaMap';

vi.mock('./useIdeaMap', () => ({ useIdeaMap: vi.fn() }));

const file = (id: number, priority: string, body: string) =>
  `---\nid: 00000000-0000-4000-8000-00000000000${id}\npriority: ${priority}\n---\n${body}`;
const QUESTION = '#### Question: Open\nid:: 11111111-1111-4111-8111-111111111111\ncontent:: Why?\n';

const graph = buildIdeaGraph([
  {
    name: 'Instrumental convergence',
    docId: 'ic',
    text: file(1, 'high', `Explain why agents share sub-goals.\n\n## Helpful first\n- [[Orthogonality thesis]]\n\n## Why it matters\nIt underlies the risk argument.\n\n## Lenses\n- Start with [[../Lenses/A lens|the first lens]] (11 minutes).\n- [[../Lenses/Not there]]\n\n## Tests\n${QUESTION}${QUESTION}`),
  },
  {
    name: 'Power-seeking',
    docId: 'ps',
    text: file(2, 'medium', 'Explain why power helps.\n\n## Requires\n- [[Instrumental convergence]]\n').replace('priority: medium\n', 'priority: medium\ntopic: Risk arguments\n'),
  },
  { name: 'Corrigibility', docId: 'co', text: file(3, 'low', '\n## Requires\n- [[Power-seeking]]\n').replace('priority: low\n', 'priority: low\ntopic: Control\n') },
], { lensExists: (link) => link === '../Lenses/A lens' });

let map: IdeaMap;
const onNavigate = vi.fn();

function renderPage(role: UserRole = 'edit', url = '/concept-map') {
  return render(page(role, url));
}

function page(role: UserRole = 'edit', url = '/concept-map') {
  return (
    <AuthProvider role={role} folderUuid={null} isAllFolders>
      <NavigationContext.Provider value={{
        metadata: { '/Lens Edu/Lenses/A lens.md': { id: 'lens', type: 'markdown', version: 0 } },
        folderDocs: new Map(),
        folderNames: ['Lens Edu'],
        errors: new Map(),
        onNavigate,
        justCreatedRef: { current: false },
      }}>
        <MemoryRouter initialEntries={[url]}>
          <ConceptMapPage />
        </MemoryRouter>
      </NavigationContext.Provider>
    </AuthProvider>
  );
}

const box = (name: string) => screen.getByTestId('idea-map').querySelector<HTMLElement>(`[data-idea="${name}"]`)!;
const names = (list: string) => [...screen.getByTestId('idea-form').querySelectorAll(`[data-list="${list}"] [data-chip] > span`)].map((el) => el.textContent);
/** The rows of the list under a requirements box; the highlighted one in [ ]. */
const offered = (label: string) => {
  const rows = document.getElementById(screen.getByLabelText(label).getAttribute('aria-controls')!);
  return rows ? [...rows.querySelectorAll('[role="option"]')].map((row) => (row.getAttribute('aria-selected') === 'true' ? `[${row.textContent}]` : row.textContent)) : null;
};

beforeEach(() => {
  onNavigate.mockReset();
  map = {
    folderPath: '/Lens Edu/Context Accelerator LOs',
    folders: ['Context Accelerator LOs'],
    graph,
    fileNames: ['_Template', 'Corrigibility', 'Instrumental convergence', 'Power-seeking'],
    total: 3,
    read: 3,
    ready: true,
    refresh: vi.fn(),
    lensDoc: (link) => (link === '../Lenses/A lens' ? 'lens' : null),
    createIdea: vi.fn(async () => {}),
    saveRequirements: vi.fn(async () => null),
    addQuestion: vi.fn(async () => null),
    editIdea: vi.fn(async () => null),
    deleteIdea: vi.fn(async () => null),
    deleteIdeas: vi.fn(async () => null),
    deleteNote: 'The file moves to the trash.',
    editQuestion: vi.fn(async () => null),
    deleteQuestion: vi.fn(async () => null),
  };
  vi.mocked(useIdeaMap).mockImplementation(() => map);
});

describe('ConceptMapPage', () => {
  describe('views', () => {
    it('draws the map: a box per idea, the one without a file marked, lines for both kinds, a legend', () => {
      renderPage();
      expect(box('Instrumental convergence').dataset.written).toBe('true');
      expect(box('Orthogonality thesis').dataset.written).toBe('false');
      expect(box('Orthogonality thesis').title).toContain('Not written yet');
      const frame = screen.getByTestId('idea-map');
      expect(frame.querySelectorAll('[data-edge="requires"]')).toHaveLength(2);
      expect(frame.querySelectorAll('[data-edge="helpful"]')).toHaveLength(1);
      expect(screen.getByTestId('idea-map-legend').textContent).toBe('PriorityHighMediumLowNot written yetRequiresHelpful firstTopic');
      expect(screen.getByTestId('idea-counts').textContent).toBe('3 concepts · 1 not written yet');
    });

    it('shows the steps in the Order view', async () => {
      renderPage();
      await userEvent.click(screen.getByRole('button', { name: 'Order' }));
      const steps = [...screen.getByTestId('idea-order').querySelectorAll('[data-step]')]
        .map((step) => [...step.querySelectorAll('[data-idea]')].map((el) => el.getAttribute('data-idea')));
      expect(steps).toEqual([['Instrumental convergence', 'Orthogonality thesis'], ['Power-seeking'], ['Corrigibility']]);
    });

    it('walks through the concepts one at a time in the Walk through view, and remembers what was seen per folder', async () => {
      localStorage.clear();
      renderPage();
      await userEvent.click(screen.getByRole('button', { name: 'Walk through' }));
      const topics = [...screen.getByTestId('walk-overview').querySelectorAll('[data-topic]')].map((el) => el.getAttribute('data-topic'));
      expect(topics).toEqual(['No topic', 'Risk arguments', 'Control']);
      await userEvent.click(screen.getByTestId('walk-start'));
      const shown = () => screen.getByTestId('walk-step').querySelector<HTMLElement>('[data-walk-card]')!.dataset.idea;
      expect(shown()).toBe('Orthogonality thesis');
      await userEvent.click(screen.getByTestId('walk-next'));
      expect(shown()).toBe('Instrumental convergence');
      expect(screen.getByTestId('walk-where').textContent).toBe('Step 2 of 4 · Topic: No topic (2 of 2)');
      // By the id of the file; the one without a file by its key
      expect(JSON.parse(localStorage.getItem('concept-map-walk-seen:folder:Context Accelerator LOs')!)).toEqual(['orthogonality thesis', '00000000-0000-4000-8000-000000000001']);
      // "Open" is the side panel of the page, and the panel follows the walk
      await userEvent.click(within(screen.getByTestId('walk-step')).getByRole('button', { name: 'Open' }));
      expect(within(screen.getByTestId('idea-panel')).getByRole('heading', { name: 'Instrumental convergence' })).toBeTruthy();
      await userEvent.click(screen.getByTestId('walk-next'));
      expect(within(screen.getByTestId('idea-panel')).getByRole('heading', { name: 'Power-seeking' })).toBeTruthy();
    });

    it('lists every idea with its counts and problems in the Table view, sortable', async () => {
      renderPage('edit', '/concept-map?view=table');
      const rows = () => [...screen.getByTestId('idea-table').querySelectorAll('tbody tr')];
      expect(rows().map((row) => row.getAttribute('data-idea'))).toEqual(['Corrigibility', 'Instrumental convergence', 'Orthogonality thesis', 'Power-seeking']);
      const cells = [...rows()[1].querySelectorAll('td')].slice(1).map((td) => td.textContent);
      // (the box to select it,) name, priority, topic, step, requires, needed for, lenses, questions, problems
      expect(cells).toEqual(['Instrumental convergence', 'High', '', '1', '0', '1 · Power-seeking', '2', '2', 'Lens not found: Not there']);
      expect(rows()[3].querySelectorAll('td')[3].textContent).toBe('Risk arguments');
      expect(rows()[0].querySelector('td:last-child')!.textContent).toBe('No outcomeNo questionsNo lens under Lenses');
      expect(rows()[2].querySelector('td:last-child')!.textContent).toBe('Not written yet');

      await userEvent.click(screen.getByRole('button', { name: /Questions/ }));
      await userEvent.click(screen.getByRole('button', { name: /Questions/ }));
      expect(rows()[0].getAttribute('data-idea')).toBe('Instrumental convergence');
      expect(screen.getByRole('columnheader', { name: /Questions/ }).getAttribute('aria-sort')).toBe('descending');
    });

    it('has a Topic column in the Table view: sorted by topic, concepts without one last', async () => {
      renderPage('edit', '/concept-map?view=table');
      const rows = () => [...screen.getByTestId('idea-table').querySelectorAll('tbody tr')].map((row) => row.getAttribute('data-idea'));
      await userEvent.click(screen.getByRole('button', { name: /Topic/ }));
      expect(screen.getByRole('columnheader', { name: /Topic/ }).getAttribute('aria-sort')).toBe('ascending');
      expect(rows()).toEqual(['Corrigibility', 'Power-seeking', 'Instrumental convergence', 'Orthogonality thesis']);
      await userEvent.click(screen.getByRole('button', { name: /Topic/ }));
      expect(rows()).toEqual(['Power-seeking', 'Corrigibility', 'Instrumental convergence', 'Orthogonality thesis']);
    });

    it('shows the topic of a concept in its panel, and nothing for a concept without one', async () => {
      renderPage();
      await userEvent.click(box('Power-seeking'));
      expect(within(screen.getByTestId('idea-panel')).getByTestId('idea-topic').textContent).toBe('Risk arguments');
      await userEvent.click(box('Instrumental convergence'));
      expect(within(screen.getByTestId('idea-panel')).queryByTestId('idea-topic')).toBeNull();
    });

    it('selects an idea from a name in another row, by click or keyboard', async () => {
      renderPage('edit', '/concept-map?view=table');
      const table = within(screen.getByTestId('idea-table'));
      await userEvent.click(table.getAllByRole('button', { name: 'Power-seeking' }).find((el) => el.tagName === 'SPAN')!);
      expect(within(screen.getByTestId('idea-panel')).getByRole('heading', { name: 'Power-seeking' })).toBeTruthy();
      table.getAllByRole('button', { name: 'Instrumental convergence' }).find((el) => el.tagName === 'SPAN')!.focus();
      await userEvent.keyboard('{Enter}');
      expect(within(screen.getByTestId('idea-panel')).getByRole('heading', { name: 'Instrumental convergence' })).toBeTruthy();
      expect(screen.getByTestId('idea-table').querySelector('[aria-selected="true"]')!.getAttribute('data-idea')).toBe('Instrumental convergence');
    });

    it('finds ideas by name', async () => {
      renderPage('edit', '/concept-map?view=table');
      await userEvent.type(screen.getByLabelText('Find a concept'), 'SEEK');
      expect([...screen.getByTestId('idea-table').querySelectorAll('tbody tr')].map((row) => row.getAttribute('data-idea'))).toEqual(['Power-seeking']);
      expect(screen.getByTestId('idea-counts').textContent).toContain('1 found');
    });

    it('says how far reading is before the first draw, and when the folder is empty', () => {
      map = { ...map, read: 1 };
      const { unmount } = renderPage();
      expect(screen.getByRole('status').textContent).toBe('Reading 1 of 3 concepts…');
      expect(screen.queryByTestId('idea-map')).toBeNull();
      unmount();
      map = { ...map, total: 0, read: 0, graph: buildIdeaGraph([]) };
      renderPage();
      expect(screen.getByText(/No concepts in Lens Edu\/Context Accelerator LOs yet/)).toBeTruthy();
    });

    it('names the ideas of a circle of requirements', () => {
      map = {
        ...map,
        graph: buildIdeaGraph([
          { name: 'A', docId: 'a', text: file(1, 'low', 'x\n\n## Requires\n- [[B]]\n') },
          { name: 'B', docId: 'b', text: file(2, 'low', 'x\n\n## Requires\n- [[A]]\n') },
        ]),
      };
      renderPage();
      expect(screen.getByRole('alert').textContent).toBe('These concepts require each other in a circle: A, B');
      expect(box('A').title).toContain('In a circle of requirements');
    });
  });

  describe('the side panel', () => {
    it('shows what the file says and what needs it; a name selects that idea', async () => {
      renderPage();
      await userEvent.click(box('Instrumental convergence'));
      const panel = within(screen.getByTestId('idea-panel'));
      expect(panel.getByRole('heading', { name: 'Instrumental convergence' })).toBeTruthy();
      expect(panel.getByText('Explain why agents share sub-goals.')).toBeTruthy();
      expect(panel.getByText('It underlies the risk argument.')).toBeTruthy();
      expect([...screen.getByTestId('idea-questions').querySelectorAll('li')].map((li) => li.textContent)).toEqual(['OpenWhy?EditDelete', 'OpenWhy?EditDelete']);
      // Lenses lines as written: the alias as a link, a lens with no file marked
      const lens = panel.getByRole('link', { name: 'the first lens' });
      expect(lens.closest('li')!.textContent).toBe('Start with the first lens (11 minutes).');
      expect(panel.getByText('Not there').tagName).toBe('SPAN');
      await userEvent.click(lens);
      expect(onNavigate).toHaveBeenCalledWith(expect.stringMatching(/-lens$/));
      await userEvent.click(panel.getByRole('link', { name: 'Open file' }));
      expect(onNavigate).toHaveBeenLastCalledWith(expect.stringMatching(/-ic$/));

      await userEvent.click(panel.getByRole('button', { name: 'Power-seeking' }));
      expect(within(screen.getByTestId('idea-panel')).getByRole('heading', { name: 'Power-seeking' })).toBeTruthy();
      expect(box('Power-seeking').getAttribute('aria-pressed')).toBe('true');
    });

    it('offers no file to open for an idea that is not written yet', async () => {
      renderPage();
      await userEvent.click(box('Orthogonality thesis'));
      const panel = within(screen.getByTestId('idea-panel'));
      expect(panel.queryByRole('link', { name: 'Open file' })).toBeNull();
      expect(panel.getByRole('button', { name: 'Create this concept' })).toBeTruthy();
      expect(panel.getByRole('button', { name: 'Instrumental convergence' })).toBeTruthy();
    });
  });

  describe('creator actions', () => {
    it.each(['view', 'suggest'] as const)('shows none of them to a %s link', async (role) => {
      renderPage(role);
      expect(screen.queryByRole('button', { name: 'Add concept' })).toBeNull();
      await userEvent.click(box('Instrumental convergence'));
      expect(screen.getByRole('link', { name: 'Open file' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Edit requirements' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
      // The questions are listed, with nothing to change them
      expect([...screen.getByTestId('idea-questions').querySelectorAll('li')].map((li) => li.textContent)).toEqual(['OpenWhy?', 'OpenWhy?']);
      expect(screen.queryByRole('button', { name: /question/i })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Add question' })).toBeNull();
      await userEvent.click(box('Orthogonality thesis'));
      expect(screen.getByTestId('idea-panel')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Create this concept' })).toBeNull();
    });

    it('adds a concept: requirements picked by clicking ideas, shift-click or the switch for helpful first', async () => {
      renderPage();
      await userEvent.click(screen.getByRole('button', { name: 'Add concept' }));
      await userEvent.type(screen.getByLabelText('Name'), 'Goal-directedness');
      await userEvent.type(screen.getByLabelText('Outcome'), 'Say what a goal is.');
      await userEvent.selectOptions(screen.getByLabelText('Priority'), 'high');
      // The topics the other concepts have are offered, by name
      expect(screen.getByLabelText('Topic').getAttribute('list')).toBe('idea-topic-list');
      expect([...screen.getByTestId('idea-topic-list').querySelectorAll('option')].map((option) => option.value)).toEqual(['Control', 'Risk arguments']);
      expect(screen.getByText('Groups the concept on the map. Optional.')).toBeTruthy();
      await userEvent.type(screen.getByLabelText('Topic'), '  Agency:  basics ');
      await userEvent.type(screen.getByLabelText('Why it matters'), 'Everything else builds on it.');

      await userEvent.click(box('Power-seeking'));
      await userEvent.click(box('Corrigibility'));
      await userEvent.click(box('Corrigibility'));
      fireEvent.click(box('Orthogonality thesis'), { shiftKey: true });
      expect(names('requires')).toEqual(['Power-seeking']);
      expect(names('helpful')).toEqual(['Orthogonality thesis']);
      expect(box('Power-seeking').textContent).toBe('Power-seekingRequires');
      // No panel opens while the form is: a click picks
      expect(screen.queryByTestId('idea-panel')).toBeNull();

      await userEvent.click(screen.getByRole('button', { name: 'Helpful first' }));
      await userEvent.click(box('Instrumental convergence'));
      expect(names('helpful')).toEqual(['Orthogonality thesis', 'Instrumental convergence']);

      await userEvent.click(screen.getByRole('button', { name: 'Create concept' }));
      await waitFor(() => expect(screen.queryByTestId('idea-form')).toBeNull());
      expect(map.createIdea).toHaveBeenCalledWith({
        name: 'Goal-directedness',
        outcome: 'Say what a goal is.',
        priority: 'high',
        topic: 'Agency: basics',
        why: 'Everything else builds on it.',
        courses: ['../courses/in-development/Context Accelerator'],
        learn: '',
        requires: ['Power-seeking'],
        helpful: ['Orthogonality thesis', 'Instrumental convergence'],
        neededFor: [],
        helpfulFor: [],
      });
    });

    describe('needed for', () => {
      const clickSwitch = () => within(screen.getByRole('group', { name: 'A click on a concept adds it to' }));
      const here = () => [...screen.getByTestId('idea-form').querySelectorAll('[data-list][data-active]')].map((el) => el.getAttribute('data-list'));

      it('adds a concept with what it is needed for: typed, clicked in the map, shift-click for helpful for', async () => {
        renderPage();
        await userEvent.click(screen.getByRole('button', { name: 'Add concept' }));
        await userEvent.type(screen.getByLabelText('Name'), 'Goal-directedness');
        // The list that map clicks go to is marked, and can be switched
        expect(clickSwitch().getAllByRole('button').map((b) => b.textContent)).toEqual(['Requires', 'Helpful first', 'Needed for', 'Helpful for']);
        expect(here()).toEqual(['requires']);
        expect(screen.getByText('Shift-click adds to Helpful first.', { exact: false })).toBeTruthy();

        // Typed: only written concepts are offered, and a name no file has is not a new concept here
        await userEvent.type(screen.getByLabelText('Needed for'), 'o');
        expect(offered('Needed for')).toEqual(['[Corrigibility]', 'Instrumental convergence', 'Power-seeking']);
        await userEvent.type(screen.getByLabelText('Needed for'), 'rthogonality thesis');
        expect(offered('Needed for')).toBeNull();
        expect(screen.getByText('"Orthogonality thesis" is not written yet. Write that concept first, or add this one to its Requires later.')).toBeTruthy();
        await userEvent.clear(screen.getByLabelText('Needed for'));
        await userEvent.type(screen.getByLabelText('Needed for'), 'Mesa');
        expect(offered('Needed for')).toBeNull();
        expect(screen.getByText('No written concept has this name. Write that concept first, or add this one to its Requires later.')).toBeTruthy();
        await userEvent.clear(screen.getByLabelText('Needed for'));
        await userEvent.type(screen.getByLabelText('Needed for'), 'corr{Enter}');
        expect(names('neededFor')).toEqual(['Corrigibility']);

        // A click into the box of a list makes it the one map clicks go to
        expect(here()).toEqual(['neededFor']);
        expect(clickSwitch().getByRole('button', { name: 'Needed for' }).getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByText('Shift-click adds to Helpful for.', { exact: false })).toBeTruthy();
        await userEvent.click(box('Power-seeking'));
        fireEvent.click(box('Instrumental convergence'), { shiftKey: true });
        expect(names('neededFor')).toEqual(['Corrigibility', 'Power-seeking']);
        expect(names('helpfulFor')).toEqual(['Instrumental convergence']);
        expect(box('Power-seeking').textContent).toBe('Power-seekingNeeded for');
        expect(box('Instrumental convergence').textContent).toBe('Instrumental convergenceHelpful for');

        // One that is not written yet has no file for the link: said, not added
        await userEvent.click(box('Orthogonality thesis'));
        expect(screen.getByTestId('idea-click-note').textContent).toBe('"Orthogonality thesis" is not written yet, so it cannot go under Needed for. Write that concept first, or add this one to its Requires later.');
        expect(names('neededFor')).toEqual(['Corrigibility', 'Power-seeking']);
        // A concept is in one list only: picked elsewhere, it moves
        await userEvent.click(clickSwitch().getByRole('button', { name: 'Requires' }));
        expect(screen.queryByTestId('idea-click-note')).toBeNull();
        await userEvent.click(box('Power-seeking'));
        expect(names('requires')).toEqual(['Power-seeking']);
        expect(names('neededFor')).toEqual(['Corrigibility']);

        await userEvent.click(screen.getByRole('button', { name: 'Create concept' }));
        await waitFor(() => expect(screen.queryByTestId('idea-form')).toBeNull());
        expect(map.createIdea).toHaveBeenCalledWith(expect.objectContaining({
          name: 'Goal-directedness',
          requires: ['Power-seeking'],
          helpful: [],
          neededFor: ['Corrigibility'],
          helpfulFor: ['Instrumental convergence'],
        }));
      });

      it('refuses a circle that "Needed for" would make, and saves nothing', async () => {
        renderPage();
        await userEvent.click(screen.getByRole('button', { name: 'Add concept' }));
        await userEvent.type(screen.getByLabelText('Name'), 'Goals');
        // Goals requires Corrigibility, which requires Power-seeking, which would require Goals
        await userEvent.click(box('Corrigibility'));
        await userEvent.click(screen.getByLabelText('Needed for'));
        await userEvent.click(box('Power-seeking'));
        expect(screen.getByTestId('idea-needed-circle').textContent).toBe(
          'This makes a circle of requirements: Goals → Corrigibility → Power-seeking → Goals. Take Power-seeking out of Needed for, or change Requires: it cannot be saved like this.',
        );
        await userEvent.click(screen.getByRole('button', { name: 'Create concept' }));
        expect(map.createIdea).not.toHaveBeenCalled();
        expect(screen.getByTestId('idea-form')).toBeTruthy();
        // Taken out, it saves
        await userEvent.click(screen.getByRole('button', { name: 'Remove Power-seeking from Needed for' }));
        expect(screen.queryByTestId('idea-needed-circle')).toBeNull();
        await userEvent.click(screen.getByRole('button', { name: 'Create concept' }));
        await waitFor(() => expect(map.createIdea).toHaveBeenCalledWith(expect.objectContaining({ requires: ['Corrigibility'], neededFor: [] })));
      });

      it('says who names a concept already when one that is not written yet is created', async () => {
        renderPage();
        await userEvent.click(box('Orthogonality thesis'));
        await userEvent.click(screen.getByRole('button', { name: 'Create this concept' }));
        expect(screen.getByTestId('idea-list-footnote').textContent).toBe('Already helpful for Instrumental convergence: it names this concept under Helpful first.');
        expect(screen.getByTestId('idea-list-footnote').closest('[data-list]')!.getAttribute('data-list')).toBe('helpfulFor');
      });

      it('edits what a concept is needed for: filled from the map, a chip taken out and one added, saved as before and after', async () => {
        renderPage();
        await userEvent.click(box('Power-seeking'));
        await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
        expect(names('requires')).toEqual(['Instrumental convergence']);
        expect(names('neededFor')).toEqual(['Corrigibility']);
        expect(names('helpfulFor')).toEqual([]);
        expect(box('Corrigibility').textContent).toBe('CorrigibilityNeeded for');

        await userEvent.click(screen.getByRole('button', { name: 'Remove Corrigibility from Needed for' }));
        await userEvent.type(screen.getByLabelText('Helpful for'), 'corr{Enter}');
        // What it requires cannot need it too: picked there, it moves out of Requires
        await userEvent.type(screen.getByLabelText('Needed for'), 'Instrumental convergence');
        expect(screen.getByText('This concept is under Requires already.')).toBeTruthy();
        await userEvent.clear(screen.getByLabelText('Needed for'));
        // Itself is never offered
        await userEvent.type(screen.getByLabelText('Needed for'), 'power-seeking');
        expect(screen.getByText('A concept cannot be needed for itself.')).toBeTruthy();
        await userEvent.clear(screen.getByLabelText('Needed for'));

        await userEvent.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(screen.queryByTestId('idea-form')).toBeNull());
        const before = ideaAsEdit('Power-seeking', graph.byKey.get('power-seeking')!.idea!, { neededFor: ['Corrigibility'], helpfulFor: [] });
        expect(map.editIdea).toHaveBeenCalledWith('power-seeking', before, { ...before, neededFor: [], helpfulFor: ['Corrigibility'] });
      });

      it('leaves "Needed for" out of "Edit requirements"', async () => {
        renderPage();
        await userEvent.click(box('Power-seeking'));
        await userEvent.click(screen.getByRole('button', { name: 'Edit requirements' }));
        expect(screen.queryByLabelText('Needed for')).toBeNull();
        expect(clickSwitch().getAllByRole('button').map((b) => b.textContent)).toEqual(['Requires', 'Helpful first']);
      });
    });

    it('adds a concept with its lenses and its courses, and refuses text that would start a new part of the file', async () => {
      renderPage();
      await userEvent.click(screen.getByRole('button', { name: 'Add concept' }));
      await userEvent.type(screen.getByLabelText('Name'), 'Goals');
      expect(screen.getByLabelText('Courses')).toHaveProperty('value', '../courses/in-development/Context Accelerator');
      fireEvent.change(screen.getByLabelText('Courses'), { target: { value: '../courses/A\n\n ../courses/B ' } });
      fireEvent.change(screen.getByLabelText('Lenses'), { target: { value: '- [[../Lenses/A lens]]\n## Tests' } });
      await userEvent.click(screen.getByRole('button', { name: 'Create concept' }));
      expect(screen.getByRole('alert').textContent).toMatch(/^Lenses cannot/);
      expect(map.createIdea).not.toHaveBeenCalled();
      fireEvent.change(screen.getByLabelText('Lenses'), { target: { value: '- [[../Lenses/A lens]]: first' } });
      await userEvent.click(screen.getByRole('button', { name: 'Create concept' }));
      await waitFor(() => expect(map.createIdea).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Goals', courses: ['../courses/A', '../courses/B'], learn: '- [[../Lenses/A lens]]: first',
      })));
    });

    it('selects the new idea once it is on the map', async () => {
      map.createIdea = vi.fn(async () => {
        map = {
          ...map,
          graph: buildIdeaGraph([
            { name: 'Goal-directedness', docId: 'gd', text: file(4, 'medium', 'Say what a goal is.\n') },
            { name: 'Power-seeking', docId: 'ps', text: file(2, 'medium', 'x\n') },
          ]),
        };
      });
      renderPage();
      await userEvent.click(screen.getByRole('button', { name: 'Add concept' }));
      await userEvent.type(screen.getByLabelText('Name'), 'Goal-directedness');
      await userEvent.click(screen.getByRole('button', { name: 'Create concept' }));
      expect(await within(await screen.findByTestId('idea-panel')).findByRole('heading', { name: 'Goal-directedness' })).toBeTruthy();
      expect(box('Goal-directedness').getAttribute('aria-pressed')).toBe('true');
    });

    it('picks requirements by typing: the list opens, arrows move the highlight, Enter picks it', async () => {
      renderPage();
      await userEvent.click(screen.getByRole('button', { name: 'Add concept' }));
      const requires = screen.getByLabelText('Requires');
      expect(requires.getAttribute('role')).toBe('combobox');
      expect(requires.getAttribute('aria-expanded')).toBe('false');
      expect(offered('Requires')).toBeNull();

      await userEvent.type(requires, 'co');
      expect(requires.getAttribute('aria-expanded')).toBe('true');
      // start of a name before the start of a word; the typed text as a new concept comes last
      expect(offered('Requires')).toEqual(['[Corrigibility]', 'Instrumental convergence', 'Add "co" as a new concept']);
      const active = () => document.getElementById(requires.getAttribute('aria-activedescendant')!)!.textContent;
      expect(active()).toBe('Corrigibility');
      await userEvent.keyboard('{ArrowDown}');
      expect(active()).toBe('Instrumental convergence');
      await userEvent.keyboard('{ArrowDown}{ArrowDown}');
      expect(active()).toBe('Corrigibility');
      await userEvent.keyboard('{ArrowUp}');
      expect(active()).toBe('Add "co" as a new concept');
      await userEvent.keyboard('{ArrowUp}{Enter}');
      expect(names('requires')).toEqual(['Instrumental convergence']);
      // ready for the next one: the box is empty, has the focus, and the list is closed
      expect((requires as HTMLInputElement).value).toBe('');
      expect(document.activeElement).toBe(requires);
      expect(offered('Requires')).toBeNull();

      await userEvent.keyboard('corr{Enter}');
      expect(names('requires')).toEqual(['Instrumental convergence', 'Corrigibility']);
      expect(map.createIdea).not.toHaveBeenCalled();

      await userEvent.type(screen.getByLabelText('Helpful first'), 'thesis');
      await userEvent.click(screen.getByRole('option', { name: /Orthogonality thesis.*Not written yet/ }));
      expect(names('helpful')).toEqual(['Orthogonality thesis']);
      expect(document.activeElement).toBe(screen.getByLabelText('Helpful first'));
      await userEvent.click(screen.getByRole('button', { name: 'Remove Corrigibility from Requires' }));
      expect(names('requires')).toEqual(['Instrumental convergence']);
    });

    it('opens the list with an arrow key, closes it with Escape, and Backspace takes the last pick out', async () => {
      renderPage();
      await userEvent.click(screen.getByRole('button', { name: 'Add concept' }));
      const requires = screen.getByLabelText('Requires');
      await userEvent.click(requires);
      await userEvent.keyboard('{ArrowDown}');
      expect(offered('Requires')).toEqual(['[Corrigibility]', 'Instrumental convergence', 'Orthogonality thesisNot written yet', 'Power-seeking']);
      await userEvent.keyboard('{ArrowUp}');
      expect(offered('Requires')![3]).toBe('[Power-seeking]');
      await userEvent.hover(screen.getByRole('option', { name: 'Instrumental convergence' }));
      expect(offered('Requires')![1]).toBe('[Instrumental convergence]');
      await userEvent.keyboard('{Escape}');
      expect(offered('Requires')).toBeNull();
      // Escape closed the list only: the form is still there, the focus in the box
      expect(screen.getByTestId('idea-form')).toBeTruthy();
      expect(document.activeElement).toBe(requires);

      await userEvent.keyboard('pow{Enter}cor{Enter}');
      expect(names('requires')).toEqual(['Power-seeking', 'Corrigibility']);
      await userEvent.keyboard('{Backspace}');
      expect(names('requires')).toEqual(['Power-seeking']);
      // With text in the box Backspace only edits the text
      await userEvent.keyboard('ab{Backspace}{Backspace}');
      expect(names('requires')).toEqual(['Power-seeking']);
    });

    it('links to a concept that does not exist yet: offered last, highlighted when nothing else matches', async () => {
      renderPage();
      await userEvent.click(screen.getByRole('button', { name: 'Add concept' }));
      await userEvent.type(screen.getByLabelText('Name'), 'Deception');
      const requires = screen.getByLabelText('Requires');
      await userEvent.type(requires, 'Mesa optimisation');
      expect(offered('Requires')).toEqual(['[Add "Mesa optimisation" as a new concept]']);
      await userEvent.keyboard('{Enter}');
      expect(names('requires')).toEqual(['Mesa optimisation']);
      expect(screen.getByTestId('idea-form').querySelector('[data-list="requires"] [data-chip]')!.getAttribute('data-chip')).toBe('unwritten');

      // A name a file cannot have: said under the box, nothing added
      await userEvent.type(requires, 'Goals/values{Enter}');
      expect(screen.getByText('A name cannot contain /')).toBeTruthy();
      expect(requires.getAttribute('aria-invalid')).toBe('true');
      expect(names('requires')).toEqual(['Mesa optimisation']);
      await userEvent.clear(requires);
      // Never the concept itself, never what is picked already
      await userEvent.type(requires, 'deception{Enter}');
      expect(screen.getByText('A concept cannot be its own requirement.')).toBeTruthy();
      await userEvent.clear(requires);
      await userEvent.type(screen.getByLabelText('Helpful first'), 'mesa OPTIMISATION{Enter}');
      expect(screen.getByText('This concept is under Requires already.')).toBeTruthy();
      expect(names('helpful')).toEqual([]);
      await userEvent.clear(screen.getByLabelText('Helpful first'));
      // An exact name of the map is not offered as new
      await userEvent.type(screen.getByLabelText('Helpful first'), 'corrigibility');
      expect(offered('Helpful first')).toEqual(['[Corrigibility]']);
      await userEvent.keyboard('{Enter}');

      await userEvent.click(screen.getByRole('button', { name: 'Create concept' }));
      await waitFor(() => expect(map.createIdea).toHaveBeenCalledWith(expect.objectContaining({ name: 'Deception', requires: ['Mesa optimisation'], helpful: ['Corrigibility'] })));
    });

    it('links to a new concept from "Edit requirements" too', async () => {
      renderPage();
      await userEvent.click(box('Power-seeking'));
      await userEvent.click(screen.getByRole('button', { name: 'Edit requirements' }));
      await userEvent.type(screen.getByLabelText('Requires'), 'power-seeking');
      expect(offered('Requires')).toBeNull();
      expect(screen.getByText('A concept cannot be its own requirement.')).toBeTruthy();
      await userEvent.clear(screen.getByLabelText('Requires'));
      await userEvent.type(screen.getByLabelText('Requires'), 'Goal-directedness{Enter}');
      await userEvent.click(screen.getByRole('button', { name: 'Save requirements' }));
      await waitFor(() => expect(map.saveRequirements).toHaveBeenCalledWith(
        'power-seeking',
        { requires: ['Instrumental convergence'], helpful: [] },
        { requires: ['Instrumental convergence', 'Goal-directedness'], helpful: [] },
      ));
    });

    it('refuses a name that exists or that a file cannot have, and creates nothing', async () => {
      renderPage();
      await userEvent.click(screen.getByRole('button', { name: 'Add concept' }));
      await userEvent.click(screen.getByRole('button', { name: 'Create concept' }));
      expect(screen.getByText('Give the concept a name.')).toBeTruthy();
      await userEvent.type(screen.getByLabelText('Name'), 'power-SEEKING');
      expect(screen.getByText('A file with this name already exists.')).toBeTruthy();
      await userEvent.clear(screen.getByLabelText('Name'));
      await userEvent.type(screen.getByLabelText('Name'), 'Means/ends');
      expect(screen.getByText('A name cannot contain /')).toBeTruthy();
      await userEvent.click(screen.getByRole('button', { name: 'Create concept' }));
      expect(map.createIdea).not.toHaveBeenCalled();
      expect(screen.getByTestId('idea-form')).toBeTruthy();
    });

    it('keeps the form open and says why when creating fails', async () => {
      map.createIdea = vi.fn(async () => { throw new Error('The relay said no.'); });
      renderPage();
      await userEvent.click(screen.getByRole('button', { name: 'Add concept' }));
      await userEvent.type(screen.getByLabelText('Name'), 'Goal-directedness');
      await userEvent.click(screen.getByRole('button', { name: 'Create concept' }));
      expect((await screen.findByRole('alert')).textContent).toBe('The relay said no.');
      expect(screen.getByRole('button', { name: 'Create concept' })).toHaveProperty('disabled', false);
    });

    it('opens the form with the name filled in from "Create this concept"', async () => {
      renderPage();
      await userEvent.click(box('Orthogonality thesis'));
      await userEvent.click(screen.getByRole('button', { name: 'Create this concept' }));
      expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Orthogonality thesis');
      // It cannot require itself, even when clicked
      await userEvent.click(box('Orthogonality thesis'));
      await userEvent.click(screen.getByRole('button', { name: 'Create concept' }));
      await waitFor(() => expect(map.createIdea).toHaveBeenCalledWith(expect.objectContaining({ name: 'Orthogonality thesis', requires: [], helpful: [] })));
    });

    it('edits the requirements of an idea: what it has now, toggled by clicks, saved as before and after', async () => {
      renderPage();
      await userEvent.click(box('Power-seeking'));
      await userEvent.click(screen.getByRole('button', { name: 'Edit requirements' }));
      expect(screen.getByRole('heading', { name: 'Requirements of Power-seeking' })).toBeTruthy();
      expect(screen.queryByLabelText('Name')).toBeNull();
      expect(names('requires')).toEqual(['Instrumental convergence']);
      expect(box('Power-seeking').textContent).toBe('Power-seekingThis concept');

      await userEvent.click(box('Instrumental convergence'));
      await userEvent.click(box('Orthogonality thesis'));
      // Itself cannot be picked
      await userEvent.click(box('Power-seeking'));
      expect(names('requires')).toEqual(['Orthogonality thesis']);
      // Requiring what needs it makes a circle: said, not refused
      await userEvent.click(box('Corrigibility'));
      expect(screen.getByRole('status').textContent).toBe('This makes a circle of requirements: Power-seeking → Corrigibility → Power-seeking');
      await userEvent.click(box('Corrigibility'));

      await userEvent.click(screen.getByRole('button', { name: 'Save requirements' }));
      await waitFor(() => expect(screen.queryByTestId('idea-form')).toBeNull());
      expect(map.saveRequirements).toHaveBeenCalledWith(
        'power-seeking',
        { requires: ['Instrumental convergence'], helpful: [] },
        { requires: ['Orthogonality thesis'], helpful: [] },
      );
      expect(within(screen.getByTestId('idea-panel')).getByRole('heading', { name: 'Power-seeking' })).toBeTruthy();
    });

    it('shows why requirements could not be saved', async () => {
      map.saveRequirements = vi.fn(async () => 'These lines hold a suggestion.');
      renderPage();
      await userEvent.click(box('Power-seeking'));
      await userEvent.click(screen.getByRole('button', { name: 'Edit requirements' }));
      await userEvent.click(screen.getByRole('button', { name: 'Save requirements' }));
      expect((await screen.findByRole('alert')).textContent).toBe('These lines hold a suggestion.');
    });

    it('adds an open question to the selected idea, with how to grade it', async () => {
      renderPage();
      await userEvent.click(box('Power-seeking'));
      // An idea without questions says so, and offers to add one
      expect(screen.queryByTestId('idea-questions')).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: 'Add question' }));
      const form = within(screen.getByTestId('question-form'));
      expect(form.getByText('to Power-seeking')).toBeTruthy();
      expect(form.getByRole('button', { name: 'Open' }).getAttribute('aria-pressed')).toBe('true');
      expect(form.getByText('With a grading text the answer is scored. With a tutor text the learner gets feedback. Both may be filled.')).toBeTruthy();
      await userEvent.type(form.getByLabelText('Question'), 'Why does power help?');
      await userEvent.type(form.getByLabelText('How to grade it'), 'Score out of 100.');

      // A click on another idea does not take the form away
      await userEvent.click(box('Corrigibility'));
      expect((form.getByLabelText('Question') as HTMLTextAreaElement).value).toBe('Why does power help?');
      expect(box('Power-seeking').getAttribute('aria-pressed')).toBe('true');

      await userEvent.click(form.getByRole('button', { name: 'Add question' }));
      await waitFor(() => expect(screen.queryByTestId('question-form')).toBeNull());
      expect(map.addQuestion).toHaveBeenCalledWith('power-seeking', {
        type: 'Open', content: 'Why does power help?', assessment: 'Score out of 100.', feedback: '', other: [],
      });
      expect(within(screen.getByTestId('idea-panel')).getByRole('heading', { name: 'Power-seeking' })).toBeTruthy();
    });

    it('adds a choice question: options added and removed, right answers ticked', async () => {
      renderPage();
      await userEvent.click(box('Instrumental convergence'));
      await userEvent.click(screen.getByRole('button', { name: 'Add question' }));
      const form = within(screen.getByTestId('question-form'));
      await userEvent.click(form.getByRole('button', { name: 'Choice' }));
      expect(form.queryByLabelText('How to grade it')).toBeNull();
      await userEvent.type(form.getByLabelText('Question'), 'Which is a sub-goal of most goals?');
      await userEvent.type(form.getByLabelText('Option 1'), 'More resources');
      await userEvent.type(form.getByLabelText('Option 2'), 'A typo');
      // Two options is the least: nothing to remove yet
      expect(form.queryByRole('button', { name: 'Remove option 1' })).toBeNull();
      await userEvent.click(form.getByRole('button', { name: 'Add option' }));
      await userEvent.type(form.getByLabelText('Option 3'), 'Fewer options');
      await userEvent.click(form.getByRole('button', { name: 'Remove option 2' }));
      expect((form.getByLabelText('Option 2') as HTMLInputElement).value).toBe('Fewer options');

      await userEvent.click(form.getByRole('button', { name: 'Add question' }));
      expect(form.getByRole('alert').textContent).toBe('Tick at least one right answer.');
      expect(map.addQuestion).not.toHaveBeenCalled();

      await userEvent.click(form.getByLabelText('Option 1 is a right answer'));
      // The message was about the form as it was
      expect(form.queryByRole('alert')).toBeNull();
      await userEvent.type(form.getByLabelText('Explanation'), 'Resources help with nearly any goal.');
      await userEvent.click(form.getByRole('button', { name: 'Add question' }));
      await waitFor(() => expect(screen.queryByTestId('question-form')).toBeNull());
      expect(map.addQuestion).toHaveBeenCalledWith('instrumental convergence', {
        type: 'Choice',
        content: 'Which is a sub-goal of most goals?',
        options: [{ text: 'More resources', correct: true }, { text: 'Fewer options', correct: false }],
        explanation: 'Resources help with nearly any goal.',
        other: [{ name: 'shuffle', value: 'true' }],
      });
    });

    it('adds a question with more settings: a known name or a typed one, removed again, empty rows left out', async () => {
      renderPage();
      await userEvent.click(box('Power-seeking'));
      await userEvent.click(screen.getByRole('button', { name: 'Add question' }));
      const form = within(screen.getByTestId('question-form'));
      await userEvent.type(form.getByLabelText('Question'), 'Why?');
      const settings = within(form.getByTestId('question-settings'));
      expect(settings.getByText('None')).toBeTruthy();
      await userEvent.click(settings.getByRole('button', { name: 'Add setting' }));
      await userEvent.type(settings.getByLabelText('Name of the new setting'), 'max-words');
      expect(settings.getByText('Longest answer, in words')).toBeTruthy();
      await userEvent.type(settings.getByLabelText('Value of max-words'), '80');
      await userEvent.click(settings.getByRole('button', { name: 'Add setting' }));
      await userEvent.type(settings.getAllByLabelText('Name of the new setting')[1], 'placeholder');
      await userEvent.type(settings.getByLabelText('Value of placeholder'), 'Type here');
      await userEvent.click(settings.getByRole('button', { name: 'Remove setting placeholder' }));
      // A row added and left empty
      await userEvent.click(settings.getByRole('button', { name: 'Add setting' }));
      await userEvent.click(form.getByRole('button', { name: 'Add question' }));
      await waitFor(() => expect(map.addQuestion).toHaveBeenCalledWith('power-seeking', {
        type: 'Open', content: 'Why?', assessment: '', feedback: '', other: [{ name: 'max-words', value: '80' }],
      }));
    });

    it('keeps the settings of each type while the type of a new question is switched', async () => {
      renderPage();
      await userEvent.click(box('Power-seeking'));
      await userEvent.click(screen.getByRole('button', { name: 'Add question' }));
      const form = within(screen.getByTestId('question-form'));
      await userEvent.click(form.getByRole('button', { name: 'Choice' }));
      expect((form.getByLabelText('Value of shuffle') as HTMLTextAreaElement).value).toBe('true');
      await userEvent.click(form.getByRole('button', { name: 'Open' }));
      expect(form.queryByLabelText('Value of shuffle')).toBeNull();
    });

    it('offers at most six options', async () => {
      renderPage();
      await userEvent.click(box('Power-seeking'));
      await userEvent.click(screen.getByRole('button', { name: 'Add question' }));
      const form = within(screen.getByTestId('question-form'));
      await userEvent.click(form.getByRole('button', { name: 'Choice' }));
      for (let i = 0; i < 4; i++) await userEvent.click(form.getByRole('button', { name: 'Add option' }));
      expect(form.getByLabelText('Option 6')).toBeTruthy();
      expect(form.queryByRole('button', { name: 'Add option' })).toBeNull();
    });

    it('asks for the question itself, and shows why one could not be added', async () => {
      map.addQuestion = vi.fn(async () => 'The questions of this file have pending suggestions.');
      renderPage();
      await userEvent.click(box('Power-seeking'));
      await userEvent.click(screen.getByRole('button', { name: 'Add question' }));
      const form = within(screen.getByTestId('question-form'));
      await userEvent.click(form.getByRole('button', { name: 'Add question' }));
      expect(form.getByRole('alert').textContent).toBe('Write the question.');
      expect(map.addQuestion).not.toHaveBeenCalled();
      await userEvent.type(form.getByLabelText('Question'), 'Why?');
      await userEvent.click(form.getByRole('button', { name: 'Add question' }));
      expect((await form.findByRole('alert')).textContent).toBe('The questions of this file have pending suggestions.');
      // The form stays, with what was typed
      expect((form.getByLabelText('Question') as HTMLTextAreaElement).value).toBe('Why?');

      await userEvent.click(form.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByTestId('question-form')).toBeNull();
      expect(screen.getByTestId('idea-panel')).toBeTruthy();
    });

    it('offers no question for an idea that has no file', async () => {
      renderPage();
      await userEvent.click(box('Orthogonality thesis'));
      expect(screen.queryByRole('button', { name: 'Add question' })).toBeNull();
    });

    it('cancel closes the form and writes nothing', async () => {
      renderPage();
      await userEvent.click(screen.getByRole('button', { name: 'Add concept' }));
      await userEvent.click(box('Power-seeking'));
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByTestId('idea-form')).toBeNull();
      expect(map.createIdea).not.toHaveBeenCalled();
      // Clicks select again
      await userEvent.click(box('Power-seeking'));
      expect(screen.getByTestId('idea-panel')).toBeTruthy();
    });
  });

  describe('editing and deleting', () => {
    const RANKING = '#### Question: Ranking\nid:: r\ncontent:: Order these.\nitems::\n- A\n- B\n';
    const CHOICE = '#### Question: Choice\nid:: c\ncontent:: Which?\noptions::\n- [x] A\n- B\nshuffle:: true\nmax-select:: 1\nexplanation:: Because.\n';
    const OPEN = '#### Question: Open\nid:: o\ncontent:: Why?\nSay it in your words.\nassessment-instructions::\n- 60: a\n- 40: b\nmax-words:: 80\n';
    const withQuestions = () => buildIdeaGraph([
      { name: 'Goals', docId: 'go', text: file(1, 'high', `Say what a goal is.\n\n## Tests\n${OPEN}\n${RANKING}\n${CHOICE}`) },
      { name: 'Plans', docId: 'pl', text: file(2, 'low', 'Plan.\n\n## Requires\n- [[Goals]]\n') },
      { name: 'Aims', docId: 'ai', text: file(3, 'low', 'Aim.\n\n## Requires\n- [[Goals]]\n\n## Helpful first\n- [[Plans]]\n') },
      { name: 'Hopes', docId: 'ho', text: file(4, 'low', 'Hope.\n\n## Helpful first\n- [[Goals]]\n') },
    ]);

    it('edits a concept: every part as the file has it, saved as before and after', async () => {
      renderPage();
      await userEvent.click(box('Instrumental convergence'));
      await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
      expect(screen.getByRole('heading', { name: 'Edit concept' })).toBeTruthy();
      const before = ideaAsEdit('Instrumental convergence', graph.byKey.get('instrumental convergence')!.idea!, { neededFor: ['Power-seeking'], helpfulFor: [] });
      expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Instrumental convergence');
      expect(screen.getByLabelText('Outcome')).toHaveProperty('value', 'Explain why agents share sub-goals.');
      expect(screen.getByLabelText('Priority')).toHaveProperty('value', 'high');
      expect(screen.getByLabelText('Why it matters')).toHaveProperty('value', 'It underlies the risk argument.');
      expect(screen.getByLabelText('Lenses')).toHaveProperty('value', '- Start with [[../Lenses/A lens|the first lens]] (11 minutes).\n- [[../Lenses/Not there]]');
      expect(screen.getByLabelText('Courses')).toHaveProperty('value', '');
      expect(names('helpful')).toEqual(['Orthogonality thesis']);
      expect(box('Instrumental convergence').textContent).toBe('Instrumental convergenceThis concept');
      expect(screen.getByText('The name is the file name.')).toBeTruthy();

      fireEvent.change(screen.getByLabelText('Outcome'), { target: { value: 'Explain it.\nIn two lines.' } });
      await userEvent.selectOptions(screen.getByLabelText('Priority'), 'low');
      expect(screen.getByLabelText('Topic')).toHaveProperty('value', '');
      await userEvent.type(screen.getByLabelText('Topic'), 'Risk arguments');
      fireEvent.change(screen.getByLabelText('Courses'), { target: { value: '../courses/A' } });
      // Requirements are picked in the map, as in "Edit requirements"; itself cannot be
      await userEvent.click(box('Corrigibility'));
      await userEvent.click(box('Instrumental convergence'));
      expect(names('requires')).toEqual(['Corrigibility']);
      expect(screen.getByRole('status').textContent).toMatch(/^This makes a circle of requirements/);

      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(screen.queryByTestId('idea-form')).toBeNull());
      expect(map.editIdea).toHaveBeenCalledWith('instrumental convergence', before, {
        ...before,
        outcome: 'Explain it.\nIn two lines.',
        priority: 'low',
        topic: 'Risk arguments',
        courses: ['../courses/A'],
        requires: ['Corrigibility'],
      });
      expect(within(screen.getByTestId('idea-panel')).getByRole('heading', { name: 'Instrumental convergence' })).toBeTruthy();
    });

    it('renames a concept: said before saving, a taken name refused, the idea selected under its new name', async () => {
      renderPage();
      await userEvent.click(box('Power-seeking'));
      await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
      const name = screen.getByLabelText('Name');
      fireEvent.change(name, { target: { value: 'corrigibility' } });
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(screen.getByText('A file with this name already exists.')).toBeTruthy();
      expect(map.editIdea).not.toHaveBeenCalled();
      // Its own name in other letters is a rename like any other
      fireEvent.change(name, { target: { value: 'Power-Seeking' } });
      expect(screen.getByText('Saving renames the file. Links to it in other concepts get the new name.')).toBeTruthy();
      fireEvent.change(name, { target: { value: ' Orthogonality thesis ' } });
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(screen.queryByTestId('idea-form')).toBeNull());
      expect(map.editIdea).toHaveBeenCalledWith('power-seeking', expect.objectContaining({ name: 'Power-seeking' }), expect.objectContaining({ name: 'Orthogonality thesis', requires: ['Instrumental convergence'] }));
      expect(within(screen.getByTestId('idea-panel')).getByRole('heading', { name: 'Orthogonality thesis' })).toBeTruthy();
    });

    it('keeps the form open and says why when a concept could not be saved', async () => {
      map.editIdea = vi.fn(async () => 'This concept was changed in the file meanwhile.');
      renderPage();
      await userEvent.click(box('Power-seeking'));
      await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
      fireEvent.change(screen.getByLabelText('Why it matters'), { target: { value: 'New.' } });
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect((await screen.findByRole('alert')).textContent).toBe('This concept was changed in the file meanwhile.');
      expect(screen.getByLabelText('Why it matters')).toHaveProperty('value', 'New.');
    });

    it('deletes a concept after a step that names it and the concepts that list it', async () => {
      map.graph = withQuestions();
      renderPage();
      await userEvent.click(box('Goals'));
      const panel = within(screen.getByTestId('idea-panel'));
      await userEvent.click(panel.getByRole('button', { name: 'Delete' }));
      const confirm = within(panel.getByRole('group', { name: 'Delete concept' }));
      expect([...screen.getByTestId('idea-confirm').querySelectorAll('p')].map((p) => p.textContent)).toEqual([
        'Delete the concept "Goals"?',
        'Aims and Plans list it as required; those links are removed too.',
        'Hopes lists it as helpful first; that link is removed too.',
        'Its 3 questions go with it.',
        'The file moves to the trash.',
      ]);
      await userEvent.click(confirm.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByTestId('idea-confirm')).toBeNull();
      expect(map.deleteIdea).not.toHaveBeenCalled();

      await userEvent.click(panel.getByRole('button', { name: 'Delete' }));
      await userEvent.click(screen.getByRole('button', { name: 'Delete concept' }));
      await waitFor(() => expect(screen.queryByTestId('idea-panel')).toBeNull());
      expect(map.deleteIdea).toHaveBeenCalledWith('goals');
    });

    it('keeps the concept and says why when it could not be deleted', async () => {
      map.deleteIdea = vi.fn(async () => 'Nothing was deleted: Lens Edu/courses/X.md links to this concept too.');
      renderPage();
      await userEvent.click(box('Corrigibility'));
      await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
      expect(screen.getByTestId('idea-confirm').textContent).toContain('Delete the concept "Corrigibility"?');
      await userEvent.click(screen.getByRole('button', { name: 'Delete concept' }));
      expect((await screen.findByRole('alert')).textContent).toBe('Nothing was deleted: Lens Edu/courses/X.md links to this concept too.');
      expect(screen.getByTestId('idea-panel')).toBeTruthy();
      // The step does not follow to another concept
      await userEvent.click(box('Power-seeking'));
      expect(screen.queryByTestId('idea-confirm')).toBeNull();
    });

    it('lists each question by its first line, with what can be done with it', async () => {
      map.graph = withQuestions();
      renderPage();
      await userEvent.click(box('Goals'));
      const rows = [...screen.getByTestId('idea-questions').querySelectorAll(':scope > li')];
      expect(rows.map((li) => li.querySelector('[data-testid="idea-question-text"]')!.textContent)).toEqual(['Why? …', 'Order these.', 'Which?']);
      expect(rows.map((li) => li.querySelector('[data-testid="idea-question-actions"]')!.textContent)).toEqual([
        'EditDelete',
        'Open fileThis kind of question is edited in the file.Delete',
        'EditDelete',
      ]);
      await userEvent.click(within(rows[1] as HTMLElement).getByRole('link', { name: 'Open file' }));
      expect(onNavigate).toHaveBeenLastCalledWith(expect.stringMatching(/-go$/));
    });

    it('edits an open question: every field as written, the type fixed, saved with what it was', async () => {
      map.graph = withQuestions();
      renderPage();
      await userEvent.click(box('Goals'));
      const before = map.graph.byKey.get('goals')!.idea!.questionList[0];
      await userEvent.click(screen.getByRole('button', { name: 'Edit question 1' }));
      const form = within(screen.getByTestId('question-form'));
      expect(form.getByRole('heading', { name: 'Edit question' })).toBeTruthy();
      expect(form.getByText('of Goals')).toBeTruthy();
      expect(form.getByTestId('question-type').textContent).toBe('Open');
      expect(form.queryByRole('button', { name: 'Choice' })).toBeNull();
      expect(form.getByLabelText('Question')).toHaveProperty('value', 'Why?\nSay it in your words.');
      expect(form.getByLabelText('How to grade it')).toHaveProperty('value', '- 60: a\n- 40: b');
      expect(form.getByLabelText('How the tutor should respond')).toHaveProperty('value', '');
      expect(form.getByLabelText('Value of max-words')).toHaveProperty('value', '80');

      fireEvent.change(form.getByLabelText('How to grade it'), { target: { value: '- 70: a\n- 30: b' } });
      fireEvent.change(form.getByLabelText('Value of max-words'), { target: { value: '120' } });
      await userEvent.click(form.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(screen.queryByTestId('question-form')).toBeNull());
      expect(map.editQuestion).toHaveBeenCalledWith('goals', 0, before, {
        type: 'Open', content: 'Why?\nSay it in your words.', assessment: '- 70: a\n- 30: b', feedback: '', other: [{ name: 'max-words', value: '120' }],
      });
      expect(map.addQuestion).not.toHaveBeenCalled();
      expect(within(screen.getByTestId('idea-panel')).getByRole('heading', { name: 'Goals' })).toBeTruthy();
    });

    it('edits a choice question: options, right answers, explanation and settings', async () => {
      map.graph = withQuestions();
      renderPage();
      await userEvent.click(box('Goals'));
      const before = map.graph.byKey.get('goals')!.idea!.questionList[2];
      await userEvent.click(screen.getByRole('button', { name: 'Edit question 3' }));
      const form = within(screen.getByTestId('question-form'));
      expect(form.getByLabelText('Option 1')).toHaveProperty('value', 'A');
      expect(form.getByLabelText('Option 1 is a right answer')).toHaveProperty('checked', true);
      expect(form.getByLabelText('Option 2 is a right answer')).toHaveProperty('checked', false);
      expect(form.getByLabelText('Explanation')).toHaveProperty('value', 'Because.');
      await userEvent.click(form.getByLabelText('Option 2 is a right answer'));
      await userEvent.click(form.getByRole('button', { name: 'Remove setting max-select' }));
      await userEvent.click(form.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(map.editQuestion).toHaveBeenCalledWith('goals', 2, before, {
        type: 'Choice',
        content: 'Which?',
        options: [{ text: 'A', correct: true }, { text: 'B', correct: true }],
        explanation: 'Because.',
        other: [{ name: 'shuffle', value: 'true' }],
      }));
    });

    it('does not check an existing question in the form, and shows why it could not be saved', async () => {
      map.graph = withQuestions();
      map.editQuestion = vi.fn(async () => 'This question was changed in the file meanwhile.');
      renderPage();
      await userEvent.click(box('Goals'));
      await userEvent.click(screen.getByRole('button', { name: 'Edit question 1' }));
      const form = within(screen.getByTestId('question-form'));
      fireEvent.change(form.getByLabelText('Question'), { target: { value: '' } });
      await userEvent.click(form.getByRole('button', { name: 'Save' }));
      expect((await form.findByRole('alert')).textContent).toBe('This question was changed in the file meanwhile.');
      expect(map.editQuestion).toHaveBeenCalled();
    });

    it('deletes a question after a confirm step, with what it said', async () => {
      map.graph = withQuestions();
      map.deleteQuestion = vi.fn(async () => (vi.mocked(map.deleteQuestion).mock.calls.length === 1 ? 'This question has a pending suggestion.' : null));
      renderPage();
      await userEvent.click(box('Goals'));
      const before = map.graph.byKey.get('goals')!.idea!.questionList[1];
      await userEvent.click(screen.getByRole('button', { name: 'Delete question 2' }));
      const confirm = within(screen.getByRole('group', { name: 'Delete question' }));
      expect(confirm.getByText('Delete question 2 from the file?')).toBeTruthy();
      await userEvent.click(confirm.getByRole('button', { name: 'Cancel' }));
      expect(map.deleteQuestion).not.toHaveBeenCalled();

      await userEvent.click(screen.getByRole('button', { name: 'Delete question 2' }));
      await userEvent.click(screen.getByRole('button', { name: 'Delete question' }));
      expect((await screen.findByRole('alert')).textContent).toBe('This question has a pending suggestion.');
      await userEvent.click(screen.getByRole('button', { name: 'Delete question' }));
      await waitFor(() => expect(screen.queryByTestId('idea-confirm')).toBeNull());
      expect(map.deleteQuestion).toHaveBeenLastCalledWith('goals', 1, before);
    });
  });

  describe('selecting several', () => {
    const chosen = () => [...document.querySelectorAll<HTMLElement>('[data-chosen]')].map((el) => el.dataset.idea);
    const count = () => screen.queryByTestId('idea-selection-count')?.textContent ?? null;

    it('adds and removes with Ctrl, Cmd or Shift and a click; a plain click still opens the panel', async () => {
      renderPage();
      expect(count()).toBeNull();
      fireEvent.click(box('Power-seeking'), { ctrlKey: true });
      fireEvent.click(box('Corrigibility'), { metaKey: true });
      fireEvent.click(box('Orthogonality thesis'), { shiftKey: true });
      // The boxes are drawn in the layout's order, which is not the order of the clicks
      expect(chosen().sort()).toEqual(['Corrigibility', 'Orthogonality thesis', 'Power-seeking']);
      expect(count()).toBe('3 selected');
      expect(screen.queryByTestId('idea-panel')).toBeNull();
      expect(box('Power-seeking').getAttribute('aria-pressed')).toBe('true');
      expect(box('Power-seeking').querySelector('[data-testid="idea-chosen-tick"]')).toBeTruthy();

      fireEvent.click(box('Corrigibility'), { ctrlKey: true });
      expect(count()).toBe('2 selected');
      // A plain click opens the panel and leaves the selection alone
      await userEvent.click(box('Instrumental convergence'));
      expect(screen.getByTestId('idea-panel')).toBeTruthy();
      expect(count()).toBe('2 selected');
    });

    it('clears with Escape or "Clear": first the selection, then the panel', async () => {
      renderPage();
      await userEvent.click(box('Instrumental convergence'));
      fireEvent.click(box('Power-seeking'), { ctrlKey: true });
      await userEvent.keyboard('{Escape}');
      expect(count()).toBeNull();
      expect(screen.getByTestId('idea-panel')).toBeTruthy();
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByTestId('idea-panel')).toBeNull();

      fireEvent.click(box('Power-seeking'), { ctrlKey: true });
      await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
      expect(chosen()).toEqual([]);
    });

    it('has a box per row in the Table view and one for every row shown', async () => {
      renderPage('edit', '/concept-map?view=table');
      const table = within(screen.getByTestId('idea-table'));
      await userEvent.click(table.getByRole('checkbox', { name: 'Select Power-seeking' }));
      expect(count()).toBe('1 selected');
      // The box does not open the panel
      expect(screen.queryByTestId('idea-panel')).toBeNull();
      const all = table.getByRole('checkbox', { name: 'Select every concept' }) as HTMLInputElement;
      expect(all.checked).toBe(false);
      expect(all.indeterminate).toBe(true);
      await userEvent.click(all);
      expect(count()).toBe('4 selected');
      expect(all.checked).toBe(true);
      await userEvent.click(all);
      expect(count()).toBeNull();

      // With the find box: only the rows shown
      await userEvent.type(screen.getByLabelText('Find a concept'), 'co');
      await userEvent.click(table.getByRole('checkbox', { name: 'Select every concept shown' }));
      expect(chosen()).toEqual(['Corrigibility', 'Instrumental convergence']);
      // Ctrl and a click on a row does the same as its box
      fireEvent.click(document.querySelector('tr[data-idea="Corrigibility"]')!, { ctrlKey: true });
      expect(chosen()).toEqual(['Instrumental convergence']);
    });

    it('selects by Ctrl and a click in the Order view too', async () => {
      renderPage('edit', '/concept-map?view=order');
      const order = screen.getByTestId('idea-order');
      fireEvent.click(order.querySelector('[data-idea="Corrigibility"]')!, { ctrlKey: true });
      expect(count()).toBe('1 selected');
      expect(order.querySelector('[data-idea="Corrigibility"]')!.getAttribute('data-chosen')).toBe('true');
    });

    it('asks once before deleting them all, with what goes and which concepts lose a link', async () => {
      map.deleteIdeas = vi.fn(async () => (vi.mocked(map.deleteIdeas).mock.calls.length === 1 ? 'Deleted: Instrumental convergence. Not deleted: Power-seeking.' : null));
      renderPage();
      fireEvent.click(box('Instrumental convergence'), { ctrlKey: true });
      fireEvent.click(box('Power-seeking'), { ctrlKey: true });
      fireEvent.click(box('Orthogonality thesis'), { ctrlKey: true });
      const bar = within(screen.getByTestId('idea-selection'));
      await userEvent.click(bar.getByRole('button', { name: 'Delete' }));
      const confirm = within(screen.getByRole('group', { name: 'Delete the selected concepts' }));
      expect(confirm.getByText('Delete these 2 concepts?')).toBeTruthy();
      expect([...screen.getByTestId('idea-delete-list').children].map((li) => li.textContent)).toEqual(['Instrumental convergence', 'Power-seeking']);
      expect(screen.getByTestId('idea-delete-unwritten').textContent).toBe('Orthogonality thesis is not written yet and has no file: deleting it takes every link to it out.');
      expect([...screen.getByTestId('idea-delete-losing').children].map((li) => li.textContent)).toEqual(['Corrigibility (to Power-seeking)']);
      expect(confirm.getByText('2 questions go with them.')).toBeTruthy();
      expect(confirm.getByText('The file moves to the trash.')).toBeTruthy();
      // Enter confirms: the focus is on the button that deletes
      expect(document.activeElement).toBe(confirm.getByRole('button', { name: 'Delete 2 concepts' }));

      await userEvent.click(confirm.getByRole('button', { name: 'Cancel' }));
      expect(map.deleteIdeas).not.toHaveBeenCalled();
      expect(count()).toBe('3 selected');

      await userEvent.click(bar.getByRole('button', { name: 'Delete' }));
      await userEvent.keyboard('{Enter}');
      expect((await screen.findByRole('alert')).textContent).toBe('Deleted: Instrumental convergence. Not deleted: Power-seeking.');
      expect(map.deleteIdeas).toHaveBeenLastCalledWith(['instrumental convergence', 'power-seeking', 'orthogonality thesis']);
      expect(count()).toBe('3 selected');
      await userEvent.click(screen.getByRole('button', { name: 'Delete 2 concepts' }));
      await waitFor(() => expect(count()).toBeNull());
    });

    it('says that only links go when nothing selected has a file', async () => {
      renderPage();
      fireEvent.click(box('Orthogonality thesis'), { ctrlKey: true });
      await userEvent.click(within(screen.getByTestId('idea-selection')).getByRole('button', { name: 'Delete' }));
      expect(screen.queryByTestId('idea-delete-list')).toBeNull();
      expect([...screen.getByTestId('idea-delete-losing').children].map((li) => li.textContent)).toEqual(['Instrumental convergence (to Orthogonality thesis)']);
      await userEvent.click(screen.getByRole('button', { name: 'Remove the links' }));
      await waitFor(() => expect(map.deleteIdeas).toHaveBeenCalledWith(['orthogonality thesis']));
    });

    it('takes the links to a concept that is not written yet out from its panel', async () => {
      renderPage();
      await userEvent.click(box('Orthogonality thesis'));
      await userEvent.click(screen.getByRole('button', { name: 'Remove links' }));
      const confirm = within(screen.getByRole('group', { name: 'Remove links' }));
      expect(confirm.getByText('Take every link to "Orthogonality thesis" out?')).toBeTruthy();
      expect(confirm.getByText(/^Instrumental convergence names it\./)).toBeTruthy();
      await userEvent.click(confirm.getByRole('button', { name: 'Remove links' }));
      await waitFor(() => expect(screen.queryByTestId('idea-panel')).toBeNull());
      expect(map.deleteIdeas).toHaveBeenCalledWith(['orthogonality thesis']);
      expect(map.deleteIdea).not.toHaveBeenCalled();
    });

    it('keeps picking requirements while a form is open, and selects nothing for a link that cannot edit', async () => {
      const { unmount } = renderPage();
      fireEvent.click(box('Corrigibility'), { ctrlKey: true });
      await userEvent.click(screen.getByRole('button', { name: 'Add concept' }));
      // The form is open: no bar, and Shift with a click picks "helpful first"
      expect(count()).toBeNull();
      expect(chosen()).toEqual([]);
      fireEvent.click(box('Power-seeking'), { shiftKey: true });
      expect(names('helpful')).toEqual(['Power-seeking']);
      await userEvent.click(within(screen.getByTestId('idea-form')).getByRole('button', { name: 'Cancel' }));
      expect(count()).toBe('1 selected');
      unmount();

      renderPage('view', '/concept-map?view=table');
      expect(screen.queryByRole('checkbox')).toBeNull();
      fireEvent.click(document.querySelector('tr[data-idea="Corrigibility"]')!, { ctrlKey: true });
      expect(count()).toBeNull();
      expect(screen.getByTestId('idea-panel')).toBeTruthy();
    });
  });

  describe('profiles', () => {
    let profiles: IdeaProfiles;
    beforeEach(() => {
      profiles = {
        current: 'Main',
        names: ['Main', 'Draft', 'Talk in Berlin'],
        open: vi.fn(),
        create: vi.fn(async () => null),
        rename: vi.fn(async () => null),
        remove: vi.fn(async () => null),
        copyTo: vi.fn(async () => ({ copied: ['Power-seeking'], skipped: ['Corrigibility'] })),
      };
      map.profiles = profiles;
    });
    const switcher = () => screen.getByRole('button', { name: 'Profile: Main' });
    const items = () => [...screen.getByRole('menu').querySelectorAll('[role^="menuitem"]')].map((el) => el.textContent);

    it('remembers what the walk has shown per profile', async () => {
      localStorage.clear();
      renderPage('edit', '/concept-map?view=walk');
      await userEvent.click(screen.getByTestId('walk-start'));
      expect(JSON.parse(localStorage.getItem('concept-map-walk-seen:profile:Main')!)).toEqual(['orthogonality thesis']);
    });

    it('shows no switcher and no "Copy to…" where the hook has no profiles', () => {
      map.profiles = undefined;
      renderPage();
      expect(screen.queryByTestId('profile-switcher')).toBeNull();
      fireEvent.click(box('Power-seeking'), { ctrlKey: true });
      expect(screen.queryByRole('button', { name: 'Copy to…' })).toBeNull();
      expect(screen.getByText('Context Accelerator')).toBeTruthy();
    });

    it('switches profile from the menu next to the title, by mouse or by keyboard', async () => {
      renderPage();
      await userEvent.click(switcher());
      expect(items()).toEqual(['✓Main', 'Draft', 'Talk in Berlin', 'New profile…', 'Rename…', 'Delete profile…']);
      await userEvent.click(screen.getByRole('menuitemradio', { name: 'Draft' }));
      expect(profiles.open).toHaveBeenLastCalledWith('Draft');
      expect(screen.queryByRole('menu')).toBeNull();

      switcher().focus();
      await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{Enter}');
      expect(profiles.open).toHaveBeenLastCalledWith('Talk in Berlin');
      // Escape closes only the menu, and the focus is back on the button
      await userEvent.keyboard('{Enter}');
      expect(screen.getByRole('menu')).toBeTruthy();
      await userEvent.keyboard('{End}');
      expect(document.activeElement!.textContent).toBe('Delete profile…');
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('menu')).toBeNull();
      expect(document.activeElement).toBe(switcher());
    });

    it('makes a new profile, empty or as a copy, once the name is one that can be used', async () => {
      renderPage();
      await userEvent.click(switcher());
      await userEvent.click(screen.getByRole('menuitem', { name: 'New profile…' }));
      const form = within(screen.getByTestId('profile-form'));
      const name = form.getByLabelText('Profile name');
      expect(document.activeElement).toBe(name);
      expect((form.getByLabelText('Start empty') as HTMLInputElement).checked).toBe(true);
      await userEvent.keyboard('{Enter}');
      expect(form.getByRole('alert').textContent).toBe('Give the profile a name.');
      await userEvent.type(name, 'draft');
      expect(form.getByRole('alert').textContent).toBe('A profile with this name already exists.');
      expect(profiles.create).not.toHaveBeenCalled();
      await userEvent.clear(name);
      await userEvent.type(name, ' Second try {Enter}');
      await waitFor(() => expect(screen.queryByTestId('profile-form')).toBeNull());
      expect(profiles.create).toHaveBeenLastCalledWith('Second try', undefined);

      await userEvent.click(switcher());
      await userEvent.click(screen.getByRole('menuitem', { name: 'New profile…' }));
      await userEvent.type(screen.getByLabelText('Profile name'), 'A copy');
      await userEvent.click(screen.getByLabelText('Copy everything from Main'));
      vi.mocked(profiles.create).mockResolvedValueOnce('The disk is full.');
      await userEvent.click(screen.getByRole('button', { name: 'Create profile' }));
      expect((await screen.findByRole('alert')).textContent).toBe('The disk is full.');
      expect(profiles.create).toHaveBeenLastCalledWith('A copy', 'Main');
      // Escape closes the small form
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByTestId('profile-form')).toBeNull();
    });

    it('renames the profile, and deletes it after a confirm step with its number of concepts', async () => {
      renderPage();
      await userEvent.click(switcher());
      await userEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }));
      const name = screen.getByLabelText('Profile name') as HTMLInputElement;
      expect(name.value).toBe('Main');
      await userEvent.clear(name);
      await userEvent.type(name, 'Mainline{Enter}');
      await waitFor(() => expect(screen.queryByTestId('profile-form')).toBeNull());
      expect(profiles.rename).toHaveBeenCalledWith('Main', 'Mainline');

      await userEvent.click(switcher());
      await userEvent.click(screen.getByRole('menuitem', { name: 'Delete profile…' }));
      const confirm = within(screen.getByRole('group', { name: 'Delete profile' }));
      expect(confirm.getByText('Delete the profile "Main"?')).toBeTruthy();
      expect(confirm.getByText('Its 3 concepts are deleted with it.')).toBeTruthy();
      await userEvent.click(confirm.getByRole('button', { name: 'Delete profile' }));
      await waitFor(() => expect(screen.queryByTestId('idea-confirm')).toBeNull());
      expect(profiles.remove).toHaveBeenCalledWith('Main');
      // The first of the others opens
      expect(profiles.open).toHaveBeenCalledWith('Draft');
    });

    it('does not offer to delete the last profile left', async () => {
      profiles.names = ['Main'];
      renderPage();
      await userEvent.click(switcher());
      expect(items()).toEqual(['✓Main', 'New profile…', 'Rename…']);
    });

    it('copies the selected concepts into another profile and says what happened', async () => {
      renderPage();
      fireEvent.click(box('Power-seeking'), { ctrlKey: true });
      fireEvent.click(box('Corrigibility'), { ctrlKey: true });
      fireEvent.click(box('Orthogonality thesis'), { ctrlKey: true });
      const bar = within(screen.getByTestId('idea-selection'));
      await userEvent.click(bar.getByRole('button', { name: 'Copy to…' }));
      expect(items()).toEqual(['Draft', 'Talk in Berlin', 'New profile…']);
      await userEvent.click(screen.getByRole('menuitem', { name: 'Draft' }));
      // Only the written ones are copied
      expect(profiles.copyTo).toHaveBeenLastCalledWith(['corrigibility', 'power-seeking'], 'Draft', false);
      expect((await bar.findByRole('status')).textContent).toBe('1 copied to Draft; 1 was already there and was skipped. 1 not written yet was left out.');
      // The selection stays
      expect(screen.getByTestId('idea-selection-count').textContent).toBe('3 selected');

      vi.mocked(profiles.copyTo).mockResolvedValueOnce({ copied: ['Corrigibility'], skipped: [] });
      await userEvent.click(bar.getByRole('button', { name: 'Replace it' }));
      expect(profiles.copyTo).toHaveBeenLastCalledWith(['corrigibility'], 'Draft', true);
      expect((await bar.findByRole('status')).textContent).toBe('1 replaced in Draft.');
      expect(bar.queryByRole('button', { name: /Replace/ })).toBeNull();
      await userEvent.click(bar.getByRole('button', { name: 'Open Draft' }));
      expect(profiles.open).toHaveBeenCalledWith('Draft');
    });

    it('copies into a new profile without leaving this one, and shows an error from the copy', async () => {
      vi.mocked(profiles.copyTo).mockResolvedValueOnce({ error: 'The profile could not be read.' });
      renderPage();
      fireEvent.click(box('Power-seeking'), { ctrlKey: true });
      const bar = within(screen.getByTestId('idea-selection'));
      await userEvent.click(bar.getByRole('button', { name: 'Copy to…' }));
      await userEvent.click(screen.getByRole('menuitem', { name: 'New profile…' }));
      await userEvent.type(screen.getByLabelText('Profile name'), 'Workshop{Enter}');
      expect((await bar.findByRole('alert')).textContent).toBe('The profile could not be read.');
      expect(profiles.create).toHaveBeenCalledWith('Workshop', undefined, false);
      expect(profiles.copyTo).toHaveBeenCalledWith(['power-seeking'], 'Workshop', false);
      expect(profiles.open).not.toHaveBeenCalled();
    });

    it('says so when nothing selected can be copied', async () => {
      renderPage();
      fireEvent.click(box('Orthogonality thesis'), { ctrlKey: true });
      await userEvent.click(screen.getByRole('button', { name: 'Copy to…' }));
      expect(screen.getByRole('status').textContent).toBe('Nothing to copy: the selected concepts are not written yet, so they have no file.');
      expect(profiles.copyTo).not.toHaveBeenCalled();
    });

    it('closes the panel and clears the selection when another profile opens', async () => {
      const { rerender } = renderPage();
      await userEvent.click(box('Instrumental convergence'));
      fireEvent.click(box('Power-seeking'), { ctrlKey: true });
      await userEvent.type(screen.getByLabelText('Find a concept'), 'power');
      map = { ...map, profiles: { ...profiles, current: 'Draft' }, graph: buildIdeaGraph([]), total: 0, read: 0 };
      rerender(page());
      expect(screen.queryByTestId('idea-panel')).toBeNull();
      expect(screen.queryByTestId('idea-selection')).toBeNull();
      expect((screen.getByLabelText('Find a concept') as HTMLInputElement).value).toBe('');
      expect(screen.getByText('No concepts in this profile yet. Add the first one with "Add concept".')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Profile: Draft' })).toBeTruthy();
    });
  });

  describe('by keyboard', () => {
    const find = () => screen.getByLabelText('Find a concept') as HTMLInputElement;
    const panelOf = (name: string) => within(screen.getByTestId('idea-panel')).getByRole('heading', { name });
    const ctrlEnter = '{Control>}{Enter}{/Control}';

    it('lists what the search finds; arrows and Enter open one and the focus goes to its panel', async () => {
      renderPage();
      await userEvent.type(find(), 'co');
      // A name that starts with what is typed comes first
      expect(offered('Find a concept')).toEqual(['[Corrigibility]', 'Instrumental convergence']);
      expect(screen.getByTestId('idea-counts').textContent).toBe('2 found');
      await userEvent.keyboard('{ArrowDown}');
      expect(offered('Find a concept')).toEqual(['Corrigibility', '[Instrumental convergence]']);
      await userEvent.keyboard('{Enter}');
      expect(panelOf('Instrumental convergence')).toBeTruthy();
      expect(find().value).toBe('');
      expect(document.activeElement).toBe(screen.getByTestId('idea-panel'));
      expect(screen.getByTestId('idea-counts').textContent).toBe('3 concepts · 1 not written yet');
    });

    it('says when the search finds nothing; Escape empties the box and leaves the panel open', async () => {
      renderPage();
      await userEvent.click(box('Power-seeking'));
      await userEvent.type(find(), 'zzz');
      expect(within(screen.getByTestId('idea-find-rows')).getByText('No concept matches.')).toBeTruthy();
      await userEvent.keyboard('{Enter}{Escape}');
      expect(find().value).toBe('');
      expect(screen.queryByTestId('idea-find-rows')).toBeNull();
      expect(panelOf('Power-seeking')).toBeTruthy();
    });

    it('goes to the search box with "/", but not while typing in a field', async () => {
      renderPage();
      box('Power-seeking').focus();
      await userEvent.keyboard('/');
      expect(document.activeElement).toBe(find());
      expect(find().value).toBe('');
      await userEvent.keyboard('a/b');
      expect(find().value).toBe('a/b');
    });

    it('adds what the search finds to the selection of several with Ctrl+Enter, and keeps the text', async () => {
      renderPage();
      await userEvent.type(find(), 'o');
      await userEvent.keyboard(`${ctrlEnter}{ArrowDown}${ctrlEnter}`);
      expect(screen.getByTestId('idea-selection-count').textContent).toBe('2 selected');
      expect(find().value).toBe('o');
      expect(screen.queryByTestId('idea-panel')).toBeNull();
    });

    it('picks what the search finds into the list of an open form', async () => {
      renderPage();
      await userEvent.click(screen.getByRole('button', { name: 'Add concept' }));
      await userEvent.type(find(), 'pow{Enter}');
      expect(names('requires')).toEqual(['Power-seeking']);
      expect(find().value).toBe('');
      expect(document.activeElement).toBe(find());
      await userEvent.keyboard('corr{Shift>}{Enter}{/Shift}');
      expect(names('helpful')).toEqual(['Corrigibility']);
    });

    it('opens a focused idea with Enter, puts the focus on the panel, and gives it back on Escape', async () => {
      renderPage();
      box('Power-seeking').focus();
      await userEvent.keyboard('{Enter}');
      expect(panelOf('Power-seeking')).toBeTruthy();
      expect(document.activeElement).toBe(screen.getByTestId('idea-panel'));
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByTestId('idea-panel')).toBeNull();
      expect(document.activeElement).toBe(box('Power-seeking'));
    });

    it('keeps the focus in the panel when a name in it opens another idea, and returns it on "Close"', async () => {
      renderPage();
      await userEvent.click(box('Power-seeking'));
      await userEvent.click(within(screen.getByTestId('idea-panel')).getByRole('button', { name: 'Corrigibility' }));
      expect(panelOf('Corrigibility')).toBeTruthy();
      expect(document.activeElement).toBe(screen.getByTestId('idea-panel'));
      await userEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(document.activeElement).toBe(box('Corrigibility'));
    });

    it('selects several with Ctrl+Enter or Shift+Enter on a focused idea, in each view', async () => {
      const { unmount } = renderPage();
      box('Power-seeking').focus();
      await userEvent.keyboard(ctrlEnter);
      box('Corrigibility').focus();
      await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
      expect(screen.getByTestId('idea-selection-count').textContent).toBe('2 selected');
      expect(screen.queryByTestId('idea-panel')).toBeNull();
      await userEvent.keyboard(ctrlEnter);
      expect(screen.getByTestId('idea-selection-count').textContent).toBe('1 selected');
      unmount();

      for (const view of ['order', 'table']) {
        const shown = renderPage('edit', `/concept-map?view=${view}`);
        screen.getByTestId(`idea-${view}`).querySelector<HTMLElement>('[data-key="power-seeking"]')!.focus();
        await userEvent.keyboard(ctrlEnter);
        expect(screen.getByTestId('idea-selection-count').textContent).toBe('1 selected');
        expect(screen.queryByTestId('idea-panel')).toBeNull();
        shown.unmount();
      }
    });

    it('starts "Add concept" in the name; Enter there moves on instead of creating; Ctrl+Enter creates and says so', async () => {
      renderPage();
      await userEvent.click(screen.getByRole('button', { name: 'Add concept' }));
      expect(document.activeElement).toBe(screen.getByLabelText('Name'));
      await userEvent.keyboard('Deceptive alignment{Enter}');
      expect(map.createIdea).not.toHaveBeenCalled();
      expect(screen.getByTestId('idea-form')).toBeTruthy();
      expect(document.activeElement).toBe(screen.getByLabelText('Outcome'));
      await userEvent.keyboard(`Explain it.${ctrlEnter}`);
      await waitFor(() => expect(screen.queryByTestId('idea-form')).toBeNull());
      expect(vi.mocked(map.createIdea).mock.calls[0][0]).toMatchObject({ name: 'Deceptive alignment', outcome: 'Explain it.' });
      expect(screen.getByTestId('idea-notice').textContent).toBe('Created "Deceptive alignment".');
    });

    it('moves on from the topic with Enter instead of creating, and counts a typed topic as a change', async () => {
      renderPage();
      await userEvent.click(screen.getByRole('button', { name: 'Add concept' }));
      await userEvent.click(screen.getByLabelText('Topic'));
      await userEvent.keyboard('Control{Enter}');
      expect(map.createIdea).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(screen.getByLabelText('Why it matters'));
      // Not saved: the first Escape only says so
      await userEvent.keyboard('{Escape}');
      expect(screen.getByTestId('form-leave-note')).toBeTruthy();
      expect(screen.getByTestId('idea-form')).toBeTruthy();
    });

    it('closes a form with Escape: at once when nothing changed, after a second Escape when something did', async () => {
      renderPage();
      const add = screen.getByRole('button', { name: 'Add concept' });
      await userEvent.click(add);
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByTestId('idea-form')).toBeNull();
      expect(document.activeElement).toBe(add);

      await userEvent.click(add);
      await userEvent.keyboard('Half a name{Escape}');
      expect(screen.getByTestId('form-leave-note').textContent).toContain('Press Escape again');
      // Going on typing takes the warning back
      await userEvent.keyboard('!');
      expect(screen.queryByTestId('form-leave-note')).toBeNull();
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Half a name!');
      await userEvent.keyboard('{Escape}{Escape}');
      expect(screen.queryByTestId('idea-form')).toBeNull();
      expect(map.createIdea).not.toHaveBeenCalled();
    });

    it('asks before Escape discards a picked requirement, and closes the list of a pick box first', async () => {
      renderPage();
      await userEvent.click(box('Corrigibility'));
      await userEvent.click(screen.getByRole('button', { name: 'Edit requirements' }));
      const requires = screen.getByRole('combobox', { name: 'Requires' });
      expect(document.activeElement).toBe(requires);
      await userEvent.keyboard('instr');
      await userEvent.keyboard('{Escape}');
      // That Escape closed the list only
      expect(screen.getByTestId('idea-form')).toBeTruthy();
      expect(screen.queryByTestId('form-leave-note')).toBeNull();
      await userEvent.keyboard('{Enter}{Enter}');
      expect(names('requires')).toEqual(['Power-seeking', 'Instrumental convergence']);
      await userEvent.keyboard('{Escape}');
      expect(screen.getByTestId('form-leave-note')).toBeTruthy();
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByTestId('idea-form')).toBeNull();
      expect(map.saveRequirements).not.toHaveBeenCalled();
      // Back in the panel the form was opened from
      expect(document.activeElement).toBe(screen.getByTestId('idea-panel'));
    });

    it('presses the buttons of the panel with E, R, Q and Delete while the focus is in it', async () => {
      renderPage();
      box('Power-seeking').focus();
      await userEvent.keyboard('{Enter}e');
      expect(screen.getByRole('form', { name: 'Edit concept' })).toBeTruthy();
      expect(document.activeElement).toBe(screen.getByLabelText('Name'));
      await userEvent.keyboard('{Escape}');
      expect(document.activeElement).toBe(screen.getByTestId('idea-panel'));

      await userEvent.keyboard('r');
      expect(screen.getByRole('heading', { name: 'Requirements of Power-seeking' })).toBeTruthy();
      await userEvent.keyboard('{Escape}q');
      expect(screen.getByTestId('question-form')).toBeTruthy();
      expect(document.activeElement).toBe(screen.getByLabelText('Question'));
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByTestId('question-form')).toBeNull();

      await userEvent.keyboard('{Delete}');
      const confirm = within(screen.getByTestId('idea-confirm'));
      expect(document.activeElement).toBe(confirm.getByRole('button', { name: 'Delete concept' }));
      // A letter does nothing while the step is open; Escape cancels it only
      await userEvent.keyboard('e{Escape}');
      expect(screen.queryByTestId('idea-confirm')).toBeNull();
      expect(screen.queryByTestId('idea-form')).toBeNull();
      expect(document.activeElement).toBe(screen.getByTestId('idea-panel'));

      await userEvent.keyboard('{Delete}{Enter}');
      await waitFor(() => expect(screen.getByTestId('idea-notice').textContent).toBe('Deleted "Power-seeking".'));
      expect(map.deleteIdea).toHaveBeenCalledWith('power-seeking');
      expect(document.activeElement).toBe(find());
    });

    it('has no letter keys in the panel of a link that cannot edit', async () => {
      renderPage('view');
      box('Power-seeking').focus();
      await userEvent.keyboard('{Enter}e{Delete}');
      expect(screen.queryByTestId('idea-form')).toBeNull();
      expect(screen.queryByTestId('idea-confirm')).toBeNull();
      expect(panelOf('Power-seeking')).toBeTruthy();
    });

    it('gives the focus back to the button that asked when a delete is cancelled', async () => {
      renderPage();
      await userEvent.click(box('Power-seeking'));
      const remove = screen.getByRole('button', { name: 'Delete' });
      await userEvent.click(remove);
      await userEvent.click(within(screen.getByTestId('idea-confirm')).getByRole('button', { name: 'Cancel' }));
      expect(document.activeElement).toBe(remove);
    });

    it('fills a choice question without the mouse: Enter after the last option adds the next, Ctrl+Enter adds the question', async () => {
      renderPage();
      await userEvent.click(box('Power-seeking'));
      await userEvent.click(screen.getByRole('button', { name: 'Add question' }));
      const form = within(screen.getByTestId('question-form'));
      await userEvent.click(form.getByRole('button', { name: 'Choice' }));
      await userEvent.type(form.getByLabelText('Question'), 'Which one?');
      await userEvent.type(form.getByLabelText('Option 1'), 'First{Enter}');
      expect(document.activeElement).toBe(form.getByLabelText('Option 2'));
      await userEvent.keyboard('Second{Enter}');
      expect(document.activeElement).toBe(form.getByLabelText('Option 3'));
      expect(map.addQuestion).not.toHaveBeenCalled();
      await userEvent.keyboard('Third');
      await userEvent.click(form.getByLabelText('Option 1 is a right answer'));
      await userEvent.type(form.getByLabelText('Explanation'), `Because.${ctrlEnter}`);
      await waitFor(() => expect(screen.queryByTestId('question-form')).toBeNull());
      expect(vi.mocked(map.addQuestion).mock.calls[0][1]).toMatchObject({
        type: 'Choice',
        content: 'Which one?',
        options: [{ text: 'First', correct: true }, { text: 'Second', correct: false }, { text: 'Third', correct: false }],
        explanation: 'Because.',
      });
      expect(screen.getByTestId('idea-notice').textContent).toBe('Added the question to "Power-seeking".');
      expect(document.activeElement).toBe(screen.getByTestId('idea-panel'));
    });

    it('says why a click on a concept does nothing while a question is written', async () => {
      renderPage();
      await userEvent.click(box('Power-seeking'));
      await userEvent.click(screen.getByRole('button', { name: 'Add question' }));
      await userEvent.type(screen.getByLabelText('Question'), 'Why?');
      await userEvent.click(box('Corrigibility'));
      expect(screen.getByTestId('idea-notice').textContent).toBe('Save or cancel the question first.');
      expect((screen.getByLabelText('Question') as HTMLTextAreaElement).value).toBe('Why?');
      expect(screen.getByRole('button', { name: 'Add concept' }).title).toBe('Save or cancel the question first.');
    });

    it('says what was saved', async () => {
      renderPage();
      await userEvent.click(box('Corrigibility'));
      await userEvent.click(screen.getByRole('button', { name: 'Edit requirements' }));
      await userEvent.click(screen.getByRole('button', { name: 'Save requirements' }));
      await waitFor(() => expect(screen.getByTestId('idea-notice').textContent).toBe('Saved the requirements of "Corrigibility".'));
      expect(document.activeElement).toBe(screen.getByTestId('idea-panel'));

      await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
      const name = screen.getByLabelText('Name');
      await userEvent.clear(name);
      await userEvent.type(name, 'Corrigible agents');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(screen.getByTestId('idea-notice').textContent).toBe('Saved "Corrigible agents" (renamed from "Corrigibility").'));
    });

    it('walks through the concepts: Enter starts, arrow right and left move, "Open" and Escape go to the panel and back', async () => {
      localStorage.clear();
      renderPage('edit', '/concept-map?view=walk');
      const shown = () => screen.getByTestId('walk-step').querySelector<HTMLElement>('[data-walk-card]')!;
      // A topic by Enter: its first concept, and the focus on it
      const topic = screen.getByTestId('walk-overview').querySelector<HTMLElement>('[data-topic="No topic"]')!;
      topic.focus();
      await userEvent.keyboard('{Enter}');
      expect(shown().dataset.idea).toBe('Orthogonality thesis');
      expect(document.activeElement).toBe(shown());
      await userEvent.keyboard('{ArrowRight}');
      expect(shown().dataset.idea).toBe('Instrumental convergence');
      // The end of the topic, and back
      await userEvent.keyboard('{ArrowRight}');
      expect(within(screen.getByTestId('walk-done')).getByRole('heading').textContent).toBe('Topic done');
      await userEvent.keyboard('{ArrowLeft}');
      expect(shown().dataset.idea).toBe('Instrumental convergence');

      // "Open" by Enter: the panel has the focus, and the arrow keys are its own there
      const open = within(screen.getByTestId('walk-step')).getByRole('button', { name: 'Open' });
      open.focus();
      await userEvent.keyboard('{Enter}');
      expect(panelOf('Instrumental convergence')).toBeTruthy();
      expect(document.activeElement).toBe(screen.getByTestId('idea-panel'));
      await userEvent.keyboard('{ArrowLeft}');
      expect(shown().dataset.idea).toBe('Instrumental convergence');
      // Escape closes the panel; the focus is back on the concept of the walk
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByTestId('idea-panel')).toBeNull();
      expect(document.activeElement).toBe(within(screen.getByTestId('walk-step')).getByRole('button', { name: 'Open' }));
      await userEvent.keyboard('{ArrowLeft}');
      expect(shown().dataset.idea).toBe('Orthogonality thesis');

      // "/" goes to the search box, where the arrow keys do not walk
      await userEvent.keyboard('/');
      expect(document.activeElement).toBe(find());
      await userEvent.keyboard('{ArrowRight}');
      expect(shown().dataset.idea).toBe('Orthogonality thesis');
    });
  });
});
