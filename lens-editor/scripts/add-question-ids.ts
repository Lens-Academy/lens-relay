/**
 * Add `id:: <uuid>` lines to bare `#### Question` segment headers across the
 * relay folder "Lens Edu" (skipping `surveys/`).
 *
 * Dry run by default: prints per-file insert counts and a unified diff.
 *
 *   npm run add-question-ids -- [--apply] [--path <prefix>] [--limit N]
 *
 * Environment (same variables the lens-editor server uses, see
 * server/add-video/relay-docs.ts):
 *   RELAY_SERVER_TOKEN  relay server token (required, also for dry runs)
 *   RELAY_URL           relay base URL (default https://relay.lensacademy.org)
 *   RELAY_ID            relay id (default: production relay)
 *   RELAY_FOLDER_UUID   folder uuid (default: Lens Edu, src/lib/constants.ts)
 *
 * Write path: per document the script mints a doc-scoped token
 * (`POST /doc/{id}/auth`), reads the Y.Doc (`GET {baseUrl}/as-update`),
 * applies one Y.Text insert per header inside a single transaction and pushes
 * only that transaction's update to `POST {baseUrl}/update`. The relay merges
 * the update like any websocket edit, so live editors see an incremental
 * change and every other part of the document (CriticMarkup, comments,
 * provenance maps) is untouched. Because the update is a CRDT delta computed
 * against the state just read, concurrent edits by other clients merge rather
 * than being overwritten.
 */

import * as Y from "yjs";
import { randomUUID } from "node:crypto";
import { fetchBytesWithTimeout, bytesToText } from "../server/fetch-timeout";
import {
  addQuestionIds,
  insertOnlyUnifiedDiff,
  shouldProcessPath,
} from "../server/question-ids";

// Production ids (see src/lib/constants.ts: RELAY_ID, EDU_FOLDER_ID).
const DEFAULT_RELAY_ID = "cb696037-0f72-4e93-8717-4e433129d789";
const DEFAULT_FOLDER_UUID = "ea4015da-24af-4d9d-ac49-8c902cb17121";
const EXPECTED_FOLDER_NAME = "Lens Edu";
const TIMEOUT_MS = 60_000;
const CONCURRENCY = 6;

interface Args {
  apply: boolean;
  path?: string;
  limit?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--path") args.path = argv[++i];
    else if (a === "--limit") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0)
        throw new Error(`Bad --limit: ${argv[i]}`);
      args.limit = n;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: add-question-ids [--apply] [--path <prefix>] [--limit N]",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function getRelayConfig() {
  const url = (
    process.env.RELAY_URL || "https://relay.lensacademy.org"
  ).replace(/\/+$/, "");
  const token = process.env.RELAY_SERVER_TOKEN || "";
  if (!token) {
    throw new Error(
      "RELAY_SERVER_TOKEN is not set (the relay server token the lens-editor server uses).",
    );
  }
  const relayId = process.env.RELAY_ID || DEFAULT_RELAY_ID;
  const folderUuid = process.env.RELAY_FOLDER_UUID || DEFAULT_FOLDER_UUID;
  return { url, token, relayId, folderUuid };
}

interface DocAuth {
  baseUrl: string;
  token: string;
}

/** Mint a doc-scoped token with full access (same call as readRelayDocText). */
async function authDoc(docId: string): Promise<DocAuth> {
  const { url, token } = getRelayConfig();
  const resp = await fetchBytesWithTimeout(`${url}/doc/${docId}/auth`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ authorization: "full" }),
    timeoutMs: TIMEOUT_MS,
  });
  if (!resp.ok) {
    throw new Error(
      `Relay doc auth failed for ${docId}: ${resp.status} ${bytesToText(resp.bytes)}`,
    );
  }
  return JSON.parse(bytesToText(resp.bytes)) as DocAuth;
}

async function fetchDoc(auth: DocAuth): Promise<Y.Doc> {
  const resp = await fetchBytesWithTimeout(`${auth.baseUrl}/as-update`, {
    headers: { Authorization: `Bearer ${auth.token}` },
    timeoutMs: TIMEOUT_MS,
  });
  if (!resp.ok) {
    throw new Error(
      `Relay doc read failed: ${resp.status} ${bytesToText(resp.bytes)}`,
    );
  }
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(resp.bytes));
  return doc;
}

async function pushUpdate(auth: DocAuth, update: Uint8Array): Promise<void> {
  const resp = await fetchBytesWithTimeout(`${auth.baseUrl}/update`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      Authorization: `Bearer ${auth.token}`,
    },
    body: update,
    timeoutMs: TIMEOUT_MS,
  });
  if (!resp.ok) {
    throw new Error(
      `Relay doc update failed: ${resp.status} ${bytesToText(resp.bytes)}`,
    );
  }
}

