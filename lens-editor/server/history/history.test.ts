import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHistory, groupSessions, parseLog, repoPath, type Version } from './history.ts';

const R = '\x1e', U = '\x1f';
const MIN = 60_000;

describe('parseLog', () => {
  it('reads sha, author and time, and maps the sync bot and root to unknown', () => {
    const out = `a1${U}Elias${U}1000${R}\nb2${U}Relay Git Sync${U}900${R}\nc3${U}root${U}800${R}\n`;
    expect(parseLog(out)).toEqual([
      { sha: 'a1', author: 'Elias', ts: 1_000_000 },
      { sha: 'b2', author: null, ts: 900_000 },
      { sha: 'c3', author: null, ts: 800_000 },
    ]);
  });
  it('returns nothing for empty output', () => {
    expect(parseLog('')).toEqual([]);
  });
});

describe('groupSessions', () => {
  const v = (sha: string, min: number, author: string | null): Version => ({ sha, ts: min * MIN, author });

  it('splits when the gap is longer than 30 minutes, not when it is exactly 30', () => {
    const s = groupSessions([v('d', 100, 'A'), v('c', 70, 'A'), v('b', 39, 'B'), v('a', 0, 'A')]);
    expect(s.map(x => x.versions.map(y => y.sha))).toEqual([['d', 'c'], ['b'], ['a']]);
  });
  it('lists authors once each, newest first, and flags unknown ones', () => {
    const [s] = groupSessions([v('c', 3, 'A'), v('b', 2, null), v('a', 1, 'B'), v('z', 0, 'A')]);
    expect(s.authors).toEqual(['A', 'B']);
    expect(s.unknown).toBe(true);
    expect(s.start).toBe(0);
    expect(s.end).toBe(3 * MIN);
  });
  it('gives each session the newest sha before it as its base, and null for the oldest', () => {
    const s = groupSessions([v('c', 100, 'A'), v('b', 50, 'A'), v('a', 0, 'A')]);
    expect(s.map(x => [x.head, x.base])).toEqual([['c', 'b'], ['b', 'a'], ['a', null]]);
  });
});

describe('repoPath', () => {
  it('maps a Lens Edu relay path to its path in the repo', () => {
    expect(repoPath('Lens Edu/Lenses/A b.md')).toBe('Lenses/A b.md');
  });
  it.each([
    'Lens/09-Transcripts/x.md',      // the team folder: never
    'Lens Edu/../Lens/x.md',
    'Lens Edu/Lenses/../../Lens/x.md',
    'Lens Edu/',
    'Lens Edu',
    '/Lens Edu/x.md',
    'Lens Edux/y.md',
    'Lens Edu/a\0b.md',
    'Lens Edu/-x.md',                 // would read as a git option
  ])('refuses %j', p => {
    expect(repoPath(p)).toBeNull();
  });
});

describe('createHistory on a real repo', () => {
  let dir = '';
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir }).toString();
  const commit = (file: string, body: string, author: string, t: number) => {
    return fs.writeFile(path.join(dir, file), body).then(() => {
      git('add', '-A');
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false',
        'commit', '-q', '-m', 'Auto-sync', `--author=${author} <x@y>`], {
        cwd: dir,
        env: { ...process.env, GIT_AUTHOR_DATE: `@${t} +0000`, GIT_COMMITTER_DATE: `@${t} +0000` },
      });
      return git('rev-parse', 'HEAD').trim();
    });
  };
  let first = '', second = '';

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'history-'));
    git('init', '-q', '-b', 'staging');
    await fs.mkdir(path.join(dir, 'Lenses'));
    first = await commit('Lenses/a.md', 'one\n', 'Elias', 1000);
    await commit('Lenses/other.md', 'x\n', 'Luc', 2000);
    second = await commit('Lenses/a.md', 'two\n', 'Relay Git Sync', 3000);
  });
  afterAll(() => fs.rm(dir, { recursive: true, force: true }));

  it('lists only the commits that touched the file, newest first', async () => {
    const h = createHistory({ repoDir: dir, ref: 'staging' });
    expect(await h.log('Lenses/a.md')).toEqual([
      { sha: second, author: null, ts: 3_000_000 },
      { sha: first, author: 'Elias', ts: 1_000_000 },
    ]);
  });
  it('reads the file as it was at a commit, and null where it did not exist', async () => {
    const h = createHistory({ repoDir: dir, ref: 'staging' });
    expect(await h.show(first, 'Lenses/a.md')).toBe('one\n');
    expect(await h.show(second, 'Lenses/a.md')).toBe('two\n');
    expect(await h.show(first, 'Lenses/other.md')).toBeNull();
  });
  it('builds a changed-path commit-graph after a log, once', async () => {
    const h = createHistory({ repoDir: dir, ref: 'staging' });
    await h.log('Lenses/a.md');
    await h.refreshIndex();
    const graph = path.join(dir, '.git/objects/info/commit-graph');
    const stat = await fs.stat(graph);
    expect(execFileSync('git', ['commit-graph', 'verify'], { cwd: dir }).toString()).toBe('');
    await h.log('Lenses/a.md');
    await h.refreshIndex();
    expect((await fs.stat(graph)).mtimeMs).toBe(stat.mtimeMs);
  });
  it('refuses a sha that is not a full hex id', async () => {
    const h = createHistory({ repoDir: dir, ref: 'staging' });
    await expect(h.show('staging', 'Lenses/a.md')).rejects.toThrow(/sha/);
  });
});
