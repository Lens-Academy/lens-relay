/**
 * Run `fn` over `items` with at most `limit` in flight at once.
 * Bulk suggestion actions open one websocket per document; unbounded
 * parallelism would hammer the relay with hundreds of simultaneous
 * doc connections (the failure mode behind the 2026-07-02 hang).
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await fn(item);
    }
  });
  await Promise.all(workers);
}
