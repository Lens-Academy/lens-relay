import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitPromotionService, spawnFile } from './git.ts';
import type { PromotionConfig } from './types.ts';

const execFileAsync = promisify(execFile);
const fixtureRoots: string[] = [];

interface RepoFixture {
  root: string;
  remoteDir: string;
  productionRemoteDir?: string;
  stagingRemoteDir?: string;
  seedDir: string;
  inspectDir: string;
  repoDir: string;
  config: PromotionConfig;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
    },
  });
  return stdout.trimEnd();
}

async function writeFile(repoDir: string, filePath: string, contents: string): Promise<void> {
  const absolutePath = path.join(repoDir, filePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, contents);
}

async function writeBinaryFile(repoDir: string, filePath: string, contents: Buffer): Promise<void> {
  const absolutePath = path.join(repoDir, filePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, contents);
}

async function createFixture(): Promise<RepoFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'promotion-git-'));
  fixtureRoots.push(root);
  const remoteDir = path.join(root, 'remote.git');
  const seedDir = path.join(root, 'seed');
  const inspectDir = path.join(root, 'inspect');
  const repoDir = path.join(root, 'scratch');

  await fs.mkdir(remoteDir, { recursive: true });
  await fs.mkdir(seedDir, { recursive: true });

  await runGit(remoteDir, ['init', '--bare']);
  await runGit(seedDir, ['init', '--initial-branch=main']);
  await runGit(seedDir, ['config', 'user.email', 'test@example.com']);
  await runGit(seedDir, ['config', 'user.name', 'Promotion Test']);

  await writeFile(seedDir, 'modified.md', 'main version\n');
  await writeFile(seedDir, '.github/workflows/validate.yml', 'main workflow\n');
  await writeFile(seedDir, 'unchanged.md', 'same in both branches\n');
  await writeFile(seedDir, 'deleted.md', 'remove me from staging\n');
  await writeFile(seedDir, 'rename-old.md', 'renamed file content\n');
  await writeFile(seedDir, 'Dir/Path With Spaces.md', 'space main\n');
  await writeBinaryFile(seedDir, 'binary.dat', Buffer.from([0, 1, 2, 3]));
  await runGit(seedDir, ['add', '.']);
  await runGit(seedDir, ['commit', '-m', 'main content']);
  await runGit(seedDir, ['remote', 'add', 'origin', remoteDir]);
  await runGit(seedDir, ['push', 'origin', 'main']);

  await runGit(seedDir, ['switch', '-c', 'staging']);
  await writeFile(seedDir, 'modified.md', 'staging version\n');
  await writeFile(seedDir, '.github/workflows/validate.yml', 'staging workflow\n');
  await writeFile(seedDir, 'added.md', 'new on staging\n');
  await fs.rm(path.join(seedDir, 'deleted.md'));
  await runGit(seedDir, ['mv', 'rename-old.md', 'rename-new.md']);
  await writeFile(seedDir, 'Dir/Path With Spaces.md', 'space staging\n');
  await writeBinaryFile(seedDir, 'binary.dat', Buffer.from([0, 1, 2, 4]));
  await runGit(seedDir, ['add', '.']);
  await runGit(seedDir, ['commit', '-m', 'staging content']);
  await runGit(seedDir, ['push', 'origin', 'staging']);

  await runGit(root, ['clone', remoteDir, inspectDir]);

  return {
    root,
    remoteDir,
    seedDir,
    inspectDir,
    repoDir,
    config: {
      enabled: true,
      repoUrl: remoteDir,
      productionRepoUrl: remoteDir,
      stagingRepoUrl: remoteDir,
      repoDir,
      mainBranch: 'main',
      stagingBranch: 'staging',
      branchPrefix: 'promote/test',
      mergeMethod: 'SQUASH',
      githubOwner: 'owner',
      githubRepo: 'repo',
      githubToken: 'token',
    },
  };
}

