/**
 * Content migration: "Domains and Topics/<N> <Domain>/<Topic>.md + placeholder
 * learning outcomes + topic: on learning outcomes" -> one flat concept graph in
 * "Concepts/" (see docs/concept-relationships.md and the concept graph spec).
 *
 *   phase 1  domain by domain: Domains and Topics/<N> <Domain>/_domain_metadata.md ->
 *            Concepts/<Domain>.md (+ skill-tree: domain, order: <N>; domain-number:
 *            dropped), then that domain's Domains and Topics/<N> <Domain>/<Topic>.md ->
 *   phase 2  Concepts/<Topic>.md (+ skill-tree: topic, parent-concepts: [[<Domain>]])
 *   phase 3  Learning Outcomes/<X>.md tagged skill-tree-placeholder, with no test and
 *            no lenses -> Concepts/<X>.md (topic: -> parent-concepts:, learning-outcome:/stage:
 *            and the tag dropped)
 *   phase 4  every other learning outcome: topic: -> concept: (topic: none -> removed)
 *   phase 5  the authoring template AI Guide/Writing (Learning) Outcomes 2.md
 *
 * In phases 1-3 each file is moved with the relay's move endpoint (POST /doc/move)
 * and has its frontmatter rewritten (order: see Resuming below); the move rewrites every
 * wikilink to it (and its own outgoing relative links) through the link indexer.
 * Frontmatter edits are direct Y.Text edits over the y-sweet websocket (server
 * token -> per-doc client token -> YSweetProvider), one per changed hunk, applied
 * back to front in one transaction, because the MCP edit tool turns replacements
 * of human-written text into CriticMarkup suggestions, which break YAML.
 *
 * Resuming: each file is re-read right before it is changed. Domains and topics
 * are edited first and moved second (their order and domain name exist only in
 * the old folder name), and are written to a journal (--journal) before their
 * first change and marked done after their last; a re-run finishes what the
 * journal says was started. Placeholders are moved first and edited second, so
 * one caught in between is in Concepts/ and still tagged, which the plan
 * recognises without the journal. An apply that stopped half way can simply be
 * run again (with the same --journal; --apply refuses when the journal is
 * missing but Concepts/ shows an earlier apply).
 *
 * Usage (from lens-editor/):
 *   # plan from a directory (a git mirror of the folder); never connects anywhere
 *   npx tsx scripts/migrate-topics-to-concepts.ts --from-dir ../../lens-edu-staging-readonly
 *
 *   # plan / apply against a relay
 *   RELAY_SERVER_TOKEN=... npx tsx scripts/migrate-topics-to-concepts.ts \
 *     --relay-url https://relay.lensacademy.org [--dry-run|--apply] [--only <path>]
 *
 *   # afterwards, as a separate explicit step: trash the empty Domains and Topics/ folder
 *   ... --remove-empty-folders [--apply]
 *
 * Flags:
 *   --from-dir <path>      plan from files on disk instead of a relay (dry run only)
 *   --relay-url <url>      relay base URL (default http://localhost:8090)
 *   --relay-id <uuid>      relay id prefix of compound doc ids (default: production;
 *                          a local dev relay uses a0000000-0000-4000-8000-000000000000)
 *   --folder-id <uuid>     Lens Edu folder doc uuid (default ea4015da-…, same locally)
 *   --folder-name <name>   folder display name, for trash paths (default "Lens Edu")
 *   --dry-run              (default) print the summary, move list and diffs; change nothing
 *   --apply                perform the migration (refused while the plan has problems)
 *   --only <path>          restrict changes to this file or folder (e.g.
 *                          "Domains and Topics/7 AI Control"); the plan and its checks
 *                          still cover everything
 *   --drop-redundant-placeholders
 *                          resolve a name collision between a placeholder and its own
 *                          same-named parent topic/domain by trashing the placeholder
 *                          (only when that is its sole parent and it has no body; the
 *                          relay refuses the trash while anything links to it)
 *   --merge-into-existing-concepts
 *                          resolve a name collision between a placeholder and a file
 *                          already in Concepts/ by merging: the concept gets the
 *                          placeholder's id (if it has none) and its parents as
 *                          parent-concepts:, then the placeholder is trashed (only when the
 *                          placeholder has no body and the concept has no other parent-concepts:)
 *   --remove-empty-folders trash Domains and Topics/ (refused unless it holds no files)
 *   --references           also list non-wikilink mentions of the old layout in other
 *                          files (needs every file's text: --from-dir only)
 *   --concurrency <n>      parallel doc connections for reads and phase-4 edits (default 4)
 *   --journal <path>       apply journal (default ./migrate-topics-to-concepts.journal.json);
 *                          keep it until the migration is complete
 *   --no-journal-check     apply even though the journal is missing while Concepts/ already
 *                          holds migrated domains/topics or tagged placeholders
 *   --report <path>        also write everything printed to this file (keep the full
 *                          live dry run: it is the record of the data the migration drops)
 *   --simulate-failure <in-folder path>
 *                          testing only: stop half way through that file (domain/topic:
 *                          after its edit, before its move; placeholder: after its move,
 *                          before its edit; merge: after the trash, before the edit)
 *
 * RELAY_SERVER_TOKEN is read from the environment (required for a non-local relay;
 * a local dev relay without auth works without it). It is never printed. Exit code
 * is non-zero when the plan has problems or anything failed.
 */

