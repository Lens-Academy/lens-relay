/**
 * Entry point for the servers: start syncing the bindings in
 * SOURCE_SYNC_BINDINGS, or do nothing when it is unset. A bad configuration
 * is logged and leaves the sync off; it never stops the server starting.
 */

import { intervalMs, parseBindings } from "./bindings";
import { googleDocAdapter } from "./google-docs/adapter";
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
