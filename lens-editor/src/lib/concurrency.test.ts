import { describe, it, expect } from 'vitest';
import { runWithConcurrency } from './concurrency';

describe('runWithConcurrency', () => {
  it('never exceeds the concurrency limit', async () => {
    // Prevents: bulk accept opening one websocket per file all at once and
    // hammering the relay (the load class behind the 2026-07-02 prod hang)
    let inFlight = 0;
    let peak = 0;
    await runWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight -= 1;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('processes every item exactly once', async () => {
    // Prevents: worker loop dropping or double-processing queue items
    const seen: number[] = [];
    await runWithConcurrency([1, 2, 3, 4, 5], 2, async n => {
      seen.push(n);
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('handles an empty list and a limit larger than the list', async () => {
    // Prevents: worker-count clamp spawning workers for nonexistent items
    await runWithConcurrency([], 3, async () => { throw new Error('should not run'); });
    const seen: number[] = [];
    await runWithConcurrency([1], 5, async n => { seen.push(n); });
    expect(seen).toEqual([1]);
  });
});
