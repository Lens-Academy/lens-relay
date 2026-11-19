import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { buildIdeaGraph, type IdeaGraph } from '../../lib/idea-map';
import { IdeaWalkView } from './IdeaWalkView';
import { ORDER_STORE, SEEN_STORE } from './useWalkStore';
import type { PickKeys, PickMarks } from './ideaLook';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const idea = (name: string, n: number, topic: string, requires: string[] = [], helpful: string[] = []) => ({
  name,
  docId: name,
  text: `---\nid: ${uuid(n)}\npriority: medium\n${topic ? `topic: ${topic}\n` : ''}---\nWhat ${name} is.\n`
    + (requires.length ? `\n## Requires\n${requires.map((other) => `- [[${other}]]`).join('\n')}\n` : '')
    + (helpful.length ? `\n## Helpful first\n${helpful.map((other) => `- [[${other}]]`).join('\n')}\n` : '')
    + (name === 'Atoms' ? '\n## Why it matters\nEverything is made of them.\n' : ''),
});

// Two topics. "Chemistry" (Basics) needs "Cells" of the later topic; "Ghost" has no file: seven concepts.
const graph = buildIdeaGraph([
  idea('Atoms', 1, 'Basics'),
  idea('Molecules', 2, 'Basics', ['Atoms']),
  idea('Chemistry', 3, 'Basics', ['Cells']),
  idea('Cells', 4, 'Life', ['Molecules'], ['Atoms']),
  idea('Organs', 5, 'Life', ['Cells']),
  idea('Minds', 6, 'Life', ['Organs', 'Ghost']),
]);

const onPick = vi.fn<(key: string, keys: PickKeys) => void>();

function show(props: { graph?: IdeaGraph; selected?: string | null; marks?: PickMarks | null; seenSet?: string } = {}) {
  return render(
    <IdeaWalkView
      graph={props.graph ?? graph}
      selected={props.selected ?? null}
      chosen={new Set()}
      marks={props.marks ?? null}
      matches={null}
      onPick={onPick}
      seenSet={props.seenSet ?? 'folder:test'}
    />,
  );
}

const topics = () => [...screen.getByTestId('walk-overview').querySelectorAll<HTMLElement>('[data-topic]')];
const topic = (label: string) => topics().find((el) => el.dataset.topic === label)!;
const current = () => screen.getByTestId('walk-step').querySelector<HTMLElement>('[data-walk-card]')!.dataset.idea;
const where = () => screen.getByTestId('walk-where').textContent;
const side = (which: 'before' | 'after') => [...screen.getByTestId('walk-step').querySelectorAll<HTMLElement>(`[data-walk-side="${which}"] [data-idea]`)];
const neighbour = (name: string) => screen.getByTestId('walk-step').querySelector<HTMLElement>(`[data-walk-side] [data-idea="${name}"]`)!;
const seenText = () => screen.getByTestId('walk-seen').textContent;
const stored = (set = 'folder:test') => JSON.parse(localStorage.getItem(`${SEEN_STORE}:${set}`) ?? '[]') as string[];
const start = () => userEvent.click(screen.getByTestId('walk-start'));
const order = (value: string) => userEvent.selectOptions(screen.getByTestId('walk-order'), value);

beforeEach(() => {
  localStorage.clear();
  onPick.mockReset();
});

