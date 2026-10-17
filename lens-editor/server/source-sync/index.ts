/**
 * Entry point for the servers: start syncing the bindings in
 * SOURCE_SYNC_BINDINGS, or do nothing when it is unset. A bad configuration
 * is logged and leaves the sync off; it never stops the server starting.
 */

import { intervalMs, parseBindings } from "./bindings";
import { googleDocAdapter } from "./google-docs/adapter";
import { APPROVE_RETIREMENT_ENV } from "./iliad/course-files";
import { layoutFor } from "./iliad/layout";
import { relayCourseFiles } from "./iliad/relay-course-files";
import { askClaude } from "./iliad/summaries";
import { startCourseSync } from "./iliad/sync";
import { relayFiles } from "./relay-files";
import { startSourceSync, type SyncLog } from "./runner";
import type { SourceAdapter } from "./types";

/** Every source kind the sync can read. */
export function sourceAdapters(): SourceAdapter[] {
  return [googleDocAdapter()];
}

/** A relay on this machine: the only kind a development server may sync into. */
export function isLocalRelay(url: string | undefined): boolean {
  try {
    const host = new URL(url ?? "").hostname;
    return ["localhost", "127.0.0.1", "[::1]"].includes(host) || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

/**
 * `localRelayOnly` is for development servers: synced files are written by
 * the production server alone, so a developer's machine that has production
 * credentials in its environment still cannot sync into production.
 */
export function startSourceSyncFromEnv(
  { localRelayOnly = false }: { localRelayOnly?: boolean } = {},
  log: SyncLog = console,
): (() => void) | null {
  try {
    const { bindings, problems } = parseBindings();
    if (!bindings.length && !problems.length) return null;
    if (localRelayOnly && !isLocalRelay(process.env.RELAY_URL)) {
      log.error(`[source-sync] not started: in development it only syncs into a local relay, and RELAY_URL is ${process.env.RELAY_URL}`);
      return null;
    }
    return startSourceSync(bindings, intervalMs(), { adapters: sourceAdapters(), files: relayFiles() }, log, problems);
  } catch (err) {
    log.error(`[source-sync] not started: ${(err as Error).message}`);
    return null;
  }
}

export const ILIAD_COURSE_ENV = "ILIAD_SYNC_COURSE";
export const ILIAD_SUMMARIES_ENV = "ILIAD_SYNC_SUMMARIES";

/**
 * Start the Iliad course sync (iliad/sync.ts) when ILIAD_SYNC_COURSE names
 * the course file, e.g. "Lens Edu/courses/in-development/iliad-intensive-demo.md";
 * do nothing when it is unset. It runs at the article sync's interval.
 * ILIAD_SYNC_SUMMARIES=1 lets a model write `tldr` and `summary_for_tutor`
 * for new and changed lenses; without it they keep what they have.
 * ILIAD_SYNC_APPROVE_RETIREMENT=<commit> lets the run for that source commit
 * retire more lenses than a run otherwise may.
 */
export function startIliadSyncFromEnv(log: SyncLog = console): (() => void) | null {
  const course = process.env[ILIAD_COURSE_ENV]?.trim();
  if (!course) return null;
  try {
    if (!course.includes("/") || !course.endsWith(".md")) throw new Error(`${ILIAD_COURSE_ENV} must be "<Folder>/courses/.../<file>.md"`);
    return startCourseSync(
      {
        files: relayCourseFiles({ folder: course.slice(0, course.indexOf("/")) }),
        layout: layoutFor(course),
        ask: process.env[ILIAD_SUMMARIES_ENV] === "1" ? askClaude : undefined,
        approvedRetirement: process.env[APPROVE_RETIREMENT_ENV]?.trim() || undefined,
      },
      intervalMs(),
      log,
    );
  } catch (err) {
    log.error(`[iliad-sync] not started: ${(err as Error).message}`);
    return null;
  }
}