import fs from 'fs';
import path from 'path';
import * as Y from 'yjs';
import { YSweetProvider } from '@y-sweet/client';
import {
  CONCEPTS_DIR, DOMAINS_DIR, TEMPLATE_PATH, TransformError, findTextReferences, hunkEdits, lineDiff, needsContent,
  applyEdits, hasLenses, hasTest, incomingLinks, isPlaceholderTagged, parseYamlFrontmatter, partialMigrationEvidence,
  planMigration, resumeItems, transformFor, transformPlaceholder, transformTemplate, verifyMigrated,
  type Item, type Journal, type JournalEntry, type Plan, type Snapshot, type VaultEntry,
} from './lib/topics-to-concepts';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  fromDir: string | null;
  relayUrl: string;
  relayId: string;
  folderId: string;
  folderName: string;
  apply: boolean;
  only: string | null;
  dropRedundant: boolean;
  mergeExisting: boolean;
  removeEmptyFolders: boolean;
  references: boolean;
  concurrency: number;
  journal: string;
  report: string | null;
  simulateFailure: string | null;
  noJournalCheck: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    fromDir: null,
    relayUrl: 'http://localhost:8090',
    relayId: 'cb696037-0f72-4e93-8717-4e433129d789',
    folderId: 'ea4015da-24af-4d9d-ac49-8c902cb17121',
    folderName: 'Lens Edu',
    apply: false,
    only: null,
    dropRedundant: false,
    mergeExisting: false,
    removeEmptyFolders: false,
    references: false,
    concurrency: 4,
    journal: 'migrate-topics-to-concepts.journal.json',
    report: null,
    simulateFailure: null,
    noJournalCheck: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      return v;
    };
    switch (a) {
      case '--from-dir': args.fromDir = next(); break;
      case '--relay-url': args.relayUrl = next().replace(/\/+$/, ''); break;
      case '--relay-id': args.relayId = next(); break;
      case '--folder-id': args.folderId = next(); break;
      case '--folder-name': args.folderName = next(); break;
      case '--dry-run': args.apply = false; break;
      case '--apply': args.apply = true; break;
      case '--only': args.only = normalizeOnly(next()); break;
      case '--drop-redundant-placeholders': args.dropRedundant = true; break;
      case '--merge-into-existing-concepts': args.mergeExisting = true; break;
      case '--remove-empty-folders': args.removeEmptyFolders = true; break;
      case '--references': args.references = true; break;
      case '--concurrency': args.concurrency = Math.max(1, Number(next())); break;
      case '--journal': args.journal = next(); break;
      case '--no-journal-check': args.noJournalCheck = true; break;
      case '--report': args.report = next(); break;
      case '--simulate-failure': args.simulateFailure = normalizeOnly(next()) + (/\.md$/i.test(argv[i]) ? '' : '.md'); break;
      case '--help': case '-h':
        console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('*/')[0]);
        process.exit(0);
      default: throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (args.fromDir && args.apply) throw new Error('--from-dir plans only; it cannot be combined with --apply');
  if (args.references && !args.fromDir) throw new Error('--references needs --from-dir');
  return args;
}

