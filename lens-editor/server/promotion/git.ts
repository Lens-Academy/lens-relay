import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  isPromotionPathExcluded,
  validatePromotionPaths,
  validatePromotableRepoPath,
} from './path-validation.ts';
import {
  PromotionError,
  type PromotionChangesResponse,
  type PromotionConfig,
  type PromotionDiffResponse,
  type PromotionFileChange,
  type PromotionFileStatus,
  type PromotionPrRequest,
  type PromotionStatusResponse,
} from './types.ts';

const GIT_TIMEOUT_MS = 30_000;
const GIT_KILL_AFTER_TIMEOUT_MS = 1_000;
const PROMOTION_REPO_OWNER_KEY = 'lens-editor.promotionRepoOwner';
const PRODUCTION_REMOTE = 'production';
const STAGING_REMOTE = 'staging';
const gitQueuesByRepoDir = new Map<string, Promise<void>>();

interface BranchHeads {
  mainSha: string;
  stagingSha: string;
}

interface GitPromotionService {
  getChanges(): Promise<PromotionChangesResponse>;
  getStatus(path: string): Promise<PromotionStatusResponse>;
  getDiff(path: string): Promise<PromotionDiffResponse>;
  createPromotionBranch(
    request: Pick<PromotionPrRequest, 'paths'>,
  ): Promise<{ branch: string; mainSha: string; sourceStagingSha: string }>;
}

export function spawnFile(command: string, args: string[], options: { cwd: string }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'Never',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;

    function rejectOnce(error: Error): void {
      if (settled) return;
      settled = true;
      reject(error);
    }

    function resolveOnce(value: { stdout: string; stderr: string }): void {
      if (settled) return;
      settled = true;
      resolve(value);
    }

    const timeout = setTimeout(() => {
      rejectOnce(new PromotionError(504, `Command timed out: ${command}`, 'git_timeout'));
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, gitKillAfterTimeoutMs());
    }, gitTimeoutMs());

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', error => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      rejectOnce(error);
    });
    child.on('close', code => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (settled) return;
      if (code !== 0) {
        rejectOnce(new PromotionError(500, stderr.trim() || `Command failed: ${command} ${args.join(' ')}`, 'git_failed'));
        return;
      }
      resolveOnce({ stdout, stderr });
    });
  });
}

