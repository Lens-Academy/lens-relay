/**
 * Semaphore limiting concurrent Claude CLI processes across the whole editor
 * process — shared by chunked transcript formatting (within one video) and by
 * concurrent import jobs (video and article QC). Each claude process uses
 * ~300 MB RAM, so the cap protects the box.
 */

// Leaked-slot backstop: a wait longer than this means a slot never got
// released and we fail loudly rather than queue forever. It must EXCEED one
// slot-holder's max lifetime (a single Claude call runs up to the 20-min
// video TIMEOUT_MS), or legitimate contention — e.g. a long transcript split
// into more chunks than there are slots, whose later waves wait behind
// earlier ones — would spuriously fail. The real per-job deadline is enforced
// by the caller's AbortSignal (article 12 min / video 35 min), passed into
// acquire(), so this only catches genuinely stuck slots.
const POOL_ACQUIRE_TIMEOUT_MS = 30 * 60_000;
const POOL_WAIT_LOG_MS = 30_000;

export class ClaudeSessionPool {
  private maxConcurrent: number;
  private active = 0;
  private waiters: Array<{ grant: () => void; cancel: () => void }> = [];

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
  }

  get available(): number {
    return this.maxConcurrent - this.active;
  }

  /** Pool state for logs/diagnostics. */
  stats(): { active: number; waiting: number; max: number } {
    return {
      active: this.active,
      waiting: this.waiters.length,
      max: this.maxConcurrent,
    };
  }

  async acquire(
    timeoutMs: number = POOL_ACQUIRE_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (this.active < this.maxConcurrent) {
      this.active++;
      return;
    }
    const { active, waiting } = this.stats();
    console.warn(
      `[claude-pool] All ${active} slots busy — queueing (${waiting + 1} waiting)`,
    );
    return new Promise<void>((resolve, reject) => {
      const startedAt = Date.now();
      const removeWaiter = () => {
        const idx = this.waiters.indexOf(waiter);
        if (idx !== -1) this.waiters.splice(idx, 1);
      };
      const settle = (fn: () => void) => {
        clearTimeout(deadline);
        clearInterval(waitLogger);
        signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const waiter = {
        grant: () =>
          settle(() => {
            this.active++;
            resolve();
          }),
        cancel: () =>
          settle(() =>
            reject(
              new Error(
                `Timed out waiting ${Math.round(timeoutMs / 60_000)} min for a Claude session slot ` +
                  `(active=${this.active}/${this.maxConcurrent}, waiting=${this.waiters.length}) — possible leaked slot`,
              ),
            ),
          ),
      };
      // A cancelled/deadlined job must leave the queue immediately — a dead
      // waiter left in place holds its FIFO position and blocks the jobs
      // behind it until its own backstop fires.
      const onAbort = () => {
        removeWaiter();
        settle(() =>
          reject(
            signal!.reason instanceof Error
              ? signal!.reason
              : new Error(String(signal!.reason ?? "Job aborted")),
          ),
        );
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const deadline = setTimeout(() => {
        removeWaiter();
        waiter.cancel();
      }, timeoutMs);
      const waitLogger = setInterval(() => {
        console.warn(
          `[claude-pool] Still waiting for a slot after ${Math.round((Date.now() - startedAt) / 1000)}s ` +
            `(active=${this.active}/${this.maxConcurrent}, waiting=${this.waiters.length})`,
        );
      }, POOL_WAIT_LOG_MS);
      this.waiters.push(waiter);
    });
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    if (this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      next.grant();
    }
  }
}

/** Global pool: max 3 concurrent Claude CLI processes */
export const claudeSessionPool = new ClaudeSessionPool(3);