/** "Lens Edu/Domains and Topics/7 AI Control/" -> "/Domains and Topics/7 AI Control" */
function normalizeOnly(p: string): string {
  let s = p.trim().replace(/\/+$/, '');
  s = s.replace(/^\/?Lens Edu\//, '/');
  return s.startsWith('/') ? s : `/${s}`;
}

function planOptions(args: Args) {
  return { dropRedundantPlaceholders: args.dropRedundant, mergeIntoExistingConcepts: args.mergeExisting };
}

function matchesOnly(args: Args, itemPath: string): boolean {
  if (!args.only) return true;
  return itemPath === args.only || itemPath.startsWith(`${args.only}/`);
}

// ---------------------------------------------------------------------------
// Snapshot from a directory
// ---------------------------------------------------------------------------

function snapshotFromDir(root: string, withAllContents: boolean): { snap: Snapshot; all: Map<string, string> } {
  const entries: VaultEntry[] = [];
  const contents = new Map<string, string>();
  const all = new Map<string, string>();
  const walk = (dir: string, rel: string) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.name === '.git' || d.name === '.github') continue;
      const abs = path.join(dir, d.name);
      const p = `${rel}/${d.name}`;
      if (d.isDirectory()) {
        entries.push({ path: p, id: `dir:${p}`, type: 'folder' });
        walk(abs, p);
      } else if (d.isFile()) {
        const isMd = /\.md$/i.test(d.name);
        entries.push({ path: p, id: `file:${p}`, type: isMd ? 'markdown' : 'file' });
        if (isMd && (needsContent(p) || withAllContents)) {
          const text = fs.readFileSync(abs, 'utf8');
          if (needsContent(p)) contents.set(p, text);
          if (withAllContents) all.set(p, text);
        }
      }
    }
  };
  walk(root, '');
  return { snap: { entries, contents }, all };
}

// ---------------------------------------------------------------------------
// Relay access
// ---------------------------------------------------------------------------

const SERVER_TOKEN = process.env.RELAY_SERVER_TOKEN;

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (SERVER_TOKEN) headers.Authorization = `Bearer ${SERVER_TOKEN}`;
  return headers;
}

async function getClientToken(relayUrl: string, docId: string): Promise<any> {
  const res = await fetch(`${relayUrl}/doc/${docId}/auth`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ authorization: 'full' }),
  });
  if (!res.ok) throw new Error(`auth for ${docId} failed: ${res.status} ${res.statusText}`);
  return res.json();
}

async function postJson(relayUrl: string, route: string, body: unknown): Promise<any> {
  const res = await fetch(`${relayUrl}${route}`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${route} failed: ${res.status} ${res.statusText} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

/**
 * Open a doc, wait for it to be fully synced, run `fn`, and (if `fn` made local
 * changes) wait until the relay has acknowledged every local update before
 * tearing the connection down.
 */
async function withDoc<T>(relayUrl: string, docId: string, fn: (doc: Y.Doc) => Promise<T> | T): Promise<T> {
  const doc = new Y.Doc();
  const provider = new YSweetProvider(() => getClientToken(relayUrl, docId), docId, doc, {
    connect: true,
    showDebuggerLink: false,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`sync timeout for ${docId}`)), 45_000);
      provider.on('synced', () => { clearTimeout(timeout); resolve(); });
      provider.on('connection-error', (err: unknown) => { clearTimeout(timeout); reject(err); });
    });
    const result = await fn(doc);
    if (provider.hasLocalChanges) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`flush timeout for ${docId}`)), 30_000);
        const check = () => { if (!provider.hasLocalChanges) { clearTimeout(timeout); resolve(); } };
        provider.on('local-changes', check);
        check();
      });
      await new Promise((r) => setTimeout(r, 200));
    }
    return result;
  } finally {
    // The provider's close handler schedules a reconnect, which would keep the
    // process alive; detach it before tearing down.
    const ws = (provider as any).websocket as WebSocket | null | undefined;
    if (ws) { ws.onclose = null; ws.onerror = null; }
    provider.disconnect();
    provider.destroy();
    doc.destroy();
  }
}

async function readFolderEntries(args: Args): Promise<VaultEntry[]> {
  return (await readFolder(args)).entries;
}