export function createGitPromotionService(config: PromotionConfig): GitPromotionService {
  async function withGitLock<T>(operation: () => Promise<T>): Promise<T> {
    return withRepoGitLock(config.repoDir, operation);
  }

  async function withRepoGitLock<T>(repoDir: string, operation: () => Promise<T>): Promise<T> {
    const key = repoDir ? path.resolve(repoDir) : '<unconfigured-promotion-repo>';
    const previous = gitQueuesByRepoDir.get(key) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    const next = run.then(
      () => undefined,
      () => undefined,
    );
    gitQueuesByRepoDir.set(key, next);

    try {
      return await run;
    } finally {
      if (gitQueuesByRepoDir.get(key) === next) {
        gitQueuesByRepoDir.delete(key);
      }
    }
  }

  async function git(args: string[]): Promise<string> {
    const { stdout } = await spawnFile('git', args, { cwd: config.repoDir });
    return stdout.trimEnd();
  }

  async function ensureRepo(): Promise<void> {
    if (!config.repoUrl || !config.repoDir) {
      throw new PromotionError(503, 'Promotion Git repository is not configured', 'promotion_not_configured');
    }

    const gitDir = path.join(config.repoDir, '.git');
    try {
      const stat = await fs.stat(gitDir);
      if (!stat.isDirectory()) {
        throw new PromotionError(500, 'Promotion repository is not a Git checkout', 'invalid_repo');
      }
      await verifyExistingCheckoutRemoteSafety();
      await verifyPromotionRepoOwner();
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      await fs.mkdir(path.dirname(config.repoDir), { recursive: true });
      await spawnFile('git', ['clone', '-o', PRODUCTION_REMOTE, config.productionRepoUrl, config.repoDir], {
        cwd: path.dirname(config.repoDir),
      });
      await markPromotionRepoOwner();
    }

    await ensureConfiguredRemote(PRODUCTION_REMOTE, config.productionRepoUrl);
    await ensureConfiguredRemote(STAGING_REMOTE, config.stagingRepoUrl);
    await git(['config', 'user.email', 'lens-editor-promotion@example.invalid']);
    await git(['config', 'user.name', 'Lens Editor Promotion']);
  }

  async function verifyExistingCheckoutRemoteSafety(): Promise<void> {
    try {
      const remoteUrl = await git(['config', '--get', `remote.${PRODUCTION_REMOTE}.url`]);
      if (remoteUrl !== config.productionRepoUrl) {
        throw new PromotionError(
          500,
          `Promotion repository ${PRODUCTION_REMOTE} remote does not match configured repository: ${remoteUrl}`,
          'invalid_repo_origin',
        );
      }
    } catch (error) {
      if (error instanceof PromotionError && error.code === 'invalid_repo_origin') throw error;
      await verifyLegacyOriginIfPresent(config.productionRepoUrl);
    }
  }

  async function ensureConfiguredRemote(name: string, url: string): Promise<void> {
    try {
      const remoteUrl = await git(['config', '--get', `remote.${name}.url`]);
      if (remoteUrl !== url) {
        throw new PromotionError(
          500,
          `Promotion repository ${name} remote does not match configured repository: ${remoteUrl}`,
          'invalid_repo_origin',
        );
      }
    } catch (error) {
      if (error instanceof PromotionError && error.code === 'invalid_repo_origin') throw error;
      if (name === PRODUCTION_REMOTE) {
        await verifyLegacyOriginIfPresent(url);
      }
      await git(['remote', 'add', name, url]);
    }
  }

  async function verifyLegacyOriginIfPresent(url: string): Promise<void> {
    try {
      const originUrl = await git(['config', '--get', 'remote.origin.url']);
      if (originUrl !== url) {
        throw new PromotionError(
          500,
          `Promotion repository origin does not match configured repository: ${originUrl}`,
          'invalid_repo_origin',
        );
      }
    } catch (error) {
      if (error instanceof PromotionError && error.code === 'invalid_repo_origin') throw error;
      // No origin remote is fine for checkouts cloned with the explicit production remote.
    }
  }

  async function markPromotionRepoOwner(): Promise<void> {
    await git(['config', PROMOTION_REPO_OWNER_KEY, 'true']);
  }

  async function verifyPromotionRepoOwner(): Promise<void> {
    try {
      const owner = await git(['config', '--get', PROMOTION_REPO_OWNER_KEY]);
      if (owner === 'true') return;
    } catch {
      // Fall through to a promotion-specific error so unsafe existing checkouts fail closed.
    }

    throw new PromotionError(
      500,
      'Promotion repository is not owned by the Lens Editor promotion service',
      'invalid_repo_owner',
    );
  }

  async function fetchBranches(): Promise<BranchHeads> {
    await git([
      'fetch',
      PRODUCTION_REMOTE,
      `+refs/heads/${config.mainBranch}:refs/remotes/${PRODUCTION_REMOTE}/${config.mainBranch}`,
      '--prune',
    ]);
    await git([
      'fetch',
      STAGING_REMOTE,
      `+refs/heads/${config.stagingBranch}:refs/remotes/${STAGING_REMOTE}/${config.stagingBranch}`,
      '--prune',
    ]);
    const mainSha = await git(['rev-parse', productionRef()]);
    const stagingSha = await git(['rev-parse', stagingRef()]);
    return { mainSha, stagingSha };
  }

  async function getChangedFiles(): Promise<PromotionFileChange[]> {
    const nameStatus = await git([
      'diff',
      '--name-status',
      '--find-renames',
      '-z',
      `${productionRef()}..${stagingRef()}`,
    ]);
    const changes = parseNameStatus(nameStatus);

    const promotableChanges = changes.filter(change => (
      !isPromotionPathExcluded(change.path) && !(change.oldPath && isPromotionPathExcluded(change.oldPath))
    ));

    return Promise.all(
      promotableChanges.map(async change => {
        const stats = await getChangeStats(change);
        return { ...change, ...stats };
      }),
    );
  }

  async function getChangeStats(change: Pick<PromotionFileChange, 'path' | 'oldPath'>): Promise<{
    additions: number;
    deletions: number;
    isBinary: boolean;
  }> {
    const pathspecs = change.oldPath ? [literalPathspec(change.oldPath), literalPathspec(change.path)] : [literalPathspec(change.path)];
    const output = await git([
      'diff',
      '--numstat',
      `${productionRef()}..${stagingRef()}`,
      '--',
      ...pathspecs,
    ]);
    const firstLine = output.split('\n').find(line => line.trim() !== '');
    if (!firstLine) return { additions: 0, deletions: 0, isBinary: false };

    const [rawAdditions, rawDeletions] = firstLine.split('\t');
    const isBinary = rawAdditions === '-' || rawDeletions === '-';
    return {
      additions: isBinary ? 0 : Number.parseInt(rawAdditions, 10),
      deletions: isBinary ? 0 : Number.parseInt(rawDeletions, 10),
      isBinary,
    };
  }

  async function listCurrentChangesNoRenames(): Promise<string[]> {
    const output = await git(['diff', '--cached', '--name-only', '--no-renames', '-z', productionRef()]);
    return splitNul(output);
  }

  async function getBlob(rev: string, filePath: string): Promise<{ oid: string; size: number } | null> {
    const output = await git(['ls-tree', '-z', '-l', rev, '--', literalPathspec(filePath)]);
    const entry = splitNul(output)[0];
    if (!entry) return null;

    const match = entry.match(/^\d+\s+blob\s+([0-9a-f]{40,64})\s+(\d+|-)\t/);
    if (!match || match[2] === '-') return null;
    return { oid: match[1], size: Number.parseInt(match[2], 10) };
  }

  async function getDiffForChange(pathValue: string, change: PromotionFileChange | null): Promise<string> {
    const pathspecs = change?.oldPath
      ? [literalPathspec(change.oldPath), literalPathspec(change.path)]
      : [literalPathspec(change?.path ?? pathValue)];
    return git([
      'diff',
      '--find-renames',
      `${productionRef()}..${stagingRef()}`,
      '--',
      ...pathspecs,
    ]);
  }

  function findChangeForPath(changes: PromotionFileChange[], filePath: string): PromotionFileChange | null {
    return changes.find(change => change.path === filePath || change.oldPath === filePath) ?? null;
  }

  function expandSelectedChanges(changes: PromotionFileChange[], selectedPaths: string[]): {
    selectedChanges: PromotionFileChange[];
    allowedPaths: Set<string>;
  } {
    const selected = new Map<string, PromotionFileChange>();
    const selectedPathSet = new Set(selectedPaths);

    for (const change of changes) {
      if (selectedPathSet.has(change.path) || (change.oldPath && selectedPathSet.has(change.oldPath))) {
        selected.set(`${change.oldPath ?? ''}\0${change.path}`, change);
      }
    }

    const allowedPaths = new Set<string>();
    for (const change of selected.values()) {
      allowedPaths.add(change.path);
      if (change.oldPath) allowedPaths.add(change.oldPath);
    }

    return { selectedChanges: [...selected.values()], allowedPaths };
  }

  return {
    getChanges() {
      return withGitLock(async () => {
        await ensureRepo();
        const heads = await fetchBranches();
        const files = await getChangedFiles();
        return {
          mainSha: heads.mainSha,
          generatedAt: new Date().toISOString(),
          files,
        };
      });
    },

    getStatus(pathValue: string) {
      return withGitLock(async () => {
        const filePath = validatePromotableRepoPath(pathValue);
        await ensureRepo();
        const heads = await fetchBranches();
        const changes = await getChangedFiles();
        const change = findChangeForPath(changes, filePath);
        if (!change) {
          return {
            path: filePath,
            oldPath: null,
            status: 'identical',
            additions: 0,
            deletions: 0,
            isBinary: false,
            mainSha: heads.mainSha,
          };
        }
        return { ...change, mainSha: heads.mainSha };
      });
    },

    getDiff(pathValue: string) {
      return withGitLock(async () => {
        const filePath = validatePromotableRepoPath(pathValue);
        await ensureRepo();
        const heads = await fetchBranches();
        const changes = await getChangedFiles();
        const change = findChangeForPath(changes, filePath);
        const beforePath = change?.oldPath ?? filePath;
        const afterPath = change?.path ?? filePath;

        return {
          path: change?.path ?? filePath,
          mainSha: heads.mainSha,
          status: change?.status ?? 'identical',
          isBinary: change?.isBinary ?? false,
          beforeBlob: await getBlob(productionRef(), beforePath),
          afterBlob: await getBlob(stagingRef(), afterPath),
          diff: await getDiffForChange(filePath, change),
        };
      });
    },

    createPromotionBranch(request: Pick<PromotionPrRequest, 'paths'>) {
      return withGitLock(async () => {
        await ensureRepo();
        const heads = await fetchBranches();
        const changes = await getChangedFiles();
        const requestedPaths = validateRequestedPathInputs(request.paths);
        if (changes.length === 0) {
          throw new PromotionError(409, 'Selected files do not differ from production', 'nothing_to_promote');
        }
        const selectedPaths = validatePromotionPaths(requestedPaths, changes);
        const { selectedChanges, allowedPaths } = expandSelectedChanges(changes, selectedPaths);
        const branch = createBranchName(config.branchPrefix);

        await git(['reset', '--hard']);
        await git(['clean', '-fd']);
        await git(['switch', '-C', branch, productionRef()]);
        await git(['reset', '--hard', productionRef()]);
        await git(['clean', '-fd']);

        for (const change of selectedChanges) {
          if (change.oldPath) {
            await git(['rm', '-f', '--ignore-unmatch', '--', literalPathspec(change.oldPath)]);
          }
          if (change.status === 'deleted') {
            await git(['rm', '-f', '--ignore-unmatch', '--', literalPathspec(change.path)]);
          } else {
            await git([
              'restore',
              '--source',
              stagingRef(),
              '--worktree',
              '--staged',
              '--',
              literalPathspec(change.path),
            ]);
          }
        }

        const changedPaths = await listCurrentChangesNoRenames();
        if (changedPaths.length === 0) {
          throw new PromotionError(409, 'Selected files do not differ from production', 'nothing_to_promote');
        }
        for (const changedPath of changedPaths) {
          if (!allowedPaths.has(changedPath)) {
            throw new PromotionError(500, `Promotion changed an unselected path: ${changedPath}`, 'unselected_path_changed');
          }
        }

        await git([
          'commit',
          '-m',
          'Promote selected course files',
          '-m',
          `Source staging commit: ${heads.stagingSha}`,
        ]);
        await git(['push', PRODUCTION_REMOTE, `refs/heads/${branch}:refs/heads/${branch}`]);

        return {
          branch,
          mainSha: heads.mainSha,
          sourceStagingSha: heads.stagingSha,
        };
      });
    },
  };

  function productionRef(): string {
    return `refs/remotes/${PRODUCTION_REMOTE}/${config.mainBranch}`;
  }

  function stagingRef(): string {
    return `refs/remotes/${STAGING_REMOTE}/${config.stagingBranch}`;
  }
}