describe('IdeaWalkView', () => {
  describe('the overview', () => {
    it('shows the topics in reading order, each with its concepts, what was seen and what it builds on', () => {
      show();
      expect(topics().map((el) => `${el.querySelector('[data-topic-number]')!.textContent} ${el.dataset.topic}`)).toEqual(['1 No topic', '2 Basics', '3 Life']);
      const life = topic('Life');
      expect(life.textContent).toContain('3 concepts');
      expect(life.querySelector('[data-topic-seen]')!.textContent).toBe('seen 0 of 3');
      // The concepts of the topic most others require
      expect(life.querySelector('[data-topic-teaser]')!.textContent).toBe('Cells · Organs · Minds');
      // Life builds on Basics (2 links) and on the concept with no topic (1 link): the strongest is named
      expect(life.querySelector('[data-topic-needs]')!.getAttribute('data-topic-needs')).toBe('2');
      expect(life.querySelector('[data-topic-needs]')!.getAttribute('title')).toBe('Builds on Basics (2 links), No topic (1 link)');
      expect(topic('No topic').textContent).toContain('Builds on no other topic');
      expect(seenText()).toBe('0 of 7 seen');
      expect(screen.getByTestId('walk-start').textContent).toBe('Start from the foundations');
    });

    it('says how the other topics are linked to the one that has the focus', async () => {
      show();
      act(() => topic('Basics').focus());
      expect(topic('Life').querySelector('[data-topic-linked]')!.textContent).toBe('builds on it: 2 links · it builds on this: 1 link');
      expect(topic('No topic').querySelector('[data-topic-linked]')).toBeNull();
      expect([...screen.getByTestId('walk-overview').querySelectorAll('[data-topic-link]')].map((line) => line.getAttribute('data-topic-link')))
        .toEqual(['topic:basics > topic:life']);
      await userEvent.tab();
      expect(document.activeElement).toBe(topic('Life'));
    });

    it('falls back to groups found from the links when no concept has a topic, and says so', () => {
      const plain = buildIdeaGraph([idea('A', 1, ''), idea('B', 2, '', ['A']), idea('C', 3, '', ['B']), idea('D', 4, '', ['C'])]);
      show({ graph: plain });
      expect(screen.getByTestId('walk-note').textContent).toContain('No concept has a topic yet');
      expect(topics().length).toBeGreaterThan(0);
      expect(topics().reduce((sum, el) => sum + Number(/(\d+) concept/.exec(el.textContent ?? '')![1]), 0)).toBe(4);
    });

    it('remembers the order chosen', async () => {
      const first = show();
      await order('curiosity');
      expect(localStorage.getItem(ORDER_STORE)).toBe('curiosity');
      first.unmount();
      show();
      expect((screen.getByTestId('walk-order') as HTMLSelectElement).value).toBe('curiosity');
    });
  });

  describe('foundations first', () => {
    it('walks every concept with Next and Back, and says where the walk is', async () => {
      show();
      await start();
      expect(current()).toBe('Ghost');
      expect(where()).toBe('Step 1 of 7 · Topic: No topic (1 of 1)');
      expect(screen.getByRole('button', { name: '← Back' })).toHaveProperty('disabled', true);
      await userEvent.click(screen.getByTestId('walk-next'));
      expect(current()).toBe('Atoms');
      expect(where()).toBe('Step 2 of 7 · Topic: Basics (1 of 3)');
      expect(screen.getByTestId('walk-step').textContent).toContain('Everything is made of them.');
      await userEvent.click(screen.getByTestId('walk-next'));
      expect(current()).toBe('Molecules');
      await userEvent.click(screen.getByRole('button', { name: '← Back' }));
      expect(current()).toBe('Atoms');
      expect(seenText()).toBe('3 of 7 seen');
    });

    it('shows what a concept builds on and what it leads to, seen or new, with a line each', async () => {
      show();
      await start();
      for (let i = 0; i < 3; i++) await userEvent.click(screen.getByTestId('walk-next'));
      expect(current()).toBe('Cells');
      // Pulled in from the later topic, for the concept that needs it
      expect(screen.getByTestId('walk-pulled').textContent).toBe('A step ahead, from the later topic "Life": "Chemistry" needs it first.');
      expect(side('before').map((el) => `${el.dataset.idea}:${el.dataset.seen}`)).toEqual(['Molecules:true', 'Atoms:true']);
      expect(side('after').map((el) => `${el.dataset.idea}:${el.dataset.seen}`)).toEqual(['Chemistry:false', 'Organs:false']);
      // A neighbour of another topic says which
      expect(neighbour('Molecules').querySelector('[data-other-topic]')!.textContent).toBe('Basics');
      expect(neighbour('Organs').querySelector('[data-other-topic]')).toBeNull();
      const step = screen.getByTestId('walk-step');
      expect([...step.querySelectorAll('[data-line]')].map((line) => `${line.getAttribute('data-line')} ${line.getAttribute('data-edge')}`)).toEqual([
        'requires:molecules requires', 'helpful:atoms helpful', 'neededFor:chemistry requires', 'neededFor:organs requires',
      ]);
    });

    it('says so when a concept builds on nothing, or nothing builds on it', async () => {
      show();
      await start();
      await userEvent.click(screen.getByTestId('walk-next'));
      expect(current()).toBe('Atoms');
      expect(screen.getByTestId('walk-step').querySelector('[data-walk-none="before"]')!.textContent).toBe('Requires nothing first: a place to start.');
      for (let i = 0; i < 5; i++) await userEvent.click(screen.getByTestId('walk-next'));
      expect(current()).toBe('Minds');
      expect(screen.getByTestId('walk-step').querySelector('[data-walk-none="after"]')).toBeTruthy();
      // After the last one: the end, and the way back
      await userEvent.click(screen.getByTestId('walk-next'));
      expect(within(screen.getByTestId('walk-done')).getByRole('heading').textContent).toBe('That was the last concept');
      expect(screen.getByTestId('walk-next')).toHaveProperty('disabled', true);
      await userEvent.click(screen.getByRole('button', { name: 'Back to the topics' }));
      expect(topic('Life').querySelector('[data-topic-seen]')!.textContent).toBe('all seen');
    });

    it('makes a click on a neighbour a detour, with the way back to the walk and a trail', async () => {
      show();
      await start();
      await userEvent.click(screen.getByTestId('walk-next'));
      await userEvent.click(screen.getByTestId('walk-next'));
      expect(current()).toBe('Molecules');
      // Cells is the next step of the walk: that click is Next. Organs is not: a detour
      await userEvent.click(neighbour('Cells'));
      await userEvent.click(neighbour('Organs'));
      expect(current()).toBe('Organs');
      expect(where()).toBe('A detour · Topic: Life · the walk waits at step 4 of 7');
      expect(screen.getByTestId('walk-next').textContent).toBe('Back to the walk →');
      const trail = () => within(screen.getByTestId('walk-trail')).getAllByRole('button').map((el) => el.textContent);
      expect(trail()).toEqual(['Ghost', 'Atoms', 'Molecules', 'Cells']);
      // Further off, then Back: the way that led here
      await userEvent.click(neighbour('Minds'));
      expect(trail()).toEqual(['Ghost', 'Atoms', 'Molecules', 'Cells', 'Organs']);
      await userEvent.click(screen.getByRole('button', { name: '← Back' }));
      expect(current()).toBe('Organs');
      expect(trail()).toEqual(['Ghost', 'Atoms', 'Molecules', 'Cells']);
      await userEvent.click(screen.getByTestId('walk-next'));
      expect(current()).toBe('Cells');
      expect(where()).toBe('Step 4 of 7 · Topic: Life (1 of 3)');
      expect(screen.getByTestId('walk-next').textContent).toBe('Next →');
      // A click on the trail goes back to that step
      await userEvent.click(within(screen.getByTestId('walk-trail')).getByRole('button', { name: 'Atoms' }));
      expect(current()).toBe('Atoms');
      expect(trail()).toEqual(['Ghost']);
      expect(where()).toBe('A detour · Topic: Basics · the walk waits at step 4 of 7');
    });

    it('takes a click on the next step of the walk as Next', async () => {
      show();
      await start();
      await userEvent.click(screen.getByTestId('walk-next'));
      expect(current()).toBe('Atoms');
      await userEvent.click(neighbour('Molecules'));
      expect(where()).toBe('Step 3 of 7 · Topic: Basics (2 of 3)');
    });
  });

  describe('seen', () => {
    it('remembers what was shown by the id of its file, per set of concepts, and goes on from there', async () => {
      const first = show();
      await start();
      await userEvent.click(screen.getByTestId('walk-next'));
      // Ghost has no file: its key
      expect(stored()).toEqual(['ghost', uuid(1)]);
      first.unmount();

      const second = show();
      expect(seenText()).toBe('2 of 7 seen');
      expect(topic('Basics').querySelector('[data-topic-seen]')!.textContent).toBe('seen 1 of 3');
      expect(screen.getByTestId('walk-start').textContent).toBe('Continue from the foundations (step 3 of 7)');
      await start();
      expect(current()).toBe('Molecules');
      second.unmount();

      // Another set of concepts has its own
      show({ seenSet: 'profile:Other' });
      expect(seenText()).toBe('0 of 7 seen');
      expect(stored('profile:Other')).toEqual([]);
    });

    it('starts over once that is confirmed', async () => {
      localStorage.setItem(`${SEEN_STORE}:folder:test`, JSON.stringify([uuid(1), uuid(2)]));
      show();
      expect(seenText()).toBe('2 of 7 seen');
      await userEvent.click(screen.getByRole('button', { name: 'Start over' }));
      await userEvent.click(within(screen.getByTestId('idea-confirm')).getByRole('button', { name: 'Cancel' }));
      expect(seenText()).toBe('2 of 7 seen');
      await userEvent.click(screen.getByRole('button', { name: 'Start over' }));
      // The focus is on the button that does it: Enter confirms
      await userEvent.keyboard('{Enter}');
      expect(screen.queryByTestId('idea-confirm')).toBeNull();
      expect(seenText()).toBe('0 of 7 seen');
      expect(localStorage.getItem(`${SEEN_STORE}:folder:test`)).toBeNull();
      expect(screen.getByRole('button', { name: 'Start over' })).toHaveProperty('disabled', true);
    });
  });

  describe('topic by topic', () => {
    it('walks one topic, then suggests the next one that is not finished', async () => {
      show();
      await order('topics');
      expect(screen.getByTestId('walk-start').textContent).toBe('Start with "No topic"');
      await userEvent.click(topic('Basics'));
      expect(current()).toBe('Atoms');
      expect(where()).toBe('Step 1 of 3 · Topic: Basics');
      await userEvent.click(screen.getByTestId('walk-next'));
      await userEvent.click(screen.getByTestId('walk-next'));
      // Cells, of another topic, is a neighbour and not a step
      expect(current()).toBe('Chemistry');
      expect(side('before').map((el) => el.dataset.idea)).toEqual(['Cells']);
      await userEvent.click(screen.getByTestId('walk-next'));
      const done = screen.getByTestId('walk-done');
      expect(within(done).getByRole('heading').textContent).toBe('Topic done');
      expect(done.textContent).toContain('You walked through "Basics": its 3 concepts.');
      expect(screen.getByTestId('walk-next-topic').textContent).toBe('Life →');
      await userEvent.click(screen.getByTestId('walk-next-topic'));
      expect(where()).toBe('Step 1 of 3 · Topic: Life');
      await userEvent.click(screen.getByRole('button', { name: '← Topics' }));
      expect(topic('Basics').querySelector('[data-topic-seen]')!.textContent).toBe('all seen');
      expect(screen.getByTestId('walk-start').textContent).toBe('Go on with "No topic"');
    });
  });

  describe('backwards from a goal', () => {
    it('walks from the goal picked to what it requires, and shows the way from the goal', async () => {
      show();
      await order('goal');
      expect(screen.getByTestId('walk-start')).toHaveProperty('disabled', true);
      await userEvent.type(screen.getByLabelText('Goal concept'), 'org');
      expect(within(screen.getByTestId('walk-goal-rows')).getAllByRole('option').map((row) => row.textContent)).toEqual(['Organs']);
      await userEvent.keyboard('{Enter}');
      expect((screen.getByLabelText('Goal concept') as HTMLInputElement).value).toBe('Organs');
      expect(screen.getByTestId('walk-start').textContent).toBe('Walk back from "Organs"');
      await start();
      expect(current()).toBe('Organs');
      expect(where()).toBe('Step 1 of 4 · To understand "Organs"');
      await userEvent.click(screen.getByTestId('walk-next'));
      await userEvent.click(screen.getByTestId('walk-next'));
      expect(current()).toBe('Molecules');
      expect(screen.getByTestId('walk-needed').textContent).toBe('To understand "Cells" you need this.');
      expect(screen.getByTestId('walk-path').textContent).toBe('Organs←Cells←Molecules');
      await userEvent.click(within(screen.getByTestId('walk-path')).getByRole('button', { name: 'Cells' }));
      expect(where()).toBe('Step 2 of 4 · To understand "Organs"');
    });

    it('takes the selected concept as the goal', async () => {
      show({ selected: 'minds' });
      await order('goal');
      await userEvent.click(screen.getByRole('button', { name: 'Use the selected concept ("Minds")' }));
      await start();
      expect(current()).toBe('Minds');
      expect(where()).toBe('Step 1 of 6 · To understand "Minds"');
    });
  });

  describe('follow my curiosity', () => {
    it('has no order: Next proposes a concept not seen yet and says why', async () => {
      show();
      await order('curiosity');
      expect(screen.getByTestId('walk-start').textContent).toBe('Start at "Atoms"');
      await start();
      expect(where()).toBe('Following your curiosity · Topic: Basics');
      expect(screen.getByTestId('walk-proposal').textContent).toBe('Next: Molecules (Not seen yet · builds on "Atoms" (all it requires is seen) · needed for 1 other)');
      await userEvent.click(screen.getByTestId('walk-next'));
      expect(current()).toBe('Molecules');
      await userEvent.click(neighbour('Cells'));
      expect(current()).toBe('Cells');
      await userEvent.click(screen.getByRole('button', { name: '← Back' }));
      expect(current()).toBe('Molecules');
    });
  });

  describe('with the rest of the page', () => {
    it('opens the concept in the side panel with "Open", and lets an open panel follow the walk', async () => {
      const first = show();
      await start();
      await userEvent.click(screen.getByRole('button', { name: 'Open' }));
      expect(onPick).toHaveBeenLastCalledWith('ghost', expect.objectContaining({ toggle: false }));
      await userEvent.click(screen.getByTestId('walk-next'));
      expect(onPick).toHaveBeenCalledTimes(1);
      first.unmount();

      onPick.mockReset();
      show({ selected: 'molecules' });
      await start();
      expect(current()).toBe('Molecules');
      expect(onPick).not.toHaveBeenCalled();
      await userEvent.click(screen.getByTestId('walk-next'));
      expect(onPick).toHaveBeenLastCalledWith('cells', { shift: false, toggle: false, byKey: false });
    });

    it('picks a neighbour instead of going there while a form is open', async () => {
      show({ marks: { requires: new Set(['atoms']), helpful: new Set(), self: null } });
      await start();
      await userEvent.click(screen.getByTestId('walk-next'));
      await userEvent.click(screen.getByTestId('walk-next'));
      expect(current()).toBe('Molecules');
      expect(neighbour('Atoms').textContent).toContain('Requires');
      await userEvent.click(neighbour('Cells'));
      expect(current()).toBe('Molecules');
      expect(onPick).toHaveBeenLastCalledWith('cells', expect.objectContaining({ shift: false }));
    });

    it('joins many neighbours to the concept with one line', async () => {
      const hub = buildIdeaGraph([idea('Hub', 1, 'T'), ...Array.from({ length: 9 }, (_, i) => idea(`Leaf ${i + 1}`, i + 2, 'T', ['Hub']))]);
      show({ graph: hub });
      await start();
      expect(current()).toBe('Hub');
      expect(side('after')).toHaveLength(9);
      const step = screen.getByTestId('walk-step');
      expect([...step.querySelectorAll('[data-line]')].map((line) => line.getAttribute('data-line'))).toEqual(['neededFor']);
      expect(step.querySelectorAll('[data-bracket]')).toHaveLength(1);
    });
  });

  describe('by keyboard', () => {
    it('walks with the arrow keys right and left, and puts the focus on the concept', async () => {
      show();
      topic('Basics').focus();
      await userEvent.keyboard('{Enter}');
      expect(current()).toBe('Atoms');
      const card = () => screen.getByTestId('walk-step').querySelector('[data-walk-card]');
      expect(document.activeElement).toBe(card());
      await userEvent.keyboard('{ArrowRight}');
      expect(current()).toBe('Molecules');
      await userEvent.keyboard('{ArrowLeft}');
      expect(current()).toBe('Atoms');
      // A neighbour by Tab and Enter; the focus goes on to the concept it shows
      neighbour('Molecules').focus();
      await userEvent.keyboard('{Enter}');
      expect(current()).toBe('Molecules');
      expect(document.activeElement).toBe(card());
    });

    it('leaves the arrow keys alone in a field and outside the view', async () => {
      render(<input aria-label="Elsewhere" />);
      show();
      await start();
      expect(current()).toBe('Ghost');
      screen.getByLabelText('Elsewhere').focus();
      await userEvent.keyboard('{ArrowRight}');
      expect(current()).toBe('Ghost');
    });

    it('moves between the topics with the arrow keys', async () => {
      // (jsdom lays nothing out: every box is at 0,0, so no box lies in any direction; the keys must not throw)
      show();
      topic('Basics').focus();
      await userEvent.keyboard('{ArrowRight}{ArrowDown}');
      expect(document.activeElement).toBe(topic('Basics'));
    });
  });
});
