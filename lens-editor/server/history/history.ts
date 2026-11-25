import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * A Lens Edu file's past versions, read from a git copy of lens-edu-staging (relay-git-sync
 * commits the folder there about every 30 s; the repo is public). Lens Edu only: the team
 * folder's history can hold text an AI scrubbed after upload (Luc, standup 2026-10-20).
 */

export interface Version { sha: string; ts: number; author: string | null }
export interface Session {
  start: number; end: number;
  authors: string[]; unknown: boolean;
  versions: Version[];
  /** Newest version in the session, and the newest one before it (diff base; null = file's first). */
  head: string; base: string | null;
}

// Commits by the sync bot (named Relay Sync for 20-26 Jan 2026), or the January import, carry no real author.
const UNKNOWN = new Set(['Relay Git Sync', 'Relay Sync', 'root']);
const R = '\x1e', U = '\x1f';
export const LOG_FORMAT = `%H${U}%an${U}%at${R}`;
const GAP_MS = 30 * 60_000;
const EDU = 'Lens Edu/';

export function parseLog(out: string): Version[] {
  return out.split(R).map(s => s.trim()).filter(Boolean).map(rec => {
    const [sha, an, at] = rec.split(U);
    return { sha, author: UNKNOWN.has(an) ? null : an, ts: Number(at) * 1000 };
  });
}

/** Newest-first versions into editing sessions: a new session after a gap of more than 30 min. */
export function groupSessions(versions: Version[], gapMs = GAP_MS): Session[] {
  const groups: Version[][] = [];
  for (const v of versions) {
    const g = groups.at(-1);
    if (g && g.at(-1)!.ts - v.ts <= gapMs) g.push(v);
    else groups.push([v]);
  }
  return groups.map((g, i) => ({
    start: g.at(-1)!.ts, end: g[0].ts,
    authors: [...new Set(g.map(v => v.author).filter((a): a is string => a !== null))],
    unknown: g.some(v => v.author === null),
    versions: g,
    head: g[0].sha, base: groups[i + 1]?.[0].sha ?? null,
  }));
}

/** 'Lens Edu/x/y.md' → 'x/y.md'; null for anything outside Lens Edu or not a plain path. */
export function repoPath(relayPath: string): string | null {
  if (!relayPath.startsWith(EDU)) return null;
  const rest = relayPath.slice(EDU.length);
  const parts = rest.split('/');
  if (!rest || rest.includes('\0') || rest.startsWith('-')) return null;
  if (parts.some(p => p === '' || p === '.' || p === '..')) return null;
  return rest;
}

const run = promisify(execFile);

// A changed-path commit-graph makes `git log -- <path>` ~10x cheaper (measured 0.47 s → 0.05 s on
// this repo's 26k commits); rebuilt in the background at most this often, after new commits arrive.
const INDEX_EVERY_MS = 10 * 60_000;
// Per repo, not per instance: two instances on one repo (a dev reload, tests) must not run two
// `commit-graph write`s at once, which would fight over commit-graph.lock.
const indexByRepo = new Map<string, { running: Promise<void> | null; at: number }>();
/** For tests: whether a commit-graph rebuild has been started for this repo. */
export const indexStarted = (repoDir: string) => (indexByRepo.get(repoDir)?.at ?? 0) > 0;

// The history ref is fetched by this module itself (not by promotion's admin-only poll), into a ref
// of its own so it never contends with promotion's ref locks, at most this often.
const FETCH_EVERY_MS = 60_000;

export interface HistoryOptions {
  repoDir: string;
  ref: string;
  /** Fetch `branch` from here into `ref` before reads; omit to read `ref` as it stands. */
  remoteUrl?: string;
  branch?: string;
  fetchEveryMs?: number;
}

