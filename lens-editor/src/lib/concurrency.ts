/**
 * Run `fn` over `items` with at most `limit` in flight at once.
 * Bounds in-flight async work; callers pick a limit suited to the backend
 * (see BULK_FILE_CONCURRENCY in ReviewPage for the bulk-apply rationale).
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
