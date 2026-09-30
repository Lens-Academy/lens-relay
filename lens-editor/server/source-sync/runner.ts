import { composeArticle, publishedOf } from "./article";
import type { SourceAdapter, SyncBinding, SyncFiles } from "./types";

export interface SyncOutcome {
  target: string;
  status: "written" | "unchanged" | "failed";
  warnings: string[];
  error?: string;
}

export interface SyncDeps {
  adapters: SourceAdapter[];
  files: SyncFiles;
  /** Today's date as YYYY-MM-DD (injectable for tests). */
  today?: () => string;
}

/**
 * Bring one target up to date with its source. The whole file is compared
 * and replaced, so edits made to the Relay copy are overwritten -- the
 * editor warns about this on every synced file.
 */
export async function syncBinding(binding: SyncBinding, deps: SyncDeps): Promise<SyncOutcome> {
  const adapter = deps.adapters.find((a) => a.matches(binding.source));
  if (!adapter) {
    return { target: binding.target, status: "failed", warnings: [], error: `no adapter reads ${binding.source}` };
  }
  try {
    const content = await adapter.pull(binding, (bytes) => deps.files.hostImage(binding.target, bytes));
    const { warnings } = content;
    const current = await deps.files.read(binding.target);
    const today = deps.today?.() ?? new Date().toISOString().slice(0, 10);
    const markdown = composeArticle(adapter.kind, content, binding, binding.published ?? publishedOf(current) ?? today);
    if (markdown === current) return { target: binding.target, status: "unchanged", warnings };

    await deps.files.write(binding.target, markdown);
    return { target: binding.target, status: "written", warnings };
  } catch (err) {
    return { target: binding.target, status: "failed", warnings: [], error: (err as Error).message };
  }
}

export interface SyncLog {
  log(message: string): void;
  error(message: string): void;
}

export function logOutcome(outcome: SyncOutcome, log: SyncLog): void {
  const head = `[source-sync] ${outcome.target}: ${outcome.status}`;
  if (outcome.status === "failed") log.error(`${head} -- ${outcome.error}`);
  else log.log(`${head}${outcome.warnings.length ? ` (${outcome.warnings.length} warning(s))` : ""}`);
  for (const warning of outcome.warnings) log.log(`[source-sync]   ${warning}`);
}

/**
 * Sync every binding now, then again every `intervalMs`. Runs never overlap:
 * the next one is scheduled when the last finishes. `problems` (bindings that
 * failed validation) are reported on every run, so they are not missed.
 * Returns a stop function.
 */
export function startSourceSync(
  bindings: SyncBinding[],
  intervalMs: number,
  deps: SyncDeps,
  log: SyncLog = console,
  problems: string[] = [],
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const run = async () => {
    for (const problem of problems) log.error(`[source-sync] ${problem}`);
    for (const binding of bindings) {
      if (stopped) return;
      logOutcome(await syncBinding(binding, deps), log);
    }
    if (!stopped) {
      timer = setTimeout(run, intervalMs);
      timer.unref?.();
    }
  };

  log.log(`[source-sync] ${bindings.length} binding(s), every ${Math.round(intervalMs / 60_000)} min${problems.length ? `, ${problems.length} ignored` : ""}`);
  void run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
