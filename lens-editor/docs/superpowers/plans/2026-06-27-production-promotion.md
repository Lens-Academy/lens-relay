# Production Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Lens Editor workflow that promotes selected files from GitHub `staging` to `main` by creating a clean promotion PR and enabling auto-merge.

**Architecture:** The Lens Editor server owns all Git and GitHub operations through a promotion service backed by a persistent scratch clone. The React client asks the server for branch diffs, renders file-level production status and a promotion overview page, then sends selected paths to create a PR from the latest `staging`.

**Tech Stack:** React, React Router, Hono, TypeScript, Node `child_process`, local Git CLI, GitHub REST/GraphQL APIs, Vitest, Testing Library

---

## File Structure

Create:

```txt
lens-editor/server/promotion/types.ts          Shared server-side promotion types.
lens-editor/server/promotion/config.ts         Reads and validates promotion environment config.
lens-editor/server/promotion/config.test.ts    Tests env parsing and disabled/misconfigured behavior.
lens-editor/server/promotion/path-validation.ts Validates repo-relative paths and requested selections.
lens-editor/server/promotion/path-validation.test.ts Direct security tests for path validation.
lens-editor/server/promotion/git.ts            Local Git clone operations and diff/promotion branch logic.
lens-editor/server/promotion/git.test.ts       Temp-repo tests for diff and branch creation.
lens-editor/server/promotion/github.ts         GitHub PR creation and auto-merge integration.
lens-editor/server/promotion/github.test.ts    Fetch-mocked tests for GitHub API behavior.
lens-editor/server/promotion/routes.ts         Hono `/api/promotion` route handlers.
lens-editor/server/promotion/routes.test.ts    Route auth, validation, and response tests.
lens-editor/server/promotion/integration.test.ts Temp Git repo + fake GitHub HTTP server workflow test.
lens-editor/src/lib/promotion-api.ts           Browser API wrapper for `/api/promotion/*`.
lens-editor/src/lib/promotion-api.test.ts      API wrapper tests.
lens-editor/src/components/Promotion/DiffViewer.tsx
lens-editor/src/components/Promotion/DiffViewer.test.tsx
lens-editor/src/components/Promotion/PromotionStatus.tsx
lens-editor/src/components/Promotion/PromotionStatus.test.tsx
lens-editor/src/components/Promotion/PromoteFileDialog.tsx
lens-editor/src/components/Promotion/PromoteFileDialog.test.tsx
lens-editor/src/components/Promotion/PromotionPage.tsx
lens-editor/src/components/Promotion/PromotionPage.test.tsx
```

Modify:

```txt
lens-editor/server/app.ts                      Mount promotion routes when enabled.
lens-editor/src/App.tsx                        Add `/promote` route for edit users.
lens-editor/src/components/Layout/EditorArea.tsx Render document promotion status/action in header controls.
lens-editor/package.json                       No new runtime dependency required for version 1.
```

Use `jj st` before and after every task. Use the task-specific `jj describe -m` commands listed below to name each completed task change, then `jj new` before starting the next task if implementing this plan as separate jj changes.

---

### Task 1: Promotion Types, Config, And Path Validation

**Files:**
- Create: `lens-editor/server/promotion/types.ts`
- Create: `lens-editor/server/promotion/config.ts`
- Create: `lens-editor/server/promotion/path-validation.ts`
- Test through: `lens-editor/server/promotion/routes.test.ts` in Task 4 and `git.test.ts` in Task 2

- [ ] **Step 1: Run status**

Run:

```bash
jj st
```

Expected: note any existing changes and do not overwrite unrelated work.

- [ ] **Step 2: Create shared promotion types**

Add:

```typescript
// lens-editor/server/promotion/types.ts
export type PromotionFileStatus = 'identical' | 'modified' | 'added' | 'deleted' | 'renamed';

export interface PromotionFileChange {
  path: string;
  oldPath: string | null;
  status: PromotionFileStatus;
  additions: number;
  deletions: number;
  isBinary: boolean;
}

export interface PromotionChangesResponse {
  mainSha: string;
  generatedAt: string;
  files: PromotionFileChange[];
}

export interface PromotionStatusResponse extends PromotionFileChange {
  mainSha: string;
}

export interface PromotionDiffResponse {
  path: string;
  mainSha: string;
  status: PromotionFileStatus;
  isBinary: boolean;
  beforeBlob?: { oid: string; size: number } | null;
  afterBlob?: { oid: string; size: number } | null;
  diff: string;
}

export interface PromotionPrRequest {
  paths: string[];
  title?: string;
}

export interface PromotionPrResponse {
  branch: string;
  prNumber: number;
  prUrl: string;
  mainSha: string;
  autoMergeEnabled: boolean;
  warning?: string;
}

export interface PromotionConfig {
  enabled: boolean;
  repoUrl: string;
  repoDir: string;
  mainBranch: string;
  stagingBranch: string;
  branchPrefix: string;
  mergeMethod: 'SQUASH' | 'MERGE' | 'REBASE';
  githubOwner: string;
  githubRepo: string;
  githubToken: string;
}

export class PromotionError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = 'PromotionError';
  }
}
```

- [ ] **Step 3: Create config loader**

Add:

```typescript
// lens-editor/server/promotion/config.ts
import type { PromotionConfig } from './types.ts';

export function loadPromotionConfig(env: NodeJS.ProcessEnv = process.env): PromotionConfig {
  const enabled = env.PROMOTION_ENABLED === 'true';
  return {
    enabled,
    repoUrl: env.PROMOTION_REPO_URL ?? '',
    repoDir: env.PROMOTION_REPO_DIR ?? '',
    mainBranch: env.PROMOTION_MAIN_BRANCH ?? 'main',
    stagingBranch: env.PROMOTION_STAGING_BRANCH ?? 'staging',
    branchPrefix: env.PROMOTION_BRANCH_PREFIX ?? 'promote/lens-editor',
    mergeMethod: parseMergeMethod(env.PROMOTION_MERGE_METHOD),
    githubOwner: env.PROMOTION_GITHUB_OWNER ?? '',
    githubRepo: env.PROMOTION_GITHUB_REPO ?? '',
    githubToken: env.GITHUB_TOKEN ?? '',
  };
}

export function promotionConfigReady(config: PromotionConfig): boolean {
  if (!config.enabled) return false;
  return Boolean(
    config.repoUrl &&
    config.repoDir &&
    config.mainBranch &&
    config.stagingBranch &&
    config.branchPrefix &&
    config.mergeMethod &&
    config.githubOwner &&
    config.githubRepo &&
    config.githubToken,
  );
}

function parseMergeMethod(value: string | undefined): PromotionConfig['mergeMethod'] {
  if (value === 'MERGE' || value === 'REBASE' || value === 'SQUASH') return value;
  return 'SQUASH';
}
```

- [ ] **Step 4: Write failing tests for config and path validation**

Create:

```typescript
// lens-editor/server/promotion/path-validation.test.ts
import { describe, it, expect } from 'vitest';
import { validatePromotionPaths, validateRepoPath } from './path-validation.ts';
import type { PromotionFileChange } from './types.ts';

const changedFiles: PromotionFileChange[] = [
  { path: 'Courses/Intro.md', oldPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false },
  { path: 'Courses/New Name.md', oldPath: 'Courses/Old Name.md', status: 'renamed', additions: 2, deletions: 2, isBinary: false },
];

describe('promotion path validation', () => {
  it('accepts normalized repo-relative paths', () => {
    expect(validateRepoPath('Courses/Intro.md')).toBe('Courses/Intro.md');
  });

  it.each(['/etc/passwd', '../secret.md', 'Courses/../secret.md', 'Courses\\Intro.md', '', '.'])('rejects unsafe path %s', pathValue => {
    expect(() => validateRepoPath(pathValue)).toThrow();
  });

  it('deduplicates selected paths', () => {
    expect(validatePromotionPaths(['Courses/Intro.md', 'Courses/Intro.md'], changedFiles)).toEqual(['Courses/Intro.md']);
  });

  it('rejects paths not present in the branch diff', () => {
    expect(() => validatePromotionPaths(['Courses/Unchanged.md'], changedFiles)).toThrow(/not changed/);
  });

  it('allows selecting either side of a rename row', () => {
    expect(validatePromotionPaths(['Courses/Old Name.md', 'Courses/New Name.md'], changedFiles)).toEqual(['Courses/Old Name.md', 'Courses/New Name.md']);
  });

  it('rejects more than 100 paths', () => {
    const paths = Array.from({ length: 101 }, (_, index) => `Courses/${index}.md`);
    expect(() => validatePromotionPaths(paths, changedFiles)).toThrow(/At most 100/);
  });
});
```

```typescript
// lens-editor/server/promotion/config.test.ts
import { describe, it, expect } from 'vitest';
import { loadPromotionConfig, promotionConfigReady } from './config.ts';

describe('promotion config', () => {
  it('is disabled by default', () => {
    const config = loadPromotionConfig({});
    expect(config.enabled).toBe(false);
    expect(promotionConfigReady(config)).toBe(false);
  });

  it('requires all operational fields when enabled', () => {
    const config = loadPromotionConfig({ PROMOTION_ENABLED: 'true' });
    expect(config.enabled).toBe(true);
    expect(promotionConfigReady(config)).toBe(false);
  });

  it('defaults merge method to SQUASH and accepts configured methods', () => {
    expect(loadPromotionConfig({ PROMOTION_MERGE_METHOD: 'BOGUS' }).mergeMethod).toBe('SQUASH');
    expect(loadPromotionConfig({ PROMOTION_MERGE_METHOD: 'MERGE' }).mergeMethod).toBe('MERGE');
  });
});
```

Run:

```bash
cd lens-editor && npx vitest run server/promotion/path-validation.test.ts server/promotion/config.test.ts
```

Expected: fail because the implementation files do not exist yet.

- [ ] **Step 5: Create path validation helpers**

Add:

```typescript
// lens-editor/server/promotion/path-validation.ts
import path from 'node:path/posix';
import { PromotionError, type PromotionFileChange } from './types.ts';

const MAX_PROMOTION_PATHS = 100;

export function validateRepoPath(input: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new PromotionError(400, 'Path is required', 'invalid_path');
  }
  if (input.startsWith('/') || input.includes('\\')) {
    throw new PromotionError(400, 'Path must be repository-relative', 'invalid_path');
  }
  const normalized = path.normalize(input);
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new PromotionError(400, 'Path cannot traverse outside the repository', 'invalid_path');
  }
  return normalized;
}

export function validatePromotionPaths(paths: unknown, changedFiles: PromotionFileChange[]): string[] {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new PromotionError(400, 'At least one path is required', 'invalid_paths');
  }
  if (paths.length > MAX_PROMOTION_PATHS) {
    throw new PromotionError(400, `At most ${MAX_PROMOTION_PATHS} paths can be promoted at once`, 'too_many_paths');
  }

  const changed = new Set<string>();
  for (const file of changedFiles) {
    changed.add(file.path);
    if (file.oldPath) changed.add(file.oldPath);
  }

  const normalized = [...new Set(paths.map(pathValue => validateRepoPath(String(pathValue))))];
  for (const filePath of normalized) {
    if (!changed.has(filePath)) {
      throw new PromotionError(400, `Path is not changed between staging and main: ${filePath}`, 'path_not_changed');
    }
  }
  return normalized;
}
```

- [ ] **Step 6: Run validation and config tests**

Run:

```bash
cd lens-editor && npx vitest run server/promotion/path-validation.test.ts server/promotion/config.test.ts
```

Expected: pass.

- [ ] **Step 7: Run TypeScript build**

Run:

```bash
cd lens-editor && npm run build
```

Expected: TypeScript succeeds or fails only because the new modules are not imported yet. If TypeScript reports a concrete syntax/type error in these files, fix it before continuing.

- [ ] **Step 8: Record status**

Run:

```bash
jj st
jj describe -m "Add promotion configuration and validation types"
```

Expected: the new promotion type/config/path files are listed.

---

### Task 2: Local Git Promotion Service

**Files:**
- Create: `lens-editor/server/promotion/git.ts`
- Create: `lens-editor/server/promotion/git.test.ts`
- Modify: `lens-editor/server/promotion/path-validation.ts` only if tests expose a validation bug

- [ ] **Step 1: Write failing Git service tests**

Add tests with temp repositories:

```typescript
// lens-editor/server/promotion/git.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnFile } from './git.ts';
import { createGitPromotionService } from './git.ts';
import type { PromotionConfig } from './types.ts';

async function git(cwd: string, args: string[]) {
  await spawnFile('git', args, { cwd });
}

async function write(repo: string, filePath: string, content: string) {
  await mkdir(path.dirname(path.join(repo, filePath)), { recursive: true });
  await writeFile(path.join(repo, filePath), content);
}

describe('git promotion service', () => {
  let root: string;
  let remote: string;
  let work: string;
  let config: PromotionConfig;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'promotion-git-'));
    remote = path.join(root, 'remote.git');
    work = path.join(root, 'work');

    await git(root, ['init', '--bare', remote]);
    await git(root, ['clone', remote, work]);
    await git(work, ['config', 'user.email', 'test@example.com']);
    await git(work, ['config', 'user.name', 'Test User']);

    await write(work, 'Courses/Intro.md', 'main\n');
    await write(work, 'Courses/Same.md', 'same\n');
    await write(work, 'Courses/Unchanged.md', 'unchanged\n');
    await write(work, 'Courses/Old Name.md', 'rename me\n');
    await git(work, ['add', '.']);
    await git(work, ['commit', '-m', 'main']);
    await git(work, ['branch', '-M', 'main']);
    await git(work, ['push', 'origin', 'main']);

    await git(work, ['switch', '-c', 'staging']);
    await write(work, 'Courses/Intro.md', 'staging\n');
    await write(work, 'Courses/New.md', 'new\n');
    await git(work, ['mv', 'Courses/Old Name.md', 'Courses/New Name.md']);
    await git(work, ['rm', 'Courses/Same.md']);
    await git(work, ['add', '.']);
    await git(work, ['commit', '-m', 'staging']);
    await git(work, ['push', 'origin', 'staging']);

    config = {
      enabled: true,
      repoUrl: remote,
      repoDir: path.join(root, 'scratch'),
      mainBranch: 'main',
      stagingBranch: 'staging',
      branchPrefix: 'promote/lens-editor',
      mergeMethod: 'SQUASH',
      githubOwner: 'Lens-Academy',
      githubRepo: 'lens-edu-relay',
      githubToken: 'token',
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('lists only files that differ between main and staging', async () => {
    const service = createGitPromotionService(config);
    expect(changes.files.map(f => [f.path, f.status])).toEqual([
      ['Courses/Intro.md', 'modified'],
      ['Courses/New.md', 'added'],
      ['Courses/New Name.md', 'renamed'],
      ['Courses/Same.md', 'deleted'],
    ]);
  });

  it('returns identical status for unchanged file', async () => {
    const service = createGitPromotionService(config);
    const status = await service.getStatus('Courses/Unchanged.md');
    expect(status.status).toBe('identical');
  });

  it('returns deleted status for files removed on staging', async () => {
    const service = createGitPromotionService(config);
    const status = await service.getStatus('Courses/Same.md');
    expect(status.status).toBe('deleted');
  });

  it('creates a branch that contains only selected file changes', async () => {
    const service = createGitPromotionService(config);
    const changes = await service.getChanges();
    const result = await service.createPromotionBranch({
      paths: ['Courses/Intro.md'],
    });
    expect(result.branch).toMatch(/^promote\/lens-editor\//);

    const promoted = path.join(root, 'promoted');
    await git(root, ['clone', remote, promoted]);
    await git(promoted, ['fetch', 'origin', result.branch]);
    await git(promoted, ['switch', '--detach', `origin/${result.branch}`]);

    const intro = await spawnFile('git', ['show', 'HEAD:Courses/Intro.md'], { cwd: promoted });
    expect(intro.stdout).toBe('staging\n');
    await expect(spawnFile('git', ['show', 'HEAD:Courses/New.md'], { cwd: promoted })).rejects.toThrow();
  });

  it('promotes both sides of a rename row', async () => {
    const service = createGitPromotionService(config);
    const changes = await service.getChanges();
    const rename = changes.files.find(file => file.status === 'renamed');
    expect(rename).toMatchObject({ path: 'Courses/New Name.md', oldPath: 'Courses/Old Name.md' });
    const result = await service.createPromotionBranch({
      paths: ['Courses/New Name.md'],
    });

    const promoted = path.join(root, 'promoted-rename');
    await git(root, ['clone', remote, promoted]);
    await git(promoted, ['fetch', 'origin', result.branch]);
    await git(promoted, ['switch', '--detach', `origin/${result.branch}`]);
    await expect(spawnFile('git', ['show', 'HEAD:Courses/Old Name.md'], { cwd: promoted })).rejects.toThrow();
    const renamed = await spawnFile('git', ['show', 'HEAD:Courses/New Name.md'], { cwd: promoted });
    expect(renamed.stdout).toBe('rename me\n');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd lens-editor && npx vitest run server/promotion/git.test.ts
```

Expected: fail because `server/promotion/git.ts` does not exist.

- [ ] **Step 3: Implement Git command wrapper and service**

Create `git.ts` with these exported members:

```typescript
// lens-editor/server/promotion/git.ts
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type {
  PromotionChangesResponse,
  PromotionConfig,
  PromotionFileChange,
  PromotionFileStatus,
  PromotionPrRequest,
} from './types.ts';
import { PromotionError } from './types.ts';
import { validateRepoPath } from './path-validation.ts';

interface SpawnResult {
  stdout: string;
  stderr: string;
}

export function spawnFile(command: string, args: string[], options: { cwd: string }): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      cwd: options.cwd,
      timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
    }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ stdout: String(stdout), stderr: String(stderr) });
        return;
      }
      reject(new PromotionError(500, `${command} ${args.join(' ')} failed: ${String(stderr) || String(stdout) || error.message}`, 'git_failed'));
    });
    child.stdin?.destroy();
  });
}

export interface CreatedPromotionBranch {
  branch: string;
  mainSha: string;
  sourceStagingSha: string;
}

export function createGitPromotionService(config: PromotionConfig) {
  let queue: Promise<unknown> = Promise.resolve();

  function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = queue.then(operation, operation);
    queue = run.catch(() => undefined);
    return run;
  }

  async function git(args: string[]) {
    await ensureRepo();
    return spawnFile('git', args, { cwd: config.repoDir });
  }

  async function ensureRepo() {
    await mkdir(path.dirname(config.repoDir), { recursive: true });
    try {
      await spawnFile('git', ['rev-parse', '--git-dir'], { cwd: config.repoDir });
    } catch {
      await spawnFile('git', ['clone', config.repoUrl, config.repoDir], { cwd: path.dirname(config.repoDir) });
    }
  }

  async function fetchBranches() {
    await git([
      'fetch',
      'origin',
      '--prune',
      `+refs/heads/${config.mainBranch}:refs/remotes/origin/${config.mainBranch}`,
      `+refs/heads/${config.stagingBranch}:refs/remotes/origin/${config.stagingBranch}`,
    ]);
    const mainSha = (await git(['rev-parse', `origin/${config.mainBranch}`])).stdout.trim();
    const stagingSha = (await git(['rev-parse', `origin/${config.stagingBranch}`])).stdout.trim();
    return { mainSha, stagingSha };
  }

  async function getChangesForRef(stagingRef: string): Promise<PromotionChangesResponse> {
    const { mainSha } = await fetchBranches();
    const files = await parseChangedFiles(`origin/${config.mainBranch}`, stagingRef);
    return { mainSha, generatedAt: new Date().toISOString(), files };
  }

  async function parseChangedFiles(baseRef: string, compareRef: string): Promise<PromotionFileChange[]> {
    const [nameStatus, numstat] = await Promise.all([
      git(['diff', '--name-status', '--find-renames', `${baseRef}..${compareRef}`]),
      git(['diff', '--numstat', `${baseRef}..${compareRef}`]),
    ]);
    const stats = parseNumstat(numstat.stdout);
    return nameStatus.stdout.trim().split('\n').filter(Boolean).map(line => parseNameStatus(line, stats));
  }

  function parseNumstat(output: string): Map<string, { additions: number; deletions: number; isBinary: boolean }> {
    const stats = new Map<string, { additions: number; deletions: number; isBinary: boolean }>();
    for (const line of output.trim().split('\n').filter(Boolean)) {
      const [addRaw, delRaw, filePath] = line.split('\t');
      const isBinary = addRaw === '-' || delRaw === '-';
      stats.set(filePath, {
        additions: isBinary ? 0 : Number(addRaw),
        deletions: isBinary ? 0 : Number(delRaw),
        isBinary,
      });
    }
    return stats;
  }

  function parseNameStatus(line: string, stats: Map<string, { additions: number; deletions: number; isBinary: boolean }>): PromotionFileChange {
    const parts = line.split('\t');
    const code = parts[0];
    const status = statusFromCode(code);
    const oldPath = status === 'renamed' ? parts[1] : null;
    const filePath = status === 'renamed' ? parts[2] : parts[1];
    const stat = stats.get(filePath) ?? { additions: 0, deletions: 0, isBinary: false };
    return { path: filePath, oldPath, status, ...stat };
  }

  function statusFromCode(code: string): PromotionFileStatus {
    if (code.startsWith('R')) return 'renamed';
    if (code === 'A') return 'added';
    if (code === 'D') return 'deleted';
    return 'modified';
  }

  async function getChanges() {
    return runExclusive(() => getChangesForRef(`origin/${config.stagingBranch}`));
  }

  async function getStatus(filePathRaw: string) {
    return runExclusive(async () => {
      const filePath = validateRepoPath(filePathRaw);
      const changes = await getChangesForRef(`origin/${config.stagingBranch}`);
      const found = changes.files.find(file => file.path === filePath || file.oldPath === filePath);
      return {
        path: filePath,
        oldPath: found?.oldPath ?? null,
        status: found?.status ?? 'identical',
        additions: found?.additions ?? 0,
        deletions: found?.deletions ?? 0,
        isBinary: found?.isBinary ?? false,
        mainSha: changes.mainSha,
      };
    });
  }

  async function getDiff(filePathRaw: string) {
    return runExclusive(async () => {
      const filePath = validateRepoPath(filePathRaw);
      const changes = await getChangesForRef(`origin/${config.stagingBranch}`);
      const status = changes.files.find(file => file.path === filePath || file.oldPath === filePath);
      const diff = await git(['diff', `origin/${config.mainBranch}..origin/${config.stagingBranch}`, '--', filePath]);
      const beforeBlob = await readBlobMetadata(`origin/${config.mainBranch}`, filePath);
      const afterBlob = await readBlobMetadata(`origin/${config.stagingBranch}`, filePath);
      return {
        path: filePath,
        mainSha: changes.mainSha,
        status: status?.status ?? 'identical',
        isBinary: status?.isBinary ?? false,
        beforeBlob,
        afterBlob,
        diff: diff.stdout,
      };
    });
  }

  async function createPromotionBranch(request: Pick<PromotionPrRequest, 'paths'>): Promise<CreatedPromotionBranch> {
    return runExclusive(async () => {
    const { mainSha, stagingSha } = await fetchBranches();
    const currentChanges = await getChangesForRef(`origin/${config.stagingBranch}`);
    const branch = `${config.branchPrefix}/${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')}-${Math.random().toString(16).slice(2, 8)}`;
    await git(['switch', '-C', branch, `origin/${config.mainBranch}`]);

    const pathsToApply = expandRenameSelections(request.paths, currentChanges.files);
    for (const rawPath of pathsToApply) {
      const filePath = validateRepoPath(rawPath);
      try {
        await git(['cat-file', '-e', `origin/${config.stagingBranch}:${filePath}`]);
        await git(['restore', `--source=origin/${config.stagingBranch}`, '--', filePath]);
      } catch {
        await git(['rm', '-f', '--ignore-unmatch', '--', filePath]);
      }
    }

    const status = (await git(['status', '--porcelain'])).stdout.trim();
    if (!status) throw new PromotionError(409, 'Selected files do not differ from main', 'nothing_to_promote');
    const allowed = new Set(pathsToApply.map(validateRepoPath));
    const changedOutsideSelection = status.split('\n').some(line => {
      const statusPath = line.slice(3);
      return statusPath && !allowed.has(statusPath);
    });
    if (changedOutsideSelection) {
      throw new PromotionError(500, 'Promotion branch contains changes outside the selected paths', 'unexpected_git_diff');
    }
    await git(['add', '--all', '--', ...pathsToApply.map(validateRepoPath)]);
    await git(['commit', '-m', `Promote selected course files\n\nSource staging commit: ${stagingSha}`]);
    await git(['push', 'origin', branch]);
    return { branch, mainSha, sourceStagingSha: stagingSha };
    });
  }

  function expandRenameSelections(paths: string[], files: PromotionFileChange[]): string[] {
    const selected = new Set(paths.map(validateRepoPath));
    for (const file of files) {
      if (file.status === 'renamed' && file.oldPath && (selected.has(file.path) || selected.has(file.oldPath))) {
        selected.add(file.path);
        selected.add(file.oldPath);
      }
    }
    return [...selected];
  }

  async function readBlobMetadata(ref: string, filePath: string): Promise<{ oid: string; size: number } | null> {
    try {
      const oid = (await git(['rev-parse', `${ref}:${filePath}`])).stdout.trim();
      const size = Number((await git(['cat-file', '-s', oid])).stdout.trim());
      return { oid, size };
    } catch {
      return null;
    }
  }

  return { getChanges, getStatus, getDiff, createPromotionBranch };
}
```

- [ ] **Step 4: Run Git service tests**

Run:

```bash
cd lens-editor && npx vitest run server/promotion/git.test.ts
```

Expected: pass. If the generated branch test exposes branch fetch syntax issues, fix the test or implementation to fetch `refs/heads/<branch>:refs/remotes/origin/<branch>`.

- [ ] **Step 5: Record status**

Run:

```bash
jj st
jj describe -m "Add local git promotion service"
```

---

### Task 3: GitHub PR And Auto-Merge Service

**Files:**
- Create: `lens-editor/server/promotion/github.ts`
- Create: `lens-editor/server/promotion/github.test.ts`

- [ ] **Step 1: Write failing GitHub tests**

Create fetch-mocked tests:

```typescript
// lens-editor/server/promotion/github.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGitHubPromotionService } from './github.ts';
import type { PromotionConfig } from './types.ts';

const config: PromotionConfig = {
  enabled: true,
  repoUrl: 'git@github.com:Lens-Academy/lens-edu-relay.git',
  repoDir: '/tmp/repo',
  mainBranch: 'main',
  stagingBranch: 'staging',
  branchPrefix: 'promote/lens-editor',
  mergeMethod: 'SQUASH',
  githubOwner: 'Lens-Academy',
  githubRepo: 'lens-edu-relay',
  githubToken: 'token',
};

describe('GitHub promotion service', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a PR and enables auto-merge', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        number: 42,
        html_url: 'https://github.com/Lens-Academy/lens-edu-relay/pull/42',
        node_id: 'PR_node',
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { enablePullRequestAutoMerge: { pullRequest: { number: 42 } } } }), { status: 200 }));

    const service = createGitHubPromotionService(config);
    const result = await service.createPullRequest({
      branch: 'promote/lens-editor/test',
      mainSha: 'mainsha',
      sourceStagingSha: 'stagingsha',
      paths: ['Courses/Intro.md'],
      title: 'Promote selected course files',
    });

    expect(result.prNumber).toBe(42);
    expect(result.autoMergeEnabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/Lens-Academy/lens-edu-relay/pulls',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer token' }),
        body: expect.stringContaining('Source staging commit: stagingsha'),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/graphql',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('mergeMethod: SQUASH'),
      }),
    );
  });

  it('returns warning when auto-merge fails after PR creation', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        number: 43,
        html_url: 'https://github.com/Lens-Academy/lens-edu-relay/pull/43',
        node_id: 'PR_node',
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ message: 'Auto-merge not allowed' }] }), { status: 200 }));

    const service = createGitHubPromotionService(config);
    const result = await service.createPullRequest({
      branch: 'promote/lens-editor/test',
      mainSha: 'mainsha',
      sourceStagingSha: 'stagingsha',
      paths: ['Courses/Intro.md'],
      title: 'Promote selected course files',
    });

    expect(result.prNumber).toBe(43);
    expect(result.autoMergeEnabled).toBe(false);
    expect(result.warning).toContain('Auto-merge');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd lens-editor && npx vitest run server/promotion/github.test.ts
```

Expected: fail because `github.ts` does not exist.

- [ ] **Step 3: Implement GitHub service**

Create:

```typescript
// lens-editor/server/promotion/github.ts
import { PromotionError, type PromotionConfig, type PromotionPrResponse } from './types.ts';

interface PullRequestInput {
  branch: string;
  mainSha: string;
  sourceStagingSha: string;
  paths: string[];
  title?: string;
}

export function createGitHubPromotionService(
  config: PromotionConfig,
  options: {
    apiBaseUrl?: string;
    graphqlUrl?: string;
    fetchImpl?: typeof fetch;
  } = {},
) {
  const apiBaseUrl = options.apiBaseUrl ?? 'https://api.github.com';
  const graphqlUrl = options.graphqlUrl ?? 'https://api.github.com/graphql';
  const fetchImpl = options.fetchImpl ?? fetch;

  async function githubFetch(url: string, init: RequestInit) {
    const response = await fetchImpl(url, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${config.githubToken}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new PromotionError(response.status, `GitHub request failed: ${body}`, 'github_failed');
    }
    return response;
  }

  async function createPullRequest(input: PullRequestInput): Promise<PromotionPrResponse> {
    const title = input.title || `Promote ${input.paths.length} course file${input.paths.length === 1 ? '' : 's'}`;
    const body = [
      'Created by Lens Editor production promotion.',
      '',
      `Source staging commit: ${input.sourceStagingSha}`,
      `Base main commit at branch creation: ${input.mainSha}`,
      '',
      'Promoted files:',
      ...input.paths.map(filePath => `- \`${filePath}\``),
    ].join('\n');

    const prResponse = await githubFetch(
      `${apiBaseUrl}/repos/${config.githubOwner}/${config.githubRepo}/pulls`,
      {
        method: 'POST',
        body: JSON.stringify({
          title,
          head: input.branch,
          base: config.mainBranch,
          body,
          maintainer_can_modify: true,
        }),
      },
    );
    const pr = await prResponse.json() as { number: number; html_url: string; node_id: string };
    const autoMerge = await enableAutoMerge(pr.node_id);
    return {
      branch: input.branch,
      prNumber: pr.number,
      prUrl: pr.html_url,
      mainSha: input.mainSha,
      sourceStagingSha: input.sourceStagingSha,
      autoMergeEnabled: autoMerge.enabled,
      ...(autoMerge.warning ? { warning: autoMerge.warning } : {}),
    };
  }

  async function enableAutoMerge(pullRequestId: string): Promise<{ enabled: boolean; warning?: string }> {
    const response = await fetchImpl(graphqlUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.githubToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: `
          mutation EnableAutoMerge($pullRequestId: ID!) {
            enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: ${config.mergeMethod} }) {
              pullRequest { number }
            }
          }
        `,
        variables: { pullRequestId },
      }),
    });
    if (!response.ok) {
      return { enabled: false, warning: `Auto-merge request failed with ${response.status}` };
    }
    const data = await response.json() as { errors?: Array<{ message: string }> };
    if (data.errors?.length) {
      return { enabled: false, warning: data.errors.map(error => error.message).join('; ') };
    }
    return { enabled: true };
  }

  return { createPullRequest };
}
```

- [ ] **Step 4: Run GitHub service tests**

Run:

```bash
cd lens-editor && npx vitest run server/promotion/github.test.ts
```

Expected: pass.

- [ ] **Step 5: Record status**

Run:

```bash
jj st
jj describe -m "Add GitHub promotion PR service"
```

---

### Task 4: Promotion API Routes

**Files:**
- Create: `lens-editor/server/promotion/routes.ts`
- Create: `lens-editor/server/promotion/routes.test.ts`
- Modify: `lens-editor/server/app.ts`

- [ ] **Step 1: Write failing route tests**

Create tests around a fake service:

```typescript
// lens-editor/server/promotion/routes.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { createPromotionRoutes } from './routes.ts';
import { signShareToken } from '../share-token.ts';

function editToken() {
  return signShareToken({
    purpose: 'share',
    role: 'edit',
    folder: '00000000-0000-0000-0000-000000000000',
    expiry: Math.floor(Date.now() / 1000) + 3600,
  });
}

function viewToken() {
  return signShareToken({
    purpose: 'share',
    role: 'view',
    folder: '00000000-0000-0000-0000-000000000000',
    expiry: Math.floor(Date.now() / 1000) + 3600,
  });
}

describe('promotion routes', () => {
  beforeEach(() => {
    process.env.SHARE_TOKEN_SECRET = 'test-secret';
  });

  it('rejects view-only users', async () => {
    const app = new Hono();
    app.route('/api/promotion', createPromotionRoutes({
      getChanges: async () => ({ mainSha: 'm', generatedAt: new Date().toISOString(), files: [] }),
      getStatus: async () => ({ path: 'a.md', oldPath: null, status: 'identical', additions: 0, deletions: 0, isBinary: false, mainSha: 'm' }),
      getDiff: async () => ({ path: 'a.md', status: 'identical', isBinary: false, mainSha: 'm', diff: '' }),
      createPromotionPr: async () => ({ branch: 'b', prNumber: 1, prUrl: 'https://example.com/pr/1', mainSha: 'm', autoMergeEnabled: true }),
    }));

    const response = await app.request('/api/promotion/changes', {
      headers: { 'X-Share-Token': viewToken() },
    });
    expect(response.status).toBe(403);
  });

  it('rejects non-share edit-purpose tokens', async () => {
    const addVideoToken = signShareToken({
      purpose: 'add-video',
      role: 'edit',
      folder: '00000000-0000-0000-0000-000000000000',
      expiry: Math.floor(Date.now() / 1000) + 3600,
    });
    const app = new Hono();
    app.route('/api/promotion', createPromotionRoutes({
      getChanges: async () => ({ mainSha: 'm', generatedAt: new Date().toISOString(), files: [] }),
      getStatus: async () => ({ path: 'a.md', oldPath: null, status: 'identical', additions: 0, deletions: 0, isBinary: false, mainSha: 'm' }),
      getDiff: async () => ({ path: 'a.md', status: 'identical', isBinary: false, mainSha: 'm', diff: '' }),
      createPromotionPr: async () => ({ branch: 'b', prNumber: 1, prUrl: 'https://example.com/pr/1', mainSha: 'm', autoMergeEnabled: true }),
    }));

    const response = await app.request('/api/promotion/changes', {
      headers: { 'X-Share-Token': addVideoToken },
    });
    expect(response.status).toBe(403);
  });

  it('returns changes for edit users', async () => {
    const app = new Hono();
    app.route('/api/promotion', createPromotionRoutes({
      getChanges: async () => ({ mainSha: 'm', generatedAt: '2026-06-27T00:00:00.000Z', files: [] }),
      getStatus: async () => ({ path: 'a.md', oldPath: null, status: 'identical', additions: 0, deletions: 0, isBinary: false, mainSha: 'm' }),
      getDiff: async () => ({ path: 'a.md', status: 'identical', isBinary: false, mainSha: 'm', diff: '' }),
      createPromotionPr: async () => ({ branch: 'b', prNumber: 1, prUrl: 'https://example.com/pr/1', mainSha: 'm', autoMergeEnabled: true }),
    }));

    const response = await app.request('/api/promotion/changes', {
      headers: { 'X-Share-Token': editToken() },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mainSha: 'm' });
  });

  it('passes selected paths to PR creation', async () => {
    const createPromotionPr = vi.fn(async () => ({
      branch: 'b',
      prNumber: 1,
      prUrl: 'https://example.com/pr/1',
      mainSha: 'm',
      autoMergeEnabled: true,
    }));
    const app = new Hono();
    app.route('/api/promotion', createPromotionRoutes({
      getChanges: async () => ({ mainSha: 'm', generatedAt: new Date().toISOString(), files: [] }),
      getStatus: async () => ({ path: 'a.md', oldPath: null, status: 'identical', additions: 0, deletions: 0, isBinary: false, mainSha: 'm' }),
      getDiff: async () => ({ path: 'a.md', status: 'identical', isBinary: false, mainSha: 'm', diff: '' }),
      createPromotionPr,
    }));

    const response = await app.request('/api/promotion/pr', {
      method: 'POST',
      headers: { 'X-Share-Token': editToken(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['Courses/Intro.md'] }),
    });
    expect(response.status).toBe(200);
    expect(createPromotionPr).toHaveBeenCalledWith({ paths: ['Courses/Intro.md'], title: undefined });
  });
});
```

- [ ] **Step 2: Run route tests to verify they fail**

Run:

```bash
cd lens-editor && npx vitest run server/promotion/routes.test.ts
```

Expected: fail because `routes.ts` does not exist.

- [ ] **Step 3: Implement promotion routes**

Create:

```typescript
// lens-editor/server/promotion/routes.ts
import { Hono } from 'hono';
import { verifyShareToken } from '../share-token.ts';
import { PromotionError, type PromotionPrResponse } from './types.ts';

export interface PromotionRouteService {
  getChanges(): Promise<unknown>;
  getStatus(path: string): Promise<unknown>;
  getDiff(path: string): Promise<unknown>;
  createPromotionPr(input: { paths: string[]; title?: string }): Promise<PromotionPrResponse>;
}

export function createPromotionRoutes(
  service: PromotionRouteService,
): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const token = c.req.header('X-Share-Token') || c.req.header('Authorization')?.replace(/^Bearer\s+/i, '');
    const payload = token ? verifyShareToken(token) : null;
    if (!payload) return c.json({ error: 'Invalid or expired share token' }, 401);
    if (payload.purpose !== 'share' || payload.role !== 'edit') return c.json({ error: 'Promotion requires edit share access' }, 403);
    await next();
  });

  app.get('/changes', async c => handle(c, () => service.getChanges()));

  app.get('/status', async c => {
    const filePath = c.req.query('path');
    if (!filePath) return c.json({ error: 'path query parameter required' }, 400);
    return handle(c, () => service.getStatus(filePath));
  });

  app.get('/diff', async c => {
    const filePath = c.req.query('path');
    if (!filePath) return c.json({ error: 'path query parameter required' }, 400);
    return handle(c, () => service.getDiff(filePath));
  });

  app.post('/pr', async c => handle(c, async () => {
    const body = await c.req.json() as { paths?: unknown; title?: unknown };
    if (!Array.isArray(body.paths)) {
      throw new PromotionError(400, 'paths are required', 'invalid_request');
    }
    return service.createPromotionPr({
      paths: body.paths.map(String),
      title: typeof body.title === 'string' ? body.title : undefined,
    });
  }));

  return app;
}

async function handle(c: any, fn: () => Promise<unknown>) {
  try {
    return c.json(await fn());
  } catch (error) {
    if (error instanceof PromotionError) {
      return c.json({ error: error.message, code: error.code }, error.status as 400);
    }
    console.error('[promotion] unexpected error', error);
    return c.json({ error: 'Promotion request failed' }, 500);
  }
}
```

- [ ] **Step 4: Mount routes in app**

Modify `lens-editor/server/app.ts`:

```typescript
import { loadPromotionConfig, promotionConfigReady } from './promotion/config.ts';
import { createGitPromotionService } from './promotion/git.ts';
import { createGitHubPromotionService } from './promotion/github.ts';
import { createPromotionRoutes } from './promotion/routes.ts';
import { validatePromotionPaths } from './promotion/path-validation.ts';
```

Inside `createApp`, before static serving:

```typescript
  const promotionConfig = loadPromotionConfig();
  if (!promotionConfig.enabled) {
    app.all('/api/promotion/*', c => c.json({ error: 'Promotion is disabled' }, 404));
  } else if (!promotionConfigReady(promotionConfig)) {
    app.all('/api/promotion/*', c => c.json({ error: 'Promotion is enabled but not fully configured' }, 503));
  } else {
    const gitPromotion = createGitPromotionService(promotionConfig);
    const githubPromotion = createGitHubPromotionService(promotionConfig);
    app.route('/api/promotion', createPromotionRoutes({
      getChanges: () => gitPromotion.getChanges(),
      getStatus: path => gitPromotion.getStatus(path),
      getDiff: path => gitPromotion.getDiff(path),
      createPromotionPr: async input => {
        const changes = await gitPromotion.getChanges();
        const paths = validatePromotionPaths(input.paths, changes.files);
        const branch = await gitPromotion.createPromotionBranch({ paths });
        return githubPromotion.createPullRequest({
          branch: branch.branch,
          mainSha: branch.mainSha,
          sourceStagingSha: branch.sourceStagingSha,
          paths,
          title: input.title,
        });
      },
    }));
  }
```

- [ ] **Step 5: Run server tests**

Run:

```bash
cd lens-editor && npx vitest run server/promotion/routes.test.ts server/app.test.ts
```

Expected: pass. If `server/app.test.ts` expects exact routes, update expected route behavior only for disabled promotion default.

- [ ] **Step 6: Add full workflow integration test**

Create `lens-editor/server/promotion/integration.test.ts` that:

1. Creates a temp bare Git remote with `main` and `staging`.
2. Starts a local `node:http` test server that records:
   - `POST /repos/Lens-Academy/lens-edu-relay/pulls`
   - `POST /graphql`
3. Builds real `gitPromotion` and `githubPromotion` services, with GitHub endpoints pointed at the local server.
4. Calls the same orchestration used by `/api/promotion/pr`.
5. Asserts the pushed promotion branch contains only the selected file.
6. Asserts the fake GitHub server received the PR body with the backend-recorded source staging commit and the auto-merge GraphQL mutation.

The test should use real Git commands and fake only GitHub network I/O. Do not mock the Git promotion service.

- [ ] **Step 7: Run workflow integration test**

Run:

```bash
cd lens-editor && npx vitest run server/promotion/integration.test.ts
```

Expected: pass.

- [ ] **Step 8: Record status**

Run:

```bash
jj st
jj describe -m "Add promotion API routes"
```

---

### Task 5: Browser Promotion API Wrapper

**Files:**
- Create: `lens-editor/src/lib/promotion-api.ts`
- Create: `lens-editor/src/lib/promotion-api.test.ts`

- [ ] **Step 1: Write failing API wrapper tests**

Create:

```typescript
// lens-editor/src/lib/promotion-api.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getPromotionChanges, createPromotionPr } from './promotion-api';

describe('promotion-api', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.setItem('lens-share-token', 'share');
  });

  it('adds share token header when fetching changes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      mainSha: 'm',
      generatedAt: '2026-06-27T00:00:00.000Z',
      files: [],
    }), { status: 200 }));
    await getPromotionChanges();
    expect(fetchMock).toHaveBeenCalledWith('/api/promotion/changes', expect.objectContaining({
      headers: expect.objectContaining({ 'X-Share-Token': 'share' }),
    }));
  });

  it('posts selected paths', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      branch: 'b',
      prNumber: 1,
      prUrl: 'https://example.com/pr/1',
      mainSha: 'm',
      autoMergeEnabled: true,
    }), { status: 200 }));
    await createPromotionPr({ paths: ['Courses/Intro.md'] });
    expect(fetchMock).toHaveBeenCalledWith('/api/promotion/pr', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ paths: ['Courses/Intro.md'] }),
    }));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd lens-editor && npx vitest run src/lib/promotion-api.test.ts
```

Expected: fail because `promotion-api.ts` does not exist.

- [ ] **Step 3: Implement wrapper**

Create:

```typescript
// lens-editor/src/lib/promotion-api.ts
import { relayHeaders } from './relay-api';

export type PromotionFileStatus = 'identical' | 'modified' | 'added' | 'deleted' | 'renamed';

export interface PromotionFileChange {
  path: string;
  oldPath: string | null;
  status: PromotionFileStatus;
  additions: number;
  deletions: number;
  isBinary: boolean;
}

export interface PromotionChangesResponse {
  mainSha: string;
  generatedAt: string;
  files: PromotionFileChange[];
}

export interface PromotionStatusResponse extends PromotionFileChange {
  mainSha: string;
}

export interface PromotionDiffResponse {
  path: string;
  mainSha: string;
  status: PromotionFileStatus;
  isBinary: boolean;
  beforeBlob?: { oid: string; size: number } | null;
  afterBlob?: { oid: string; size: number } | null;
  diff: string;
}

export interface PromotionPrResponse {
  branch: string;
  prNumber: number;
  prUrl: string;
  mainSha: string;
  autoMergeEnabled: boolean;
  warning?: string;
}

export async function getPromotionChanges(): Promise<PromotionChangesResponse> {
  return request('/api/promotion/changes');
}

export async function getPromotionStatus(path: string): Promise<PromotionStatusResponse> {
  return request(`/api/promotion/status?path=${encodeURIComponent(path)}`);
}

export async function getPromotionDiff(path: string): Promise<PromotionDiffResponse> {
  return request(`/api/promotion/diff?path=${encodeURIComponent(path)}`);
}

export async function createPromotionPr(input: { paths: string[]; title?: string }): Promise<PromotionPrResponse> {
  return request('/api/promotion/pr', {
    method: 'POST',
    headers: relayHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(input.title ? input : { paths: input.paths }),
  });
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: init?.headers ?? relayHeaders(),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || `Promotion request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}
```

- [ ] **Step 4: Run API wrapper tests**

Run:

```bash
cd lens-editor && npx vitest run src/lib/promotion-api.test.ts
```

Expected: pass.

- [ ] **Step 5: Record status**

Run:

```bash
jj st
jj describe -m "Add promotion browser API client"
```

---

### Task 6: Document Header Status And Single-File Promotion

**Files:**
- Create: `lens-editor/src/components/Promotion/PromotionStatus.tsx`
- Create: `lens-editor/src/components/Promotion/PromotionStatus.test.tsx`
- Create: `lens-editor/src/components/Promotion/PromoteFileDialog.tsx`
- Create: `lens-editor/src/components/Promotion/PromoteFileDialog.test.tsx`
- Modify: `lens-editor/src/components/Layout/EditorArea.tsx`

- [ ] **Step 1: Write failing UI tests**

Create tests that mock `promotion-api`:

```typescript
// lens-editor/src/components/Promotion/PromotionStatus.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PromotionStatus } from './PromotionStatus';

describe('PromotionStatus', () => {
  it('shows identical production state without action', () => {
    render(<PromotionStatus filePath="Courses/Intro.md" canPromote status={{
      path: 'Courses/Intro.md',
      oldPath: null,
      status: 'identical',
      additions: 0,
      deletions: 0,
      isBinary: false,
      mainSha: 'm',
    }} onRefresh={() => {}} />);
    expect(screen.getByText('Identical to production')).toBeTruthy();
  });

  it('offers this-file and multiple-files actions for modified files', async () => {
    const onPromoteFile = vi.fn();
    const onPromoteMultiple = vi.fn();
    render(<PromotionStatus filePath="Courses/Intro.md" canPromote status={{
      path: 'Courses/Intro.md',
      oldPath: null,
      status: 'modified',
      additions: 2,
      deletions: 1,
      isBinary: false,
      mainSha: 'm',
    }} onRefresh={() => {}} onPromoteFile={onPromoteFile} onPromoteMultiple={onPromoteMultiple} />);
    await userEvent.click(screen.getByText('Promote to production'));
    await userEvent.click(screen.getByText('This file'));
    expect(onPromoteFile).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd lens-editor && npx vitest run src/components/Promotion/PromotionStatus.test.tsx
```

Expected: fail because component does not exist.

- [ ] **Step 3: Implement `PromotionStatus`**

Create:

```typescript
// lens-editor/src/components/Promotion/PromotionStatus.tsx
import { useState } from 'react';
import type { PromotionStatusResponse } from '../../lib/promotion-api';

interface PromotionStatusProps {
  filePath: string;
  canPromote: boolean;
  status: PromotionStatusResponse | null;
  loading?: boolean;
  error?: string | null;
  onRefresh: () => void;
  onPromoteFile?: () => void;
  onPromoteMultiple?: () => void;
}

export function PromotionStatus({ canPromote, status, loading, error, onRefresh, onPromoteFile, onPromoteMultiple }: PromotionStatusProps) {
  const [open, setOpen] = useState(false);
  const label = loading ? 'Checking production...' : error ? 'Unable to check production' : labelForStatus(status?.status ?? 'identical');
  const actionable = canPromote && status && status.status !== 'identical' && !loading && !error;

  if (!actionable) {
    return (
      <button type="button" onClick={onRefresh} title="Refresh production status" className="text-xs text-gray-500 hover:text-gray-700">
        {label}
      </button>
    );
  }

  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen(value => !value)} className="text-xs font-medium text-amber-700 hover:text-amber-800">
        Promote to production
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-2 w-44 rounded border border-gray-200 bg-white py-1 text-sm shadow-lg">
          <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-gray-50" onClick={() => { setOpen(false); onPromoteFile?.(); }}>
            This file
          </button>
          <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-gray-50" onClick={() => { setOpen(false); onPromoteMultiple?.(); }}>
            Multiple files
          </button>
        </div>
      )}
    </div>
  );
}

function labelForStatus(status: PromotionStatusResponse['status']): string {
  switch (status) {
    case 'added': return 'Not in production yet';
    case 'deleted': return 'Deleted in staging';
    case 'modified':
    case 'renamed': return 'Different from production';
    case 'identical': return 'Identical to production';
  }
}
```

- [ ] **Step 4: Implement single-file dialog**

Create `PromoteFileDialog.tsx` with props `{ open, filePath, status, onClose, onPromoted }`. It should show the file path, production status, and additions/deletions. It should call `getPromotionDiff(filePath)` when the user clicks `View diff`, call `createPromotionPr({ paths: [filePath] })` when confirmed, and render the returned PR link plus branch name.

Use this core submit handler:

```typescript
async function handlePromote() {
  if (!status) return;
  setSubmitting(true);
  setError(null);
  try {
    const result = await createPromotionPr({ paths: [filePath] });
    setResult(result);
    onPromoted?.();
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Promotion failed');
  } finally {
    setSubmitting(false);
  }
}
```

- [ ] **Step 5: Wire into `EditorArea.tsx`**

In `EditorArea`, derive `currentFilePath` already exists. Add imports:

```typescript
import { useNavigate } from 'react-router-dom';
import { getPromotionStatus, type PromotionStatusResponse } from '../../lib/promotion-api';
import { PromotionStatus } from '../Promotion/PromotionStatus';
import { PromoteFileDialog } from '../Promotion/PromoteFileDialog';
```

Inside the component, add:

```typescript
const navigate = useNavigate();
```

Add state:

```typescript
const [promotionStatus, setPromotionStatus] = useState<PromotionStatusResponse | null>(null);
const [promotionLoading, setPromotionLoading] = useState(false);
const [promotionError, setPromotionError] = useState<string | null>(null);
const [promoteDialogOpen, setPromoteDialogOpen] = useState(false);
```

Add a reusable refresh callback and effect:

```typescript
const refreshPromotionStatus = useCallback(() => {
  if (!currentFilePath || !canEdit) {
    setPromotionStatus(null);
    setPromotionError(null);
    setPromotionLoading(false);
    return () => {};
  }
  let cancelled = false;
  setPromotionLoading(true);
  setPromotionError(null);
  getPromotionStatus(currentFilePath)
    .then(result => { if (!cancelled) setPromotionStatus(result); })
    .catch(error => { if (!cancelled) setPromotionError(error instanceof Error ? error.message : 'Unable to check production'); })
    .finally(() => { if (!cancelled) setPromotionLoading(false); });
  return () => { cancelled = true; };
}, [currentFilePath, canEdit]);

useEffect(() => refreshPromotionStatus(), [refreshPromotionStatus]);
```

Inside the header controls portal, render `PromotionStatus` before `PresencePanel`:

```tsx
{currentFilePath && (
  <PromotionStatus
    filePath={currentFilePath}
    canPromote={canEdit}
    status={promotionStatus}
    loading={promotionLoading}
    error={promotionError}
    onRefresh={() => { refreshPromotionStatus(); }}
    onPromoteFile={() => setPromoteDialogOpen(true)}
    onPromoteMultiple={() => navigate(`/promote?path=${encodeURIComponent(currentFilePath)}`)}
  />
)}
```

Render `PromoteFileDialog` near the end of `EditorArea` so the single-file flow is reachable:

```tsx
{currentFilePath && (
  <PromoteFileDialog
    open={promoteDialogOpen}
    filePath={currentFilePath}
    status={promotionStatus}
    onClose={() => setPromoteDialogOpen(false)}
    onPromoted={() => { refreshPromotionStatus(); }}
  />
)}
```

- [ ] **Step 6: Run focused UI tests**

Run:

```bash
cd lens-editor && npx vitest run src/components/Promotion/PromotionStatus.test.tsx src/components/Promotion/PromoteFileDialog.test.tsx src/components/Layout/EditorArea.test.tsx
```

Expected: pass. Update existing `EditorArea` tests only for the new status control.

- [ ] **Step 7: Record status**

Run:

```bash
jj st
jj describe -m "Add document production promotion controls"
```

---

### Task 7: Promotion Overview Page And Diff Viewer

**Files:**
- Create: `lens-editor/src/components/Promotion/DiffViewer.tsx`
- Create: `lens-editor/src/components/Promotion/DiffViewer.test.tsx`
- Create: `lens-editor/src/components/Promotion/PromotionPage.tsx`
- Create: `lens-editor/src/components/Promotion/PromotionPage.test.tsx`
- Modify: `lens-editor/src/App.tsx`

- [ ] **Step 1: Write failing DiffViewer tests**

Create:

```typescript
// lens-editor/src/components/Promotion/DiffViewer.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DiffViewer } from './DiffViewer';

describe('DiffViewer', () => {
  it('renders added and removed lines from a unified diff', () => {
    render(<DiffViewer diff={'@@ -1 +1 @@\n-old\n+new\n context'} />);
    expect(screen.getByText('-old')).toBeTruthy();
    expect(screen.getByText('+new')).toBeTruthy();
    expect(screen.getByText('@@ -1 +1 @@')).toBeTruthy();
  });

  it('renders empty diff message', () => {
    render(<DiffViewer diff="" />);
    expect(screen.getByText('No text diff available.')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Implement DiffViewer**

Create:

```typescript
// lens-editor/src/components/Promotion/DiffViewer.tsx
export function DiffViewer({
  diff,
  isBinary = false,
  beforeBlob = null,
  afterBlob = null,
}: {
  diff: string;
  isBinary?: boolean;
  beforeBlob?: { oid: string; size: number } | null;
  afterBlob?: { oid: string; size: number } | null;
}) {
  if (isBinary) {
    return (
      <div className="rounded border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600">
        <div>Binary file changed.</div>
        <div>Before: {beforeBlob ? `${beforeBlob.oid.slice(0, 8)} (${beforeBlob.size} bytes)` : 'not present'}</div>
        <div>After: {afterBlob ? `${afterBlob.oid.slice(0, 8)} (${afterBlob.size} bytes)` : 'not present'}</div>
      </div>
    );
  }
  if (!diff.trim()) {
    return <div className="rounded border border-gray-200 bg-gray-50 p-3 text-sm text-gray-500">No text diff available.</div>;
  }
  return (
    <pre className="max-h-[480px] overflow-auto rounded border border-gray-200 bg-white p-3 text-xs leading-5">
      {diff.split('\n').map((line, index) => (
        <div key={index} className={classForLine(line)}>
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}

function classForLine(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-gray-500';
  if (line.startsWith('@@')) return 'bg-blue-50 text-blue-800';
  if (line.startsWith('+')) return 'bg-green-50 text-green-800';
  if (line.startsWith('-')) return 'bg-red-50 text-red-800';
  return 'text-gray-700';
}
```

- [ ] **Step 3: Write failing PromotionPage tests**

Create:

```typescript
// lens-editor/src/components/Promotion/PromotionPage.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { PromotionPage } from './PromotionPage';
import * as promotionApi from '../../lib/promotion-api';

vi.mock('../../lib/promotion-api', () => ({
  getPromotionChanges: vi.fn(async () => ({
    mainSha: 'm',
    generatedAt: '2026-06-27T00:00:00.000Z',
    files: [
      { path: 'Courses/Intro.md', oldPath: null, status: 'modified', additions: 2, deletions: 1, isBinary: false },
      { path: 'Courses/New.md', oldPath: null, status: 'added', additions: 3, deletions: 0, isBinary: false },
    ],
  })),
  getPromotionDiff: vi.fn(async () => ({
    path: 'Courses/Intro.md',
    mainSha: 'm',
    status: 'modified',
    isBinary: false,
    diff: '@@ -1 +1 @@\n-old\n+new',
  })),
  createPromotionPr: vi.fn(async () => ({
    branch: 'promote/lens-editor/x',
    prNumber: 42,
    prUrl: 'https://github.com/Lens-Academy/lens-edu-relay/pull/42',
    mainSha: 'm',
    autoMergeEnabled: true,
  })),
}));

describe('PromotionPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('preselects path from query string', async () => {
    render(<MemoryRouter initialEntries={['/promote?path=Courses%2FIntro.md']}><PromotionPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Courses/Intro.md')).toBeTruthy());
    const checkbox = screen.getByLabelText('Select Courses/Intro.md') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it('creates promotion PR for selected files', async () => {
    render(<MemoryRouter initialEntries={['/promote?path=Courses%2FIntro.md']}><PromotionPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Courses/Intro.md')).toBeTruthy());
    await userEvent.click(screen.getByText('Create promotion PR'));
    expect(promotionApi.createPromotionPr).toHaveBeenCalledWith({ paths: ['Courses/Intro.md'] });
    expect(await screen.findByText('Pull request created')).toBeTruthy();
    expect(screen.getByText('https://github.com/Lens-Academy/lens-edu-relay/pull/42')).toBeTruthy();
  });

  it('loads a diff for the current staging branch', async () => {
    render(<MemoryRouter initialEntries={['/promote?path=Courses%2FIntro.md']}><PromotionPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Courses/Intro.md')).toBeTruthy());
    await userEvent.click(screen.getByText('View diff'));
    expect(await screen.findByText('+new')).toBeTruthy();
  });
});
```

- [ ] **Step 4: Implement PromotionPage**

Create `PromotionPage.tsx` with this behavior:

```typescript
// lens-editor/src/components/Promotion/PromotionPage.tsx
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useNavigation } from '../../contexts/NavigationContext';
import { createPromotionPr, getPromotionChanges, getPromotionDiff, type PromotionChangesResponse, type PromotionDiffResponse } from '../../lib/promotion-api';
import { urlForDoc } from '../../lib/url-utils';
import { RELAY_ID } from '../../lib/constants';
import { DiffViewer } from './DiffViewer';

export function PromotionPage() {
  const [searchParams] = useSearchParams();
  const { metadata } = useNavigation();
  const initialPath = searchParams.get('path');
  const [changes, setChanges] = useState<PromotionChangesResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialPath ? [initialPath] : []));
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ prUrl: string; autoMergeEnabled: boolean; warning?: string } | null>(null);
  const [diff, setDiff] = useState<PromotionDiffResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [diffLoading, setDiffLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function loadChanges() {
    setLoading(true);
    setError(null);
    try {
      setChanges(await getPromotionChanges());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load promotion changes');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadChanges(); }, []);

  const files = useMemo(() => {
    const all = changes?.files ?? [];
    return query ? all.filter(file => file.path.toLowerCase().includes(query.toLowerCase())) : all;
  }, [changes, query]);

  async function submit() {
    if (!changes || selected.size === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const pr = await createPromotionPr({ paths: [...selected] });
      setResult({ prUrl: pr.prUrl, autoMergeEnabled: pr.autoMergeEnabled, warning: pr.warning });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create promotion PR');
    } finally {
      setSubmitting(false);
    }
  }

  async function loadDiff(filePath: string) {
    if (!changes) return;
    setDiffLoading(true);
    setError(null);
    try {
      setDiff(await getPromotionDiff(filePath));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load diff');
    } finally {
      setDiffLoading(false);
    }
  }

  if (loading) return <main className="p-6 text-sm text-gray-500">Loading production differences...</main>;

  return (
    <main className="h-full overflow-auto bg-white p-6">
      <div className="mx-auto max-w-5xl">
        <div className="mb-5 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Promote to production</h1>
            {changes && <p className="text-sm text-gray-500">{selected.size} selected from latest staging</p>}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => { void loadChanges(); }} className="rounded border border-gray-300 px-3 py-2 text-sm text-gray-700">
              Refresh
            </button>
            <button type="button" disabled={selected.size === 0 || submitting} onClick={submit} className="rounded bg-gray-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-40">
              {submitting ? 'Creating PR...' : 'Create promotion PR'}
            </button>
          </div>
        </div>

        {error && <div className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        {result && (
          <div className="mb-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-800">
            <div className="font-medium">Pull request created</div>
            <a className="underline" href={result.prUrl} target="_blank" rel="noreferrer">{result.prUrl}</a>
            {!result.autoMergeEnabled && <div className="mt-1 text-amber-800">{result.warning || 'Auto-merge was not enabled.'}</div>}
          </div>
        )}

        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter files" className="mb-3 w-full rounded border border-gray-300 px-3 py-2 text-sm" />

        <div className="overflow-hidden rounded border border-gray-200">
          {files.map(file => (
            <label key={file.path} className="flex items-center gap-3 border-b border-gray-100 px-3 py-2 text-sm last:border-b-0">
              <input
                aria-label={`Select ${file.path}`}
                type="checkbox"
                checked={selected.has(file.path)}
                onChange={event => {
                  setSelected(previous => {
                    const next = new Set(previous);
                    if (event.target.checked) next.add(file.path);
                    else next.delete(file.path);
                    return next;
                  });
                }}
              />
              <span className="min-w-0 flex-1 truncate">{file.path}</span>
              <span className="text-gray-500">{file.status}</span>
              <span className="w-20 text-right text-gray-500">+{file.additions} -{file.deletions}</span>
              {metadata[file.path]?.id && (
                <Link className="text-gray-700 underline" to={urlForDoc(`${RELAY_ID}-${metadata[file.path].id}`, metadata)}>
                  Open in editor
                </Link>
              )}
              <button type="button" className="text-gray-700 underline" onClick={(event) => { event.preventDefault(); void loadDiff(file.path); }}>
                View diff
              </button>
            </label>
          ))}
          {files.length === 0 && <div className="p-4 text-sm text-gray-500">No files differ between staging and production.</div>}
        </div>
        {diffLoading && <div className="mt-4 text-sm text-gray-500">Loading diff...</div>}
        {diff && (
          <section className="mt-4">
            <h2 className="mb-2 text-sm font-medium text-gray-900">{diff.path}</h2>
            <DiffViewer diff={diff.diff} isBinary={diff.isBinary} beforeBlob={diff.beforeBlob} afterBlob={diff.afterBlob} />
          </section>
        )}
      </div>
    </main>
  );
}
```

- [ ] **Step 5: Add route in `App.tsx`**

Import:

```typescript
import { PromotionPage } from './components/Promotion/PromotionPage';
```

Add before `/:docUuid/*` route:

```tsx
<Route path="/promote" element={role === 'edit' ? <PromotionPage /> : <DefaultLanding />} />
```

- [ ] **Step 6: Run page tests**

Run:

```bash
cd lens-editor && npx vitest run src/components/Promotion/DiffViewer.test.tsx src/components/Promotion/PromotionPage.test.tsx
```

Expected: pass.

- [ ] **Step 7: Record status**

Run:

```bash
jj st
jj describe -m "Add promotion overview page"
```

---

### Task 8: End-To-End Verification And Production Notes

**Files:**
- Modify: `lens-editor/AGENTS.md` if local development notes need promotion config documentation
- Modify: `docs/server-ops.md` if production deployment env vars need to be documented

- [ ] **Step 1: Run full automated checks**

Run:

```bash
cd lens-editor && npm run test:run
cd lens-editor && npm run build
```

Expected: all tests pass and production build succeeds.

- [ ] **Step 2: Run local production-server smoke test**

Build and start the Hono production server so `/api/promotion/*` is mounted:

```bash
cd lens-editor && npm run build
cd lens-editor && PORT=9104 npm run start:prod
```

Open:

```txt
http://localhost:9104
http://dev.vps:9104
```

Expected: existing editor loads. Promotion controls are hidden or show unavailable state unless promotion env vars are configured. `GET /api/promotion/changes` returns JSON `404` when promotion is disabled and JSON `503` when `PROMOTION_ENABLED=true` but required config is incomplete.

- [ ] **Step 3: Run promotion dry run against a temporary remote**

Use a temporary local bare repo and set:

```bash
export PROMOTION_ENABLED=true
export PROMOTION_REPO_URL=/tmp/lens-promotion-remote.git
export PROMOTION_REPO_DIR=/tmp/lens-promotion-scratch
export PROMOTION_MAIN_BRANCH=main
export PROMOTION_STAGING_BRANCH=staging
export PROMOTION_BRANCH_PREFIX=promote/lens-editor
export PROMOTION_GITHUB_OWNER=Lens-Academy
export PROMOTION_GITHUB_REPO=lens-edu-relay
export GITHUB_TOKEN=fake-token-for-local-route-tests
```

Expected: `/api/promotion/changes` lists file diffs from the temp repo. Do not call the real PR endpoint with fake GitHub config.

- [ ] **Step 4: Document production configuration**

Add the production env var list from the spec to `docs/server-ops.md`, including:

```txt
PROMOTION_ENABLED=true
PROMOTION_REPO_URL=git@github.com:Lens-Academy/lens-edu-relay.git
PROMOTION_REPO_DIR=/data/lens-editor/promotion-repos/lens-edu-relay
PROMOTION_MAIN_BRANCH=main
PROMOTION_STAGING_BRANCH=staging
PROMOTION_BRANCH_PREFIX=promote/lens-editor
PROMOTION_GITHUB_OWNER=Lens-Academy
PROMOTION_GITHUB_REPO=lens-edu-relay
GITHUB_TOKEN=github_pat_with_pull_request_and_automerge_permissions
```

Also document that this feature must not push to `staging`; it only pushes branches under `PROMOTION_BRANCH_PREFIX`.

Add a rollout gate: before setting `PROMOTION_ENABLED=true` in production, confirm whether short-lived promotion branches may be pushed to `Lens-Academy/lens-edu-relay`. If same-repo promotion branches are not allowed, configure the GitHub App/fork push target first and update `PROMOTION_REPO_URL` and PR `head` handling accordingly.

Add a separate relay-git-sync isolation gate:

- `PROMOTION_REPO_DIR` must not be inside relay-git-sync's data directory.
- The promotion service must not mount or reuse relay-git-sync's working checkout.
- The promotion service must not reuse relay-git-sync's SSH private key.
- The promotion service must not restart, signal, inspect, or modify the `relay-git-sync` container.
- The implementation must not run `scripts/start-git-sync.sh` or any Docker command targeting `relay-git-sync`.
- The only Git writes allowed from promotion are pushes of branches matching `PROMOTION_BRANCH_PREFIX`; never `staging`.

Before production rollout, verify this with:

```bash
docker inspect relay-git-sync --format '{{json .Mounts}}'
test "$(realpath "$PROMOTION_REPO_DIR")" != "/root/relay-git-sync-data"
```

Then manually confirm `PROMOTION_REPO_DIR` is a separate persistent directory owned by the Lens Editor service, not by relay-git-sync.

- [ ] **Step 5: Final status**

Run:

```bash
jj st
```

Expected: only intended implementation and documentation changes remain.

---

## Plan Self-Review Checklist

- Spec coverage:
  - Document-page production status is covered in Task 6.
  - Single-file promotion is covered in Task 6.
  - Multi-file overview is covered in Task 7.
  - Backend diff, status, and PR APIs are covered in Tasks 2 through 4.
  - Auto-merge is covered in Task 3.
  - Latest-staging promotion without client-supplied SHAs is covered in Tasks 2, 4, and 7.
  - Path safety is covered in Task 1 and enforced in Task 4.
  - Production documentation is covered in Task 8.
- Placeholder scan: no task relies on unspecified behavior; each code-bearing step includes concrete names, signatures, and commands.
- Type consistency: `PromotionFileChange`, `PromotionChangesResponse`, `PromotionStatusResponse`, `PromotionDiffResponse`, and `PromotionPrResponse` names match across server and client tasks.