async function createSeparateRepoFixture(): Promise<RepoFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'promotion-git-two-repos-'));
  fixtureRoots.push(root);
  const productionRemoteDir = path.join(root, 'production.git');
  const stagingRemoteDir = path.join(root, 'staging.git');
  const productionSeedDir = path.join(root, 'production-seed');
  const stagingSeedDir = path.join(root, 'staging-seed');
  const inspectDir = path.join(root, 'inspect');
  const repoDir = path.join(root, 'scratch');

  await fs.mkdir(productionRemoteDir, { recursive: true });
  await fs.mkdir(stagingRemoteDir, { recursive: true });
  await fs.mkdir(productionSeedDir, { recursive: true });
  await fs.mkdir(stagingSeedDir, { recursive: true });

  await runGit(productionRemoteDir, ['init', '--bare']);
  await runGit(stagingRemoteDir, ['init', '--bare']);

  await runGit(productionSeedDir, ['init', '--initial-branch=main']);
  await runGit(productionSeedDir, ['config', 'user.email', 'test@example.com']);
  await runGit(productionSeedDir, ['config', 'user.name', 'Production Test']);
  await writeFile(productionSeedDir, 'selected.md', 'production selected\n');
  await writeFile(productionSeedDir, 'unselected.md', 'production unselected\n');
  await writeFile(productionSeedDir, 'unchanged.md', 'same content\n');
  await runGit(productionSeedDir, ['add', '.']);
  await runGit(productionSeedDir, ['commit', '-m', 'production main']);
  await runGit(productionSeedDir, ['remote', 'add', 'origin', productionRemoteDir]);
  await runGit(productionSeedDir, ['push', 'origin', 'main']);

  await runGit(stagingSeedDir, ['init', '--initial-branch=staging']);
  await runGit(stagingSeedDir, ['config', 'user.email', 'test@example.com']);
  await runGit(stagingSeedDir, ['config', 'user.name', 'Staging Test']);
  await writeFile(stagingSeedDir, 'selected.md', 'staging selected\n');
  await writeFile(stagingSeedDir, 'unselected.md', 'staging unselected\n');
  await writeFile(stagingSeedDir, 'unchanged.md', 'same content\n');
  await runGit(stagingSeedDir, ['add', '.']);
  await runGit(stagingSeedDir, ['commit', '-m', 'staging content']);
  await runGit(stagingSeedDir, ['remote', 'add', 'origin', stagingRemoteDir]);
  await runGit(stagingSeedDir, ['push', 'origin', 'staging']);

  await runGit(root, ['clone', productionRemoteDir, inspectDir]);

  return {
    root,
    remoteDir: productionRemoteDir,
    productionRemoteDir,
    stagingRemoteDir,
    seedDir: stagingSeedDir,
    inspectDir,
    repoDir,
    config: {
      enabled: true,
      repoUrl: productionRemoteDir,
      productionRepoUrl: productionRemoteDir,
      stagingRepoUrl: stagingRemoteDir,
      repoDir,
      mainBranch: 'main',
      stagingBranch: 'staging',
      branchPrefix: 'promote/two-repos',
      mergeMethod: 'SQUASH',
      githubOwner: 'owner',
      githubRepo: 'production',
      githubToken: 'token',
    },
  };
}

async function fetchPromotionBranch(fixture: RepoFixture, branch: string): Promise<void> {
  await runGit(fixture.inspectDir, ['fetch', 'origin', branch]);
}

async function branchDiffNames(fixture: RepoFixture, branch: string): Promise<string[]> {
  await fetchPromotionBranch(fixture, branch);
  const output = await runGit(fixture.inspectDir, [
    'diff',
    '--name-only',
    '--no-renames',
    'origin/main',
    `origin/${branch}`,
  ]);
  return output ? output.split('\n') : [];
}

async function showFile(fixture: RepoFixture, rev: string, filePath: string): Promise<string> {
  return runGit(fixture.inspectDir, ['show', `${rev}:${filePath}`]);
}

async function lastCommitMessage(fixture: RepoFixture, branch: string): Promise<string> {
  await fetchPromotionBranch(fixture, branch);
  return runGit(fixture.inspectDir, ['log', '-1', '--format=%B', `origin/${branch}`]);
}

async function resetStagingToMain(fixture: RepoFixture): Promise<void> {
  await runGit(fixture.seedDir, ['switch', 'staging']);
  await runGit(fixture.seedDir, ['reset', '--hard', 'main']);
  await runGit(fixture.seedDir, ['push', '--force', 'origin', 'staging']);
}