async function readFolder(args: Args): Promise<{ entries: VaultEntry[]; backlinks: Map<string, string[]> }> {
  return withDoc(args.relayUrl, `${args.relayId}-${args.folderId}`, (doc) => {
    const filemeta = doc.getMap('filemeta_v0');
    const entries: VaultEntry[] = [];
    for (const [p, raw] of filemeta.entries()) {
      const v: any = raw instanceof Y.Map ? raw.toJSON() : raw;
      if (!v || typeof v !== 'object') continue;
      if (p.startsWith('/_trash/')) continue;
      entries.push({ path: p, id: String(v.id ?? ''), type: String(v.type ?? '') });
    }
    const backlinks = new Map<string, string[]>();
    for (const [target, raw] of doc.getMap('backlinks_v0').entries()) {
      const v: any = raw instanceof Y.Array ? raw.toArray() : raw;
      if (Array.isArray(v)) backlinks.set(target, v.map(String));
    }
    return { entries, backlinks };
  });
}

async function snapshotFromRelay(args: Args): Promise<Snapshot> {
  const { entries, backlinks } = await readFolder(args);
  const wanted = entries.filter((e) => e.type === 'markdown' && needsContent(e.path));
  const contents = new Map<string, string>();
  const failures: string[] = [];
  await runPool(wanted, args.concurrency, async (e) => {
    try {
      const text = await withDoc(args.relayUrl, `${args.relayId}-${e.id}`, (doc) => doc.getText('contents').toString());
      contents.set(e.path, text);
    } catch (err) {
      failures.push(`${e.path}: ${(err as Error).message}`);
    }
  });
  if (failures.length) throw new Error(`could not read ${failures.length} docs:\n  ${failures.join('\n  ')}`);
  return { entries, contents, backlinks };
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  });
  await Promise.all(runners);
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Rewrite one doc's text in place: one Y.Text edit per changed hunk (each trimmed
 * to what actually differs), applied back to front in one transaction, so lines
 * that do not change keep their authorship and concurrent edits elsewhere in the
 * doc are left alone. Returns whether it changed anything.
 */
async function editDoc(args: Args, item: Item): Promise<boolean> {
  const docUuid = item.kind === 'merge-placeholder' ? item.merge!.conceptId : item.id;
  return withDoc(args.relayUrl, `${args.relayId}-${docUuid}`, (doc) => {
    const ytext = doc.getText('contents');
    const before = ytext.toString();
    const after = transformFor(item, before);
    parseYamlFrontmatter(after);
    const edits = hunkEdits(before, after);
    if (!edits.length) return false;
    // Check everything before anything is sent: the edits produce exactly the
    // planned text, and the planned text is already migrated.
    if (applyEdits(before, edits) !== after) throw new Error('planned edits do not reproduce the planned text; nothing sent');
    if (transformFor(item, after) !== after) throw new Error('transform is not idempotent on the planned text; nothing sent');
    doc.transact(() => {
      for (const e of edits) {
        if (e.deleteCount) ytext.delete(e.index, e.deleteCount);
        if (e.insert) ytext.insert(e.index, e.insert);
      }
    }, 'migrate-topics-to-concepts');
    if (ytext.toString() !== after) throw new Error('text after the edit differs from the planned text');
    return true;
  });
}

/** A file that no longer matches what the plan expected: skipped, reported as a problem. */
class SkipError extends Error {}

function bodyText(text: string): string {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/);
  return m ? text.slice(m[0].length) : text;
}

async function readText(args: Args, uuid: string): Promise<string> {
  return withDoc(args.relayUrl, `${args.relayId}-${uuid}`, (doc) => doc.getText('contents').toString());
}

/**
 * Right before a placeholder is moved or trashed: it must still be tagged and
 * still have no test and no lenses (someone may have started writing it up
 * since the plan was made). A trashed one must also still have no body.
 */
async function recheckPlaceholder(args: Args, it: Item) {
  const text = await readText(args, it.id);
  if (hasTest(text) || hasLenses(text)) throw new SkipError('now has a test or lenses: it is a real learning outcome; skipped');
  const trashing = it.kind === 'drop-placeholder' || it.kind === 'merge-placeholder';
  if (!isPlaceholderTagged(text)) {
    // A placeholder rewritten by an earlier version of this script (edit before move) is untagged but done.
    if (trashing || transformPlaceholder(text).content !== text) throw new SkipError('no longer tagged skill-tree-placeholder; skipped');
  }
  // Its topic links may have been rewritten by the topic moves since planning; what
  // matters is that it still holds nothing but frontmatter.
  if (trashing && bodyText(text).trim() !== '') throw new SkipError('has a body now; skipped (re-run to re-plan it)');
}