export function createHistory({ repoDir, ref, remoteUrl, branch = 'staging', fetchEveryMs = FETCH_EVERY_MS }: HistoryOptions) {
  let fetching: Promise<void> | null = null;
  let fetchedAt = -Infinity;
  // Literal pathspecs: a path like 'x/*.md' or ':(glob)**' must name one file, not match many.
  const git = (args: string[]) =>
    run('git', args, { cwd: repoDir, timeout: 20_000, maxBuffer: 64 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' } });
  const hasRef = () => git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).then(() => true, () => false);

  /** Fetch unless one ran within the interval. A failure is logged and the last copy served,
   *  unless there is no copy at all, which throws. */
  let haveCopy = false;
  /** Start a fetch unless one ran within the interval. Once a copy exists the fetch runs in the
   *  background and readers are served the copy at once (Assay, #197); a failure is logged and
   *  the copy kept. With no copy yet, readers wait, and a failed fetch is raised to them. */
  async function refresh(): Promise<void> {
    if (!remoteUrl) return;
    if (!fetching && Date.now() - fetchedAt >= fetchEveryMs) {
      fetchedAt = Date.now();
      fetching = git(['fetch', '--quiet', '--no-tags', remoteUrl, `+refs/heads/${branch}:${ref}`])
        .then(() => { haveCopy = true; }, async e => {
          if (!(await hasRef())) throw e;
          haveCopy = true;
          console.error('[history] fetch failed, serving the last copy:', e.message);
        })
        .finally(() => { fetching = null; });
    }
    if (!fetching) return;
    haveCopy ||= await hasRef();
    if (!haveCopy) await fetching;
    else fetching.catch(() => undefined);   // background: failures are logged inside, never raised
  }

  return {
    /** For tests: resolves when the running fetch (if any) has landed. */
    fetched: (): Promise<void> => (fetching ?? Promise.resolve()).catch(() => undefined),
    async log(path: string): Promise<Version[]> {
      await refresh();
      const { stdout } = await git(['log', `--format=${LOG_FORMAT}`, ref, '--', path]);
      this.refreshIndex();
      return parseLog(stdout);
    },
    /** Commit time (ms) of the ref's tip: how fresh this copy of the history is. */
    async asOf(): Promise<number> {
      await refresh();
      return Number((await git(['log', '-1', '--format=%ct', ref])).stdout.trim()) * 1000;
    },
    /** Rebuild the commit-graph unless one is running or was built recently; resolves when done. */
    refreshIndex(): Promise<void> {
      const st = indexByRepo.get(repoDir) ?? { running: null, at: 0 };
      indexByRepo.set(repoDir, st);
      if (st.running || Date.now() - st.at < INDEX_EVERY_MS) return st.running ?? Promise.resolve();
      st.at = Date.now();
      st.running = git(['commit-graph', 'write', '--reachable', '--changed-paths'])
        .then(() => undefined, e => console.error('[history] commit-graph write failed:', e.message))
        .finally(() => { st.running = null; });
      return st.running;
    },
    /** Many versions at once, in order, through one `git cat-file --batch`; null where the file
     *  did not exist. The shas must come from this history's own log (no ancestor check here). */
    async showMany(items: { sha: string; path: string }[]): Promise<(string | null)[]> {
      if (!items.length) return [];
      for (const { sha, path } of items) {
        if (!/^[0-9a-f]{40}$/.test(sha) || path.includes('\n')) throw new Error(`bad version: ${sha} ${path}`);
      }
      const out = await catFileBatch(repoDir, items.map(i => `${i.sha}:${i.path}\n`).join(''));
      return parseBatch(out, items.length);
    },
    /** The file at `sha`, or null if the file did not exist then or `sha` is not in this history. */
    async show(sha: string, path: string): Promise<string | null> {
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`not a full sha: ${sha}`);
      const inHistory = await git(['merge-base', '--is-ancestor', sha, ref]).then(() => true, () => false);
      if (!inHistory) return null;
      const { stdout } = await git(['ls-tree', '-z', sha, '--', path]);
      if (!stdout) return null;
      return (await git(['show', `${sha}:${path}`])).stdout;
    },
  };
}

function catFileBatch(repoDir: string, input: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], { cwd: repoDir, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    const chunks: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`git cat-file --batch exited ${code}: ${err.trim()}`));
    });
    child.stdin.end(input);
  });
}

/** `git cat-file --batch` output: per request, "<oid> <type> <size>\n<bytes>\n" or "<name> missing\n". */
export function parseBatch(out: Buffer, n: number): (string | null)[] {
  const res: (string | null)[] = [];
  let at = 0;
  for (let i = 0; i < n; i++) {
    const eol = out.indexOf(0x0a, at);
    if (eol < 0) throw new Error('git cat-file --batch: output ended early');
    const header = out.subarray(at, eol).toString('utf8');
    at = eol + 1;
    const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
    if (!m) { res.push(null); continue; }   // "<name> missing" (or ambiguous)
    const size = Number(m[2]);
    res.push(m[1] === 'blob' ? out.subarray(at, at + size).toString('utf8') : null);
    at += size + 1;
  }
  return res;
}

