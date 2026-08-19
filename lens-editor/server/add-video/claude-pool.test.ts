import { describe, expect, it } from "vitest";
import { ClaudeSessionPool } from "./claude-pool";

describe("ClaudeSessionPool cancellation", () => {
  it("removes an aborted waiter from a full three-slot pool", async () => {
    const pool = new ClaudeSessionPool(3);
    await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]);
    const controller = new AbortController();
    const waiting = pool.acquire(10_000, controller.signal);
    expect(pool.stats()).toEqual({ active: 3, waiting: 1, max: 3 });
    controller.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");
    expect(pool.stats()).toEqual({ active: 3, waiting: 0, max: 3 });
    pool.release();
    pool.release();
    pool.release();
    expect(pool.stats().active).toBe(0);
  });

  it("rejects cancellation before acquiring without consuming a slot", async () => {
    const pool = new ClaudeSessionPool(1);
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    await expect(pool.acquire(10_000, controller.signal)).rejects.toThrow("already cancelled");
    expect(pool.stats()).toEqual({ active: 0, waiting: 0, max: 1 });
  });

  it("times out a waiter and grants exactly one later waiter on release", async () => {
    const pool = new ClaudeSessionPool(1);
    await pool.acquire();
    await expect(pool.acquire(5)).rejects.toThrow("Timed out waiting");
    expect(pool.stats()).toEqual({ active: 1, waiting: 0, max: 1 });
    const next = pool.acquire(1_000);
    pool.release();
    await next;
    expect(pool.stats()).toEqual({ active: 1, waiting: 0, max: 1 });
    pool.release();
  });
});
