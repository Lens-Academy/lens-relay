// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Summary } from './Results';
import { Spread } from './ParaText';
import type { Run, Scored } from './types';

const check = { id: 'T1', fail_at: 0.8, pass_below: 0.5 } as Run['check'];
const unit = (p: number, samples?: number[]): Scored => ({ id: String(p), path: 'Lens Edu/a.md', line: 1, kind: 'p', title: null, courses: [], text: 't', p, samples });

describe('a run asked several times', () => {
  it('says how often each unit was asked and how many answers fall in different bands', () => {
    const run: Run = { check, cached: 0, samples: 3, scored: [unit(0.8, [0.75, 0.8, 0.85]), unit(0.9, [0.85, 0.9, 0.95]), unit(0.1, [0.1, 0.1, 0.1])] };
    const { container } = render(<Summary run={run} band={null} onBand={() => {}} />);
    expect(container.textContent).toContain('each asked 3 times (scores are the mean); 1 with answers in different bands');
  });
  it('shows the lowest and highest answer, amber when they straddle a threshold', () => {
    const { container, rerender } = render(<Spread samples={[0.75, 0.85, 0.8]} wobbly />);
    expect(container.textContent).toBe('0.75–0.85');
    expect(container.firstElementChild!.className).toContain('amber');
    rerender(<Spread samples={[0.3]} wobbly={false} />);
    expect(container.textContent).toBe('');
  });
});
