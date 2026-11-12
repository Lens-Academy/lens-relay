import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { buildIdeaGraph, ideaKey } from '../../lib/idea-map';
import { IdeaMapDrawing } from './IdeaMapDrawing';
import { LAYOUT_STORE } from './useMapLayoutChoice';

const requires = (...names: string[]) => `Explain it.\n\n## Requires\n${names.map((name) => `- [[${name}]]`).join('\n')}\n`;
// Two sets of three with one link between them, and a concept with no link
const graph = buildIdeaGraph([
  { name: 'A1', docId: 'a1', text: 'Explain it.\n' },
  { name: 'A2', docId: 'a2', text: requires('A1') },
  { name: 'A3', docId: 'a3', text: requires('A1', 'A2') },
  { name: 'B1', docId: 'b1', text: requires('A3') },
  { name: 'B2', docId: 'b2', text: requires('B1') },
  { name: 'B3', docId: 'b3', text: requires('B1', 'B2') },
  { name: 'Alone', docId: 'c', text: 'Explain it.\n' },
]);
const views = { graph, selected: null, chosen: new Set<string>(), marks: null, matches: null, onPick: () => {} };
const box = (name: string) => document.querySelector<HTMLElement>(`[data-idea="${name}"]`)!;
const frames = () => [...document.querySelectorAll<HTMLElement>('[data-frame]')].map((frame) => frame.dataset.frame);
const lines = () => [...document.querySelectorAll('path[data-edge]')];
const choose = (label: string, option: string) => fireEvent.change(screen.getByLabelText(label), { target: { value: option } });

beforeEach(() => localStorage.clear());

describe('the layout switch of the drawn map', () => {
  it('starts left to right, with no frames and no "Group by"', () => {
    render(<IdeaMapDrawing {...views} />);
    expect(screen.getByLabelText<HTMLSelectElement>('Layout').value).toBe('columns');
    expect([...screen.getByLabelText<HTMLSelectElement>('Layout').options].map((option) => option.text)).toEqual(['Left to right', 'Top to bottom', 'Groups', 'Around one concept']);
    expect(screen.queryByLabelText('Group by')).toBeNull();
    expect(frames()).toEqual([]);
    expect(parseFloat(box('A2').style.left)).toBeGreaterThan(parseFloat(box('A1').style.left));
    expect(lines()).toHaveLength(7);
  });

  it('top to bottom: what comes first is above', () => {
    render(<IdeaMapDrawing {...views} />);
    choose('Layout', 'rows');
    expect(parseFloat(box('A2').style.top)).toBeGreaterThan(parseFloat(box('A1').style.top));
    expect(lines()).toHaveLength(7);
  });

  it('groups: a frame for each group, and a choice of what makes a group', () => {
    render(<IdeaMapDrawing {...views} />);
    choose('Layout', 'groups');
    expect(frames()).toEqual(['A1', 'B1', 'Not linked']);
    expect(document.querySelector('[data-frame="B1"]')!.textContent).toContain('Builds on: A1');
    expect(screen.getByLabelText<HTMLSelectElement>('Group by').value).toBe('cluster');
    choose('Group by', 'state');
    expect(frames()).toEqual(['Written']);
    choose('Group by', 'priority');
    expect(frames()).toEqual(['Medium priority']);
  });

  it('groups: the link from one group to another is drawn only while one of its ends is pointed at or selected', () => {
    const { rerender } = render(<IdeaMapDrawing {...views} />);
    choose('Layout', 'groups');
    expect(lines()).toHaveLength(6);
    fireEvent.pointerEnter(box('B1'));
    expect(lines()).toHaveLength(7);
    fireEvent.pointerLeave(box('B1'));
    expect(lines()).toHaveLength(6);
    rerender(<IdeaMapDrawing {...views} selected={ideaKey('A3')} />);
    expect(lines()).toHaveLength(7);
  });

  it('around one concept: the selected one, and it stays the one when the selection is cleared', () => {
    const { rerender } = render(<IdeaMapDrawing {...views} selected={ideaKey('A2')} />);
    choose('Layout', 'focus');
    // A2 builds on A1, and A3 and all of B build on A2; Alone is set aside
    expect(frames()).toEqual(['Not on the way to or from “A2”']);
    rerender(<IdeaMapDrawing {...views} selected={null} />);
    expect(frames()).toEqual(['Not on the way to or from “A2”']);
    rerender(<IdeaMapDrawing {...views} selected={ideaKey('B3')} />);
    expect(frames()).toEqual(['Not on the way to or from “B3”']);
  });

  it('remembers the choice in this browser', () => {
    const first = render(<IdeaMapDrawing {...views} />);
    choose('Layout', 'groups');
    choose('Group by', 'component');
    expect(JSON.parse(localStorage.getItem(LAYOUT_STORE)!)).toEqual({ layout: 'groups', groupBy: 'component' });
    first.unmount();
    render(<IdeaMapDrawing {...views} />);
    expect(screen.getByLabelText<HTMLSelectElement>('Layout').value).toBe('groups');
    expect(screen.getByLabelText<HTMLSelectElement>('Group by').value).toBe('component');
    expect(frames()).toEqual(['A1', 'Not linked']);
  });

  it('starts left to right when what is stored makes no sense', () => {
    localStorage.setItem(LAYOUT_STORE, '{"layout":"spiral"');
    render(<IdeaMapDrawing {...views} />);
    expect(screen.getByLabelText<HTMLSelectElement>('Layout').value).toBe('columns');
  });

  it('in every layout a click picks the concept, and the selected one and those being picked look it', () => {
    const onPick = vi.fn();
    render(<IdeaMapDrawing {...views} selected={ideaKey('A2')} chosen={new Set([ideaKey('B2')])} onPick={onPick} />);
    for (const layout of ['columns', 'rows', 'groups', 'focus']) {
      choose('Layout', layout);
      expect(document.querySelectorAll('[data-idea]')).toHaveLength(7);
      fireEvent.click(box('B1'));
      expect(onPick).toHaveBeenLastCalledWith(ideaKey('B1'), expect.anything());
      expect(box('A2').className).toContain('ring-blue-600');
      expect(box('A2').getAttribute('aria-pressed')).toBe('true');
      expect(box('B2').dataset.chosen).toBe('true');
      // Not next to the selected one: dimmed, except where the map is drawn around the selected one
      expect(box('Alone').className.includes('opacity-30')).toBe(layout !== 'focus');
    }
    expect(onPick).toHaveBeenCalledTimes(4);
  });

  it('shows the whole map again after the layout changed', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
    render(<IdeaMapDrawing {...views} />);
    const layer = box('A1').parentElement!;
    const zoom = () => Number(/scale\(([\d.]+)\)/.exec(layer.style.transform)![1]);
    const fits = () => Math.min(400 / parseFloat(layer.style.width), 300 / parseFloat(layer.style.height), 1);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    choose('Layout', 'rows');
    expect(zoom()).toBeCloseTo(fits(), 5);
    choose('Layout', 'groups');
    expect(zoom()).toBeCloseTo(fits(), 5);
    vi.restoreAllMocks();
  });
});