async function createWrongOriginCheckout(fixture: RepoFixture): Promise<{
  wrongRemoteDir: string;
  sentinelPath: string;
  initialBranch: string;
}> {
  const wrongRemoteDir = path.join(fixture.root, 'wrong-remote.git');
  const wrongSeedDir = path.join(fixture.root, 'wrong-seed');
  await fs.mkdir(wrongRemoteDir, { recursive: true });
  await fs.mkdir(wrongSeedDir, { recursive: true });

  await runGit(wrongRemoteDir, ['init', '--bare']);
  await runGit(wrongSeedDir, ['init', '--initial-branch=main']);
  await runGit(wrongSeedDir, ['config', 'user.email', 'wrong@example.com']);
  await runGit(wrongSeedDir, ['config', 'user.name', 'Wrong Remote']);
  await writeFile(wrongSeedDir, 'modified.md', 'wrong main\n');
  await runGit(wrongSeedDir, ['add', '.']);
  await runGit(wrongSeedDir, ['commit', '-m', 'wrong main']);
  await runGit(wrongSeedDir, ['remote', 'add', 'origin', wrongRemoteDir]);
  await runGit(wrongSeedDir, ['push', 'origin', 'main']);
  await runGit(wrongSeedDir, ['switch', '-c', 'staging']);
  await writeFile(wrongSeedDir, 'modified.md', 'wrong staging\n');
  await runGit(wrongSeedDir, ['add', '.']);
  await runGit(wrongSeedDir, ['commit', '-m', 'wrong staging']);
  await runGit(wrongSeedDir, ['push', 'origin', 'staging']);

  await runGit(fixture.root, ['clone', wrongRemoteDir, fixture.repoDir]);
  const sentinelPath = path.join(fixture.repoDir, 'sentinel.tmp');
  await fs.writeFile(sentinelPath, 'must survive clean\n');
  const initialBranch = await runGit(fixture.repoDir, ['branch', '--show-current']);
  return { wrongRemoteDir, sentinelPath, initialBranch };
}