// --- Journal ---------------------------------------------------------------

function loadJournal(args: Args): Journal | null {
  if (!fs.existsSync(args.journal)) return null;
  const j = JSON.parse(fs.readFileSync(args.journal, 'utf8')) as Journal;
  if (j.relayUrl !== args.relayUrl || j.folderId !== args.folderId) {
    throw new Error(`journal ${args.journal} belongs to ${j.relayUrl} folder ${j.folderId}; pass --journal <another path>`);
  }
  return j;
}

function saveJournal(args: Args, j: Journal) {
  const tmp = `${args.journal}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2));
  fs.renameSync(tmp, args.journal);
}

function journalMark(args: Args, j: Journal, it: Item, state: JournalEntry['state']) {
  j.entries[it.id] = {
    kind: it.kind, uuid: it.id, source: j.entries[it.id]?.source ?? it.path, target: it.target,
    params: it.params, merge: it.merge, state, at: new Date().toISOString(),
  };
  saveJournal(args, j);
}

/** Testing hook (--simulate-failure <path>): stop half way through that item, as a crash would. */
function maybeFail(args: Args, it: Item) {
  if (args.simulateFailure && it.path === args.simulateFailure) {
    throw new Error(`simulated failure half way through ${it.path} (--simulate-failure)`);
  }
}

interface ApplyReport {
  edited: number; moved: number; trashed: number; linksRewritten: number;
  errors: { path: string; reason: string }[];
  skipped: { path: string; reason: string }[];
}

async function applyPlan(args: Args, items: Item[], journal: Journal): Promise<ApplyReport> {
  const report: ApplyReport = { edited: 0, moved: 0, trashed: 0, linksRewritten: 0, errors: [], skipped: [] };
  const sequential = items.filter((it) => it.kind !== 'lo' && it.kind !== 'template');
  const editsOnly = items.filter((it) => it.kind === 'lo' || it.kind === 'template');

  // Domains (each followed by its topics), then placeholders, strictly in order.
  // Each file is journalled before its first change and marked done after its last.
  let done = 0;
  for (const it of sequential) {
    try {
      if (it.kind === 'placeholder' || it.kind === 'drop-placeholder' || (it.kind === 'merge-placeholder' && !it.alreadyTrashed)) {
        await recheckPlaceholder(args, it);
      }
      journalMark(args, journal, it, 'started');
      if (it.kind === 'merge-placeholder') {
        // Trash first: the relay refuses while anything links to the placeholder,
        // and then the concept file is left untouched.
        if (!it.alreadyTrashed) {
          await postJson(args.relayUrl, '/doc/trash', { path: `${args.folderName}${it.path}`, force: false });
          report.trashed++;
        }
        maybeFail(args, it);
        if (await editDoc(args, it)) report.edited++;
        console.log(`  merged ${it.path} into ${it.merge!.conceptPath}${it.alreadyTrashed ? '' : ' and trashed it'}`);
      } else if (it.kind === 'drop-placeholder') {
        await postJson(args.relayUrl, '/doc/trash', { path: `${args.folderName}${it.path}`, force: false });
        report.trashed++;
        console.log(`  trashed ${it.path}`);
      } else {
        const move = async () => {
          if (!it.target || it.target === it.path) return;
          const res = await postJson(args.relayUrl, '/doc/move', { uuid: it.id, new_path: it.target });
          report.moved++;
          report.linksRewritten += Number(res.links_rewritten ?? 0);
          console.log(`  moved ${it.path} -> ${it.target} (${res.links_rewritten ?? 0} links rewritten)`);
        };
        if (it.kind === 'placeholder') {
          // Move first, then edit: a placeholder caught in between is in Concepts/
          // and still tagged, which the plan recognises without the journal.
          await move();
          maybeFail(args, it);
          if (await editDoc(args, it)) report.edited++;
        } else {
          // Domains and topics: edit first (the order and domain name live only in
          // the old folder name), then move; the journal covers the gap.
          if (await editDoc(args, it)) report.edited++;
          maybeFail(args, it);
          await move();
        }
      }
      journalMark(args, journal, it, 'done');
    } catch (err) {
      if (err instanceof SkipError) {
        report.skipped.push({ path: it.path, reason: err.message });
        console.log(`  SKIPPED ${it.path}: ${err.message}`);
        continue;
      }
      report.errors.push({ path: it.path, reason: String((err as Error)?.message ?? err) });
      // Later items depend on earlier moves: stop at the first failure. The journal
      // keeps this item as started, so the next run finishes it first.
      console.log(`  FAILED ${it.path}: ${(err as Error).message}`);
      return report;
    }
    done++;
    if (done % 25 === 0) process.stderr.write(`  ... ${done}/${sequential.length}\n`);
  }

  // Learning outcomes and the template: key renames, independent of each other.
  await runPool(editsOnly, args.concurrency, async (it) => {
    try {
      if (await editDoc(args, it)) report.edited++;
    } catch (err) {
      report.errors.push({ path: it.path, reason: String((err as Error)?.message ?? err) });
    }
  });
  return report;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<Item['kind'], string> = {
  domain: 'domain', topic: 'topic', placeholder: 'placeholder LO', 'drop-placeholder': 'placeholder LO (trash)',
  'merge-placeholder': 'placeholder LO (merge)',
  lo: 'learning outcome', template: 'template',
};

function printPlan(args: Args, plan: Plan, source: string, resumed: Item[] = [], snap?: Snapshot) {
  const items = [...resumed, ...plan.items.filter((it) => matchesOnly(args, it.path))];
  const c = plan.counts;
  const line = (label: string, n: number | string) => console.log(`  ${label.padEnd(58)} ${n}`);
  console.log('='.repeat(78));
  console.log(`Mode: ${args.apply ? 'APPLY' : 'DRY RUN'}   source: ${source}${args.only ? `   only: ${args.only}` : ''}`);
  console.log('Summary (whole plan):');
  line('domains -> Concepts/ (phase 1)', c.domains);
  line('topics -> Concepts/ (phase 2)', c.topics);
  line('placeholder LOs -> Concepts/ (phase 3)', c.placeholders);
  line('  ...with several parents', c.multiParentPlaceholders);
  line('  ...with topic: none (no parent)', c.noParentPlaceholders);
  line('  ...whose learning-outcome: sentence is dropped', c.droppedLoText);
  line('placeholder LOs trashed (redundant with same-named parent)', c.dropPlaceholders);
  line('placeholder LOs merged into an existing Concepts/ file', c.mergePlaceholders);
  line('learning outcomes topic: -> concept: (phase 4)', c.los - c.losNone);
  line('  ...with several links', c.losMulti);
  line('learning outcomes topic: none -> field removed', c.losNone);
  line('template rewritten (phase 5)', c.template);
  line('learning outcomes without topic: (untouched)', c.loNoTopic);
  line('learning outcomes already on concept: (untouched)', c.loAlreadyConcept);
  line('tagged placeholder but with test/lenses (treated as real)', c.taggedButReal);
  line('placeholder LOs whose stage: value is dropped', c.droppedStage);
  line('resumed from the journal (half done by an earlier run)', resumed.length);
  line('pending changes in this run', items.length);
  line('problems', plan.problems.length);
  for (const p of plan.problems) console.log(`      PROBLEM ${p.path}: ${p.reason}`);
  if (plan.warnings.length) {
    line('warnings', plan.warnings.length);
    for (const w of plan.warnings) console.log(`      warning ${w.path}: ${w.reason}`);
  }

  const trashed = items.filter((it) => it.kind === 'drop-placeholder' || it.kind === 'merge-placeholder');
  if (trashed.length) {
    console.log('\nPlaceholder files trashed (the record of what they held):');
    for (const it of trashed) {
      const id = (it.kind === 'merge-placeholder' ? it.merge!.id : idOf(it.placeholderText ?? '')) ?? '(no id)';
      console.log(`  ${it.path.slice(1)}  id: ${id}${it.kind === 'merge-placeholder' ? `  (merged: id and parents kept on ${it.merge!.conceptPath.slice(1)})` : ''}`);
      for (const l of (it.placeholderText ?? '').split('\n')) console.log(`      | ${l.replace(/\r$/, '')}`);
    }
  }

  if (snap?.backlinks) {
    const inc = incomingLinks({ ...plan, items }, snap);
    console.log(`\nIncoming links to moved/trashed files, beyond the topic: links (from backlinks_v0; the moves rewrite them, a trash is refused while any remain): ${inc.length ? '' : '(none)'}`);
    for (const x of inc) {
      console.log(`  ${x.path.slice(1)} ${x.trashed ? '(trashed)' : `-> ${x.target!.slice(1)}`}`);
      for (const f of x.from) console.log(`      <- ${f.replace(/^\//, '')}`);
    }
  } else {
    console.log('\n(Incoming links are listed only in relay mode, from the backlink index.)');
  }

  console.log('\nMoves (in order):');
  for (const it of items) {
    if (it.kind === 'drop-placeholder') console.log(`  [${KIND_LABEL[it.kind]}] ${it.path.slice(1)}  -> _trash/`);
    else if (it.kind === 'merge-placeholder') console.log(`  [${KIND_LABEL[it.kind]}] ${it.path.slice(1)}  -> merged into ${it.merge!.conceptPath.slice(1)}, then _trash/   parents: ${it.merge!.parentNames.join(' | ')}`);
    else if (it.target) {
      const parents = it.parents?.length ? `   parents: ${it.parents.map((p) => p.slice(CONCEPTS_DIR.length).replace(/\.md$/, '')).join(' | ')}` : '';
      console.log(`  [${KIND_LABEL[it.kind]}] ${it.path.slice(1)}  ->  ${it.target.slice(1)}${parents}`);
    }
  }
  console.log('\nFrontmatter diffs (links shown as they are now; the moves rewrite them):');
  for (const it of items) {
    if (it.before === it.after) continue;
    const label = it.merge ? `${it.merge.conceptPath.slice(1)} (absorbs ${it.path.slice(1)})`
      : it.target ? `${it.path.slice(1)} -> ${it.target.slice(1)}` : it.path.slice(1);
    console.log(lineDiff(label, it.before, it.after));
    if (it.notes.length) console.log(`# ${it.notes.join('; ')}`);
    console.log();
  }
}

