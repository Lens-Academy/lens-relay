// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RunChips, type RunEntry } from './RunChips';
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