async function verifyFolderName(folderUuid: string): Promise<string> {
  const { url, token } = getRelayConfig();
  const resp = await fetchBytesWithTimeout(`${url}/folder/${folderUuid}/name`, {
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: TIMEOUT_MS,
  });
  if (!resp.ok) {
    throw new Error(
      `Folder name lookup failed: ${resp.status} ${bytesToText(resp.bytes)}`,
    );
  }
  return (JSON.parse(bytesToText(resp.bytes)) as { name: string }).name;
}

interface FileMeta {
  id: string;
  type: string;
}

interface FileResult {
  path: string;
  docId: string;
  inserts: number;
  diff: string;
  error?: string;
}

async function processFile(
  path: string,
  docId: string,
  apply: boolean,
): Promise<FileResult> {
  const auth = await authDoc(docId);
  const doc = await fetchDoc(auth);
  try {
    const ytext = doc.getText("contents");
    const original = ytext.toString();
    const { inserts } = addQuestionIds(original, () =>
      randomUUID().toLowerCase(),
    );
    const diff = insertOnlyUnifiedDiff(
      path.replace(/^\/+/, ""),
      original,
      inserts,
    );
    if (inserts.length === 0 || !apply) {
      return { path, docId, inserts: inserts.length, diff };
    }

    // Capture exactly the update produced by our transaction.
    let update: Uint8Array | null = null;
    const origin = "add-question-ids";
    doc.on("update", (u: Uint8Array, o: unknown) => {
      if (o === origin) update = u;
    });
    doc.transact(() => {
      // Descending offsets keep earlier offsets valid.
      for (const ins of [...inserts].reverse()) {
        ytext.insert(ins.offset, ins.text);
      }
    }, origin);
    if (!update) throw new Error("Transaction produced no update");
    await pushUpdate(auth, update);
    return { path, docId, inserts: inserts.length, diff };
  } finally {
    doc.destroy();
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { url, relayId, folderUuid } = getRelayConfig();
  console.log(`Relay: ${url}`);
  console.log(`Folder: ${folderUuid}`);

  const folderName = await verifyFolderName(folderUuid);
  if (folderName !== EXPECTED_FOLDER_NAME) {
    throw new Error(
      `Folder ${folderUuid} is named "${folderName}", expected "${EXPECTED_FOLDER_NAME}". Aborting.`,
    );
  }
  console.log(`Folder name verified: "${folderName}"`);

  const folderDocId = `${relayId}-${folderUuid}`;
  const folderDoc = await fetchDoc(await authDoc(folderDocId));
  const filemeta = folderDoc.getMap<FileMeta>("filemeta_v0");
  const prefix = args.path ? args.path.replace(/^\/+/, "") : undefined;

  let candidates: { path: string; docId: string }[] = [];
  filemeta.forEach((meta, path) => {
    if (meta?.type !== "markdown" || !meta.id) return;
    if (!shouldProcessPath(path)) return;
    if (prefix && !path.replace(/^\/+/, "").startsWith(prefix)) return;
    candidates.push({ path, docId: `${relayId}-${meta.id}` });
  });
  folderDoc.destroy();
  candidates.sort((a, b) => a.path.localeCompare(b.path));
  if (args.limit !== undefined) candidates = candidates.slice(0, args.limit);

  console.log(
    `${args.apply ? "APPLY" : "DRY RUN"}: scanning ${candidates.length} markdown document(s)` +
      (prefix ? ` under "${prefix}"` : "") +
      "\n",
  );

  const results = await mapLimit(candidates, CONCURRENCY, async (c) => {
    try {
      return await processFile(c.path, c.docId, args.apply);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        path: c.path,
        docId: c.docId,
        inserts: 0,
        diff: "",
        error: message,
      } as FileResult;
    }
  });

  let filesWithMatches = 0;
  let totalInserts = 0;
  let errors = 0;
  const diffs: string[] = [];
  for (const r of results) {
    if (r.error) {
      errors++;
      console.log(`ERROR  ${r.path}: ${r.error}`);
      continue;
    }
    if (r.inserts === 0) continue;
    filesWithMatches++;
    totalInserts += r.inserts;
    console.log(`${String(r.inserts).padStart(4)}  ${r.path}`);
    diffs.push(r.diff);
  }

  if (diffs.length > 0) {
    console.log("\n" + diffs.join(""));
  }
  console.log(
    `\nScanned ${results.length} file(s); ${filesWithMatches} with bare Question headers missing ids; ` +
      `${totalInserts} insertion(s) ${args.apply ? "applied" : "would be applied"}; ${errors} error(s).`,
  );
  if (!args.apply && totalInserts > 0) {
    console.log("Dry run only. Re-run with --apply to write.");
  }
  if (errors > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