function parseNameStatus(output: string): PromotionFileChange[] {
  const tokens = splitNul(output);
  const changes: PromotionFileChange[] = [];

  for (let index = 0; index < tokens.length; ) {
    const statusToken = tokens[index++];
    const statusCode = statusToken[0];

    if (statusCode === 'R') {
      const oldPath = tokens[index++];
      const newPath = tokens[index++];
      changes.push({
        path: newPath,
        oldPath,
        status: 'renamed',
        additions: 0,
        deletions: 0,
        isBinary: false,
      });
      continue;
    }

    const filePath = tokens[index++];
    changes.push({
      path: filePath,
      oldPath: null,
      status: mapStatus(statusCode),
      additions: 0,
      deletions: 0,
      isBinary: false,
    });
  }

  return changes;
}

function mapStatus(statusCode: string): PromotionFileStatus {
  if (statusCode === 'A') return 'added';
  if (statusCode === 'D') return 'deleted';
  return 'modified';
}

function splitNul(output: string): string[] {
  if (!output) return [];
  return output.split('\0').filter(token => token !== '');
}

function literalPathspec(filePath: string): string {
  return `:(literal)${filePath}`;
}

function gitTimeoutMs(): number {
  return readPositiveInteger(process.env.PROMOTION_GIT_TIMEOUT_MS, GIT_TIMEOUT_MS);
}

function gitKillAfterTimeoutMs(): number {
  return readPositiveInteger(process.env.PROMOTION_GIT_KILL_AFTER_MS, GIT_KILL_AFTER_TIMEOUT_MS);
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function validateRequestedPathInputs(paths: unknown): string[] {
  const syntheticChangedFiles: PromotionFileChange[] = Array.isArray(paths)
    ? paths
        .filter((pathValue): pathValue is string => typeof pathValue === 'string')
        .map(pathValue => ({
          path: validatePromotableRepoPath(pathValue),
          oldPath: null,
          status: 'modified',
          additions: 0,
          deletions: 0,
          isBinary: false,
        }))
    : [];

  return validatePromotionPaths(paths, syntheticChangedFiles);
}

function createBranchName(prefix: string): string {
  const safePrefix = prefix.replace(/\/+$/, '');
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const suffix = crypto.randomBytes(4).toString('hex');
  return `${safePrefix}/${timestamp}-${suffix}`;
}
