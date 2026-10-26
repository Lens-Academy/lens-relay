// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RunChips } from './RunChips';
import { baseFor, type RunEntry } from './runs';
import type { Run } from './types';

const run = (question: string, sample: string, pres?: string, unit = 'paragraph'): Run =>
  ({ check: { question } as Run['check'], scored: [], cached: 0, sample, pres, unit: unit as Run['unit'] });

describe('RunChips', () => {
  it('lists each run, marks runs over another sample, and shows the one clicked', () => {
    const runs: RunEntry[] = [
      { run: run('Q one', 'A', 'jev sees each paragraph alone'), draft: false },
      { run: run('Q two', 'A', 'jev sees each document, in chunks that fit, nested by paragraph; asked about each paragraph'), draft: true },
      { run: run('Q three', 'B'), draft: true },
    ];
    const onShow = vi.fn();
    const { getAllByRole } = render(<RunChips runs={runs} shown={1} onShow={onShow} />);
    const chips = getAllByRole('button');
    expect(chips.map((c) => c.textContent)).toEqual([
      '#1 live · paragraph alone · Q one',
      '#2 draft · document › paragraph · Q two',
      '#3 draft · paragraph alone · Q three · other sample',
    ]);
    fireEvent.click(chips[0]);
    expect(onShow).toHaveBeenCalledWith(0);
  });
  it('shows nothing for a single run', () => {
    const { container } = render(<RunChips runs={[{ run: run('Q', 'A'), draft: false }]} shown={0} onShow={() => {}} />);
    expect(container.textContent).toBe('');
  });
});

describe('baseFor', () => {
  it('compares with the live run, else the newest earlier run over the same sample', () => {
    const a1 = { run: run('1', 'A'), draft: true }, b = { run: run('2', 'B'), draft: true }, a2 = { run: run('3', 'A'), draft: true };
    expect(baseFor([a1, b, a2], 'A', null)?.run).toBe(a2.run);
    expect(baseFor([a1, b], 'A', null)?.run).toBe(a1.run);
    expect(baseFor([b], 'A', null)).toBeUndefined();
    const live = run('live', 'A');
    expect(baseFor([a1], 'A', live)).toEqual({ label: 'live', run: live });
  });
});
