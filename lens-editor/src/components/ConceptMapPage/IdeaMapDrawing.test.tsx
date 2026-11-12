import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { buildIdeaGraph } from '../../lib/idea-map';
import { GrowingTextarea } from './GrowingTextarea';
import { IdeaMapDrawing } from './IdeaMapDrawing';
import { IdeaOrderView } from './IdeaOrderView';

const LONG = 'Building ASI without extreme caution will wipe out humanity';
const PATH = 'We are on the path to building ASI';

const graph = buildIdeaGraph([
  { name: LONG, docId: 'a', text: 'Explain it.\n' },
  { name: PATH, docId: 'b', text: 'Explain it.\n' },
  { name: 'Short', docId: 'c', text: 'Explain it.\n' },
  { name: 'After', docId: 'd', text: `Explain it.\n\n## Requires\n- [[${LONG}]]\n` },
]);

const views = { graph, selected: null, chosen: new Set<string>(), marks: null, matches: null, onPick: () => {} };
const box = (name: string) => document.querySelector<HTMLElement>(`[data-idea="${name}"]`)!;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('IdeaMapDrawing with long names', () => {
  it('shows a name whole: it wraps inside its box and is never cut', () => {
    render(<IdeaMapDrawing {...views} />);
    const long = box(LONG);
    expect(long.textContent).toBe(LONG);
    // No fixed height, no line clamp, no ellipsis anywhere in the box
    expect(long.style.height).toBe('');
    expect(long.style.minHeight).toBe('36px');
    expect(long.outerHTML).not.toMatch(/line-clamp|truncate/);
    expect(long.querySelector('span')!.className).toContain('break-words');
  });

  it('gives a box the room its name is guessed to need until it is measured', () => {
    render(<IdeaMapDrawing {...views} />);
    // The ideas without a link stand in a row below the linked ones, 40 under the tallest of them
    const top = (name: string) => parseFloat(box(name).style.top);
    // 3 lines of 14 + 10
    expect(top(PATH)).toBe(top(LONG) + 52 + 40);
    expect(top('Short')).toBe(top(PATH));
    expect(box('After').style.left).not.toBe(box(LONG).style.left);
  });

  it('lays the map out with the heights the boxes really have', () => {
    const heights: Record<string, number> = { [LONG]: 80, [PATH]: 50, Short: 36, After: 36 };
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return heights[this.dataset.idea ?? ''] ?? 0;
    });
    // What the browser calls once the boxes are laid out
    const observers: Array<() => void> = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { observers.push(callback); }
      observe() {}
      disconnect() {}
    });
    render(<IdeaMapDrawing {...views} />);
    act(() => observers.forEach((seen) => seen()));
    // The row below starts under the tall box as it really is
    expect(parseFloat(box(PATH).style.top)).toBe(parseFloat(box(LONG).style.top) + heights[LONG] + 40);
    // The arrow leaves the tall box at half its real height
    const start = /^M[\d.]+,([\d.]+)/.exec(document.querySelector('path[data-edge="requires"]')!.getAttribute('d')!)![1];
    expect(Number(start)).toBe(parseFloat(box(LONG).style.top) + 40);
  });
});

describe('IdeaOrderView with long names', () => {
  it('wraps a long name instead of cutting it', () => {
    render(<IdeaOrderView {...views} />);
    expect(box(LONG).textContent).toBe(LONG);
    expect(box(LONG).outerHTML).not.toMatch(/line-clamp|truncate/);
  });
});

describe('GrowingTextarea', () => {
  it('is as tall as its text: when it opens with text, and while typing', () => {
    let tall = 90;
    vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(() => tall);
    vi.spyOn(HTMLTextAreaElement.prototype, 'offsetHeight', 'get').mockImplementation(() => 42);
    vi.spyOn(HTMLTextAreaElement.prototype, 'clientHeight', 'get').mockImplementation(() => 40);
    vi.stubGlobal('innerHeight', 1000);
    const Field = ({ value }: { value: string }) => <GrowingTextarea aria-label="Outcome" rows={3} value={value} onChange={() => {}} />;
    const { rerender } = render(<Field value="Three lines of text" />);
    const field = screen.getByLabelText('Outcome') as HTMLTextAreaElement;
    // The text and the border around it
    expect(field.style.height).toBe('92px');
    expect(field.style.overflowY).toBe('hidden');
    expect(field.getAttribute('rows')).toBe('3');

    tall = 300;
    rerender(<Field value="Much more text" />);
    expect(field.style.height).toBe('302px');

    // From 60% of the window on it scrolls inside
    tall = 900;
    rerender(<Field value="A very long text" />);
    expect(field.style.height).toBe('600px');
    expect(field.style.overflowY).toBe('auto');
    fireEvent.change(field, { target: { value: 'x' } });
  });

  it('leaves the height to `rows` where nothing can be measured', () => {
    render(<GrowingTextarea aria-label="Why" rows={2} value="text" onChange={() => {}} />);
    expect((screen.getByLabelText('Why') as HTMLTextAreaElement).style.height).toBe('auto');
  });
});
