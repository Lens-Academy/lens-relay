import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../../contexts/AuthContext';
import { NavigationContext } from '../../contexts/NavigationContext';
import { buildIdeaGraph } from '../../lib/idea-map';
import type { UserRole } from '../../../shared/types';
import { ConceptMapPage } from './ConceptMapPage';
import { useIdeaMap, type IdeaMap } from './useIdeaMap';

vi.mock('./useIdeaMap', () => ({ useIdeaMap: vi.fn() }));

const file = (id: number, priority: string, body: string) =>
  `---\nid: 00000000-0000-4000-8000-00000000000${id}\npriority: ${priority}\n---\n${body}`;
const QUESTION = '#### Question: Open\nid:: 11111111-1111-4111-8111-111111111111\ncontent:: Why?\n';

const graph = buildIdeaGraph([
  {
    name: 'Instrumental convergence',
    docId: 'ic',
    text: file(1, 'high', `Explain why agents share sub-goals.\n\n## Helpful first\n- [[Orthogonality thesis]]\n\n## Why it matters\nIt underlies the risk argument.\n\n## Learn\n- Start with [[../Lenses/A lens|the first lens]] (11 minutes).\n- [[../Lenses/Not there]]\n\n## Questions\n${QUESTION}${QUESTION}`),
  },
  { name: 'Power-seeking', docId: 'ps', text: file(2, 'medium', 'Explain why power helps.\n\n## Requires\n- [[Instrumental convergence]]\n') },
  { name: 'Corrigibility', docId: 'co', text: file(3, 'low', '\n## Requires\n- [[Power-seeking]]\n') },
], { lensExists: (link) => link === '../Lenses/A lens' });

let map: IdeaMap;
const onNavigate = vi.fn();

function renderPage(role: UserRole = 'edit', url = '/concept-map') {
  return render(
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
    </AuthProvider>,
  );
}

const box = (name: string) => screen.getByTestId('idea-map').querySelector<HTMLElement>(`[data-idea="${name}"]`)!;
const names = (list: string) => [...screen.getByTestId('idea-form').querySelectorAll(`[data-list="${list}"] li span`)].map((el) => el.textContent);

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
      expect(screen.getByTestId('idea-map-legend').textContent).toBe('PriorityHighMediumLowNot written yetRequiresHelpful first');
      expect(screen.getByTestId('idea-counts').textContent).toBe('3 concepts · 1 not written yet');
    });

    it('shows the steps in the Order view', async () => {
      renderPage();
      await userEvent.click(screen.getByRole('button', { name: 'Order' }));
      const steps = [...screen.getByTestId('idea-order').querySelectorAll('[data-step]')]
        .map((step) => [...step.querySelectorAll('[data-idea]')].map((el) => el.getAttribute('data-idea')));
      expect(steps).toEqual([['Instrumental convergence', 'Orthogonality thesis'], ['Power-seeking'], ['Corrigibility']]);
    });

    it('lists every idea with its counts and problems in the Table view, sortable', async () => {
      renderPage('edit', '/concept-map?view=table');
      const rows = () => [...screen.getByTestId('idea-table').querySelectorAll('tbody tr')];
      expect(rows().map((row) => row.getAttribute('data-idea'))).toEqual(['Corrigibility', 'Instrumental convergence', 'Orthogonality thesis', 'Power-seeking']);
      const cells = [...rows()[1].querySelectorAll('td')].map((td) => td.textContent);
      // name, priority, step, requires, needed for, lenses, questions, problems
      expect(cells).toEqual(['Instrumental convergence', 'High', '1', '0', '1 · Power-seeking', '2', '2', 'Lens not found: Not there']);
      expect(rows()[0].querySelector('td:last-child')!.textContent).toBe('No outcomeNo questionsNo lens under Learn');
      expect(rows()[2].querySelector('td:last-child')!.textContent).toBe('Not written yet');

      await userEvent.click(screen.getByRole('button', { name: /Questions/ }));
      await userEvent.click(screen.getByRole('button', { name: /Questions/ }));
      expect(rows()[0].getAttribute('data-idea')).toBe('Instrumental convergence');
      expect(screen.getByRole('columnheader', { name: /Questions/ }).getAttribute('aria-sort')).toBe('descending');
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
      expect([...screen.getByTestId('idea-questions').querySelectorAll('li')].map((li) => li.textContent)).toEqual(['OpenWhy?', 'OpenWhy?']);
      // Learn lines as written: the alias as a link, a lens with no file marked
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
      expect(screen.getByTestId('idea-questions')).toBeTruthy();
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
        why: 'Everything else builds on it.',
        requires: ['Power-seeking'],
        helpful: ['Orthogonality thesis', 'Instrumental convergence'],
      });
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

    it('picks requirements by typing', async () => {
      renderPage();
      await userEvent.click(screen.getByRole('button', { name: 'Add concept' }));
      await userEvent.type(screen.getByLabelText('Requires'), 'corr{Enter}');
      await userEvent.type(screen.getByLabelText('Helpful first'), 'thesis');
      await userEvent.click(screen.getByRole('button', { name: /Orthogonality thesis.*Not written yet/ }));
      expect(names('requires')).toEqual(['Corrigibility']);
      expect(names('helpful')).toEqual(['Orthogonality thesis']);
      await userEvent.click(screen.getByRole('button', { name: 'Remove Corrigibility from Requires' }));
      expect(names('requires')).toEqual([]);
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
        type: 'Open', content: 'Why does power help?', assessment: 'Score out of 100.', feedback: '',
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
      });
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
});
