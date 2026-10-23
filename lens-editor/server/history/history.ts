import { execFile } from 'node:child_process';
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

// Commits by the sync bot (or the January import) carry no real author.
const UNKNOWN = new Set(['Relay Git Sync', 'root']);
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

export function createHistory({ repoDir, ref }: { repoDir: string; ref: string }) {
  let indexing: Promise<void> | null = null;
  let indexedAt = 0;
  const git = (args: string[]) =>
    run('git', args, { cwd: repoDir, timeout: 20_000, maxBuffer: 64 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return {
    async log(path: string): Promise<Version[]> {
      const { stdout } = await git(['log', `--format=${LOG_FORMAT}`, ref, '--', path]);
      this.refreshIndex();
      return parseLog(stdout);
    },
    /** Rebuild the commit-graph unless one is running or was built recently; resolves when done. */
    refreshIndex(): Promise<void> {
      if (indexing || Date.now() - indexedAt < INDEX_EVERY_MS) return indexing ?? Promise.resolve();
      indexedAt = Date.now();
      indexing = git(['commit-graph', 'write', '--reachable', '--changed-paths'])
        .then(() => undefined, e => console.error('[history] commit-graph write failed:', e.message))
        .finally(() => { indexing = null; });
      return indexing;
    },
    async show(sha: string, path: string): Promise<string | null> {
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`not a full sha: ${sha}`);
      const { stdout } = await git(['ls-tree', '-z', sha, '--', path]);
      if (!stdout) return null;
      return (await git(['show', `${sha}:${path}`])).stdout;
    },
  };
}