function idOf(text: string): string | null {
  try {
    const v = parseYamlFrontmatter(text).id;
    return v === undefined || v === null ? null : String(v);
  } catch {
    return null;
  }
}

function printReferences(all: Map<string, string>) {
  console.log('\nOther files that mention the old layout outside wikilinks (moves do not change these):');
  let n = 0;
  for (const [p, text] of [...all].sort(([a], [b]) => a.localeCompare(b))) {
    // The template is rewritten by phase 5; list only what that leaves behind.
    const hits = findTextReferences(p, p === TEMPLATE_PATH ? transformTemplate(text).content : text);
    if (!hits.length) continue;
    n++;
    console.log(`  ${p.slice(1)}`);
    for (const h of hits) console.log(`      ${h}`);
  }
  if (!n) console.log('  (none)');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function removeEmptyFolders(args: Args): Promise<number> {
  const entries = await readFolderEntries(args);
  const under = entries.filter((e) => e.path.startsWith(DOMAINS_DIR));
  const files = under.filter((e) => e.type !== 'folder');
  if (!under.length && !entries.some((e) => e.path === DOMAINS_DIR.slice(0, -1))) {
    console.log('Domains and Topics/ is already gone.');
    return 0;
  }
  if (files.length) {
    console.log(`Refusing: Domains and Topics/ still holds ${files.length} files:`);
    for (const f of files) console.log(`  ${f.path}`);
    return 1;
  }
  console.log(`Domains and Topics/ holds only ${under.length} empty folder entries.`);
  if (!args.apply) { console.log('DRY RUN: would trash "Domains and Topics/" (re-run with --apply).'); return 0; }
  const res = await postJson(args.relayUrl, '/doc/trash', { path: `${args.folderName}${DOMAINS_DIR.slice(0, -1)}`, force: false });
  console.log(`Trashed: ${JSON.stringify(res).slice(0, 300)}`);
  return 0;
}

/** --report: everything printed also goes to this file (synchronously, so process.exit loses nothing). */
function teeOutput(file: string) {
  const fd = fs.openSync(file, 'w');
  for (const name of ['log', 'error'] as const) {
    const orig = console[name].bind(console);
    console[name] = (...a: unknown[]) => {
      orig(...a);
      fs.writeSync(fd, a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ') + '\n');
    };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.report) teeOutput(args.report);
  if (!args.fromDir && !SERVER_TOKEN && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(args.relayUrl)) {
    throw new Error('RELAY_SERVER_TOKEN must be set for a non-local relay');
  }
  if (args.removeEmptyFolders) {
    if (args.fromDir) throw new Error('--remove-empty-folders needs a relay');
    process.exit(await removeEmptyFolders(args));
  }

  let snap: Snapshot;
  let all: Map<string, string> | null = null;
  const source = args.fromDir ? `directory ${path.resolve(args.fromDir)}` : `relay ${args.relayUrl}`;
  if (args.fromDir) {
    const r = snapshotFromDir(args.fromDir, args.references);
    snap = r.snap;
    all = args.references ? r.all : null;
  } else {
    snap = await snapshotFromRelay(args);
  }
  console.log(`Loaded ${snap.entries.length} entries, ${snap.contents.size} documents read (${source})`);

  const plan = planMigration(snap, planOptions(args));
  const journal: Journal = (!args.fromDir && loadJournal(args)) || { relayUrl: args.relayUrl, folderId: args.folderId, entries: {} };
  const resume = resumeItems(journal, snap, plan);
  plan.problems.push(...resume.problems);
  for (const uuid of resume.completed) journal.entries[uuid].state = 'done';
  printPlan(args, plan, source, resume.items, snap);
  if (all) printReferences(all);

  if (plan.problems.length) {
    console.log(`\nSTOP: ${plan.problems.length} problem(s); nothing ${args.apply ? 'applied' : 'to apply until they are resolved'}.`);
    process.exit(1);
  }
  if (!args.apply) {
    console.log('\nDRY RUN: nothing changed. Re-run with --apply to perform.');
    process.exit(0);
  }

  if (!fs.existsSync(args.journal) && !args.noJournalCheck) {
    const evidence = partialMigrationEvidence(snap);
    if (evidence.length) {
      console.log(`\nSTOP: no journal at ${args.journal}, but Concepts/ already holds ${evidence.length} migrated domain/topic or tagged placeholder file(s), e.g. ${evidence.slice(0, 3).map((p) => p.slice(1)).join(', ')}.`);
      console.log('An earlier apply ran with another journal: pass --journal <that file>, or --no-journal-check if it is really lost.');
      process.exit(1);
    }
  }
  if (resume.completed.length) saveJournal(args, journal);
  // Finish what an earlier run started, then the plan.
  const report = await applyPlan(args, [...resume.items, ...plan.items.filter((it) => matchesOnly(args, it.path))], journal);
  console.log('='.repeat(78));
  console.log(`Applied: ${report.edited} docs edited, ${report.moved} moved (${report.linksRewritten} links rewritten), ${report.trashed} trashed`);
  for (const e of report.errors) console.log(`  ERROR ${e.path}: ${e.reason}`);
  for (const e of report.skipped) console.log(`  PROBLEM (skipped) ${e.path}: ${e.reason}`);

  // Re-read everything and check: nothing left to do, links resolve.
  await new Promise((r) => setTimeout(r, 1500));
  const after = await snapshotFromRelay(args);
  const replan = planMigration(after, planOptions(args));
  const reresume = resumeItems(journal, after, replan);
  const remaining = [...reresume.items, ...replan.items.filter((it) => matchesOnly(args, it.path))];
  console.log(`Re-plan after apply: ${remaining.length} pending changes, ${replan.problems.length} problems`);
  for (const it of remaining.slice(0, 20)) console.log(`  pending: ${it.kind} ${it.path}`);
  for (const p of replan.problems) console.log(`  PROBLEM ${p.path}: ${p.reason}`);
  if (!args.only) {
    const placeholderIds = new Set(Object.values(journal.entries).filter((j) => j.kind === 'placeholder').map((j) => j.uuid));
    const v = verifyMigrated(after, placeholderIds);
    console.log(`Verify: ${JSON.stringify(v.stats)}; ${v.problems.length} problems`);
    for (const p of v.problems) console.log(`  VERIFY ${p.path}: ${p.reason}`);
    if (v.problems.length) process.exit(1);
  }
  process.exit(report.errors.length || report.skipped.length || remaining.length || replan.problems.length ? 1 : 0);
}

main().catch((err) => {
  if (err instanceof TransformError) console.error(`TransformError: ${err.message}`);
  else console.error(err?.stack ?? String(err));
  process.exit(1);
});
