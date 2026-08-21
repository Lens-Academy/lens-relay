import { describe, it, expect } from "vitest";
import { ClaudeSessionPool } from "./claude-pool";

describe("ClaudeSessionPool abort handling", () => {
  it("grants up to maxConcurrent without waiting", async () => {
    const pool = new ClaudeSessionPool(2);
    await pool.acquire();
    await pool.acquire();
    expect(pool.available).toBe(0);
  });

  it("rejects a queued waiter immediately when its signal aborts", async () => {
    const pool = new ClaudeSessionPool(1);
    await pool.acquire(); // fills the only slot

    const ctrl = new AbortController();
    const waiting = pool.acquire(60_000, ctrl.signal);
    // The waiter is queued (slot busy); aborting must reject it now, not at
    // the 60s backstop, and must not leave a dead waiter in the queue.
    ctrl.abort(new Error("Cancelled by user"));
    await expect(waiting).rejects.toThrow("Cancelled by user");

    // The freed-up nature is observable: releasing the held slot and acquiring
    // again succeeds without hanging on the removed waiter.
    pool.release();
    await expect(pool.acquire()).resolves.toBeUndefined();
  });

  it("throws synchronously if the signal is already aborted", async () => {
    const pool = new ClaudeSessionPool(1);
    const ctrl = new AbortController();
    ctrl.abort(new Error("already gone"));
    await expect(pool.acquire(60_000, ctrl.signal)).rejects.toThrow(
      "already gone",
    );
    // No slot should have been consumed.
    expect(pool.available).toBe(1);
  });

  it("hands a freed slot to the next FIFO waiter", async () => {
    const pool = new ClaudeSessionPool(1);
    await pool.acquire();
    const order: number[] = [];
    const w1 = pool.acquire().then(() => order.push(1));
    const w2 = pool.acquire().then(() => order.push(2));
    pool.release(); // grants w1
    await w1;
    pool.release(); // grants w2
    await w2;
    expect(order).toEqual([1, 2]);
  });
});
