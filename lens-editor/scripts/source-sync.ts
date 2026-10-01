/**
 * Preview the source sync by hand: fetch and convert every binding, and
 * print each file (or write it under --out) instead of writing to the relay.
 *
 *   SOURCE_SYNC_BINDINGS='[…]' GOOGLE_SERVICE_ACCOUNT_JSON='…' \
 *     npx tsx scripts/source-sync.ts [--out <dir>]
 *
 * It never writes to a relay: synced files are written only by the
 * production server, so a machine with production credentials cannot
 * overwrite them from a terminal. Images are named by hash, not hosted.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseBindings } from "../server/source-sync/bindings";
import { sourceAdapters } from "../server/source-sync/index";
import { logOutcome, syncBinding } from "../server/source-sync/runner";
import type { SyncFiles } from "../server/source-sync/types";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outDir = outIdx >= 0 ? args[outIdx + 1] : null;

const previewFiles: SyncFiles = {
  read: async () => null,
  write: async (path, content) => {
    if (!outDir) {
      process.stdout.write(`\n===== ${path} =====\n${content}`);
      return;
    }
    const file = join(outDir, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, content);
    console.log(`[source-sync] wrote ${file}`);
  },
  hostImage: async (_target, bytes) => `preview-image-${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}`,
};

let parsed: ReturnType<typeof parseBindings>;
try {
  parsed = parseBindings();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
for (const problem of parsed.problems) console.error(`[source-sync] ${problem}`);
if (!parsed.bindings.length) {
  console.error("No valid bindings in SOURCE_SYNC_BINDINGS; nothing to preview.");
  process.exit(1);
}

let failed = parsed.problems.length > 0;
for (const binding of parsed.bindings) {
  const outcome = await syncBinding(binding, { adapters: sourceAdapters(), files: previewFiles });
  logOutcome(outcome, console);
  failed ||= outcome.status === "failed";
}
process.exit(failed ? 1 : 0);