describe('git promotion service', () => {
  afterEach(async () => {
    delete process.env.PROMOTION_GIT_TIMEOUT_MS;
    delete process.env.PROMOTION_GIT_KILL_AFTER_MS;
    await Promise.all(fixtureRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
  });

  it('lists modified, added, renamed, and deleted files while excluding unchanged files', async () => {
    const fixture = await createFixture();
    const service = createGitPromotionService(fixture.config);

    const changes = await service.getChanges();
    const byPath = new Map(changes.files.map(file => [file.path, file]));

    expect(changes.mainSha).toMatch(/^[0-9a-f]{40}$/);
    expect(byPath.get('modified.md')).toMatchObject({
      status: 'modified',
      oldPath: null,
      additions: 1,
      deletions: 1,
      isBinary: false,
    });
    expect(byPath.get('added.md')).toMatchObject({
      status: 'added',
      oldPath: null,
      additions: 1,
      deletions: 0,
      isBinary: false,
    });
    expect(byPath.get('deleted.md')).toMatchObject({
      status: 'deleted',
      oldPath: null,
      additions: 0,
      deletions: 1,
      isBinary: false,
    });
    expect(byPath.get('rename-new.md')).toMatchObject({
      status: 'renamed',
      oldPath: 'rename-old.md',
      additions: 0,
      deletions: 0,
      isBinary: false,
    });
    expect(byPath.get('binary.dat')).toMatchObject({
      status: 'modified',
      oldPath: null,
      additions: 0,
      deletions: 0,
      isBinary: true,
    });
    expect(byPath.has('.github/workflows/validate.yml')).toBe(false);
    expect(byPath.has('unchanged.md')).toBe(false);
  });

  it('excludes GitHub workflow files from promotion APIs', async () => {
    const fixture = await createFixture();
    const service = createGitPromotionService(fixture.config);

    await expect(service.getStatus('.github/workflows/validate.yml')).rejects.toMatchObject({
      status: 400,
      code: 'path_not_promotable',
    });
    await expect(service.getDiff('.github/workflows/validate.yml')).rejects.toMatchObject({
      status: 400,
      code: 'path_not_promotable',
    });
    await expect(service.createPromotionBranch({ paths: ['.github/workflows/validate.yml'] })).rejects.toMatchObject({
      status: 400,
      code: 'path_not_promotable',
    });
  });

  it('getStatus returns exactly identical for a truly unchanged file', async () => {
    const fixture = await createFixture();
    const service = createGitPromotionService(fixture.config);

    const status = await service.getStatus('unchanged.md');

    expect(status).toMatchObject({
      path: 'unchanged.md',
      oldPath: null,
      status: 'identical',
      additions: 0,
      deletions: 0,
      isBinary: false,
    });
  });

  it('getStatus returns deleted for a file removed on staging', async () => {
    const fixture = await createFixture();
    const service = createGitPromotionService(fixture.config);

    await expect(service.getStatus('deleted.md')).resolves.toMatchObject({
      path: 'deleted.md',
      status: 'deleted',
    });
  });

  it('creates a promotion branch containing only one selected modified file', async () => {
    const fixture = await createFixture();
    const service = createGitPromotionService(fixture.config);

    const result = await service.createPromotionBranch({ paths: ['modified.md'] });

    expect(result.branch).toMatch(/^promote\/test\//);
    expect(result.mainSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.sourceStagingSha).toMatch(/^[0-9a-f]{40}$/);
    await expect(branchDiffNames(fixture, result.branch)).resolves.toEqual(['modified.md']);
    await expect(showFile(fixture, `origin/${result.branch}`, 'modified.md')).resolves.toBe('staging version');
    await expect(lastCommitMessage(fixture, result.branch)).resolves.toContain(
      `Source staging commit: ${result.sourceStagingSha}`,
    );
  });

  it('creates promotion branches from production while restoring selected files from a separate staging repository', async () => {
    const fixture = await createSeparateRepoFixture();
    const service = createGitPromotionService(fixture.config);

    const changes = await service.getChanges();
    expect(changes.files.map(file => file.path).sort()).toEqual(['selected.md', 'unselected.md']);

    const result = await service.createPromotionBranch({ paths: ['selected.md'] });

    expect(result.branch).toMatch(/^promote\/two-repos\//);
    await expect(branchDiffNames(fixture, result.branch)).resolves.toEqual(['selected.md']);
    await expect(showFile(fixture, `origin/${result.branch}`, 'selected.md')).resolves.toBe('staging selected');
    await expect(showFile(fixture, `origin/${result.branch}`, 'unselected.md')).resolves.toBe('production unselected');
  });

  it('promotes both sides of a rename when selecting the new path', async () => {
    const fixture = await createFixture();
    const service = createGitPromotionService(fixture.config);

    const result = await service.createPromotionBranch({ paths: ['rename-new.md'] });

    await expect(branchDiffNames(fixture, result.branch)).resolves.toEqual(['rename-new.md', 'rename-old.md']);
    await expect(showFile(fixture, `origin/${result.branch}`, 'rename-new.md')).resolves.toBe('renamed file content');
    await expect(showFile(fixture, `origin/${result.branch}`, 'rename-old.md')).rejects.toThrow();
  });

  it('promotes an added file', async () => {
    const fixture = await createFixture();
    const service = createGitPromotionService(fixture.config);

    const result = await service.createPromotionBranch({ paths: ['added.md'] });

    await expect(branchDiffNames(fixture, result.branch)).resolves.toEqual(['added.md']);
    await expect(showFile(fixture, `origin/${result.branch}`, 'added.md')).resolves.toBe('new on staging');
  });

  it('promotes a deleted file', async () => {
    const fixture = await createFixture();
    const service = createGitPromotionService(fixture.config);

    const result = await service.createPromotionBranch({ paths: ['deleted.md'] });

    await expect(branchDiffNames(fixture, result.branch)).resolves.toEqual(['deleted.md']);
    await expect(showFile(fixture, `origin/${result.branch}`, 'deleted.md')).rejects.toThrow();
  });

  it('handles a selected path containing spaces', async () => {
    const fixture = await createFixture();
    const service = createGitPromotionService(fixture.config);

    const result = await service.createPromotionBranch({ paths: ['Dir/Path With Spaces.md'] });

    await expect(branchDiffNames(fixture, result.branch)).resolves.toEqual(['Dir/Path With Spaces.md']);
    await expect(showFile(fixture, `origin/${result.branch}`, 'Dir/Path With Spaces.md')).resolves.toBe('space staging');
  });

  it('throws nothing_to_promote when the latest branches no longer differ for the selected file', async () => {
    const fixture = await createFixture();
    const service = createGitPromotionService(fixture.config);

    await resetStagingToMain(fixture);

    await expect(service.createPromotionBranch({ paths: ['modified.md'] })).rejects.toMatchObject({
      status: 409,
      code: 'nothing_to_promote',
    });
  });

  it('validates unsafe promotion paths before returning nothing_to_promote for identical branches', async () => {
    const fixture = await createFixture();
    const service = createGitPromotionService(fixture.config);

    await resetStagingToMain(fixture);

    await expect(service.createPromotionBranch({ paths: ['../secret.md'] })).rejects.toMatchObject({
      status: 400,
      code: 'invalid_path',
    });
  });

  it('rejects an existing checkout with a different origin before destructive promotion commands', async () => {
    const fixture = await createFixture();
    const { sentinelPath, initialBranch } = await createWrongOriginCheckout(fixture);
    const service = createGitPromotionService(fixture.config);

    await expect(service.createPromotionBranch({ paths: ['modified.md'] })).rejects.toMatchObject({
      status: 500,
      code: 'invalid_repo_origin',
    });

    await expect(fs.readFile(sentinelPath, 'utf8')).resolves.toBe('must survive clean\n');
    await expect(runGit(fixture.repoDir, ['branch', '--show-current'])).resolves.toBe(initialBranch);
  });

  it('rejects an unowned existing checkout with the same origin before destructive promotion commands', async () => {
    const fixture = await createFixture();
    await runGit(fixture.root, ['clone', fixture.remoteDir, fixture.repoDir]);
    const sentinelPath = path.join(fixture.repoDir, 'sentinel.tmp');
    await fs.writeFile(sentinelPath, 'must survive clean\n');
    const initialBranch = await runGit(fixture.repoDir, ['branch', '--show-current']);
    const service = createGitPromotionService(fixture.config);

    await expect(service.createPromotionBranch({ paths: ['modified.md'] })).rejects.toMatchObject({
      status: 500,
      code: 'invalid_repo_owner',
    });

    await expect(fs.readFile(sentinelPath, 'utf8')).resolves.toBe('must survive clean\n');
    await expect(runGit(fixture.repoDir, ['branch', '--show-current'])).resolves.toBe(initialBranch);
  });

  it('serializes operations across service instances sharing the same repoDir', async () => {
    const fixture = await createFixture();
    const serviceA = createGitPromotionService(fixture.config);
    const serviceB = createGitPromotionService(fixture.config);

    const [modifiedResult, addedResult] = await Promise.all([
      serviceA.createPromotionBranch({ paths: ['modified.md'] }),
      serviceB.createPromotionBranch({ paths: ['added.md'] }),
    ]);

    await expect(branchDiffNames(fixture, modifiedResult.branch)).resolves.toEqual(['modified.md']);
    await expect(branchDiffNames(fixture, addedResult.branch)).resolves.toEqual(['added.md']);
  });

  it('getDiff returns blob metadata and unified diff for a text file', async () => {
    const fixture = await createFixture();
    const service = createGitPromotionService(fixture.config);

    const diff = await service.getDiff('modified.md');

    expect(diff).toMatchObject({
      path: 'modified.md',
      status: 'modified',
      isBinary: false,
      beforeBlob: { size: 13 },
      afterBlob: { size: 16 },
    });
    expect(diff.beforeBlob?.oid).toMatch(/^[0-9a-f]{40}$/);
    expect(diff.afterBlob?.oid).toMatch(/^[0-9a-f]{40}$/);
    expect(diff.diff).toContain('-main version');
    expect(diff.diff).toContain('+staging version');
  });

  it.each(['../secret.md', '*.md', ':(glob)**'])(
    'rejects traversal and pathspec-like unsafe input %s',
    async unsafePath => {
      const fixture = await createFixture();
      const service = createGitPromotionService(fixture.config);

      await expect(service.getStatus(unsafePath)).rejects.toMatchObject({ status: 400, code: 'invalid_path' });
      await expect(service.getDiff(unsafePath)).rejects.toMatchObject({ status: 400, code: 'invalid_path' });
      await expect(service.createPromotionBranch({ paths: [unsafePath] })).rejects.toMatchObject({
        status: 400,
        code: 'invalid_path',
      });
    },
  );

  it('rejects timed out child processes even if SIGTERM is ignored', async () => {
    process.env.PROMOTION_GIT_TIMEOUT_MS = '25';
    process.env.PROMOTION_GIT_KILL_AFTER_MS = '25';
    const fixture = await createFixture();

    await expect(
      spawnFile(
        process.execPath,
        ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
        { cwd: fixture.root },
      ),
    ).rejects.toMatchObject({
      status: 504,
      code: 'git_timeout',
    });
  });
});
