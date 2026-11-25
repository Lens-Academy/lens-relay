import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createPromotionRouteService } from '../app';
import { createGitPromotionService } from './git';
import { createGitHubPromotionService } from './github';
import type { PromotionConfig } from './types';

const execFileAsync = promisify(execFile);
const fixtureRoots: string[] = [];
const servers: http.Server[] = [];

interface RecordedRequest {
  path: string;
  body: unknown;
}

interface RepoFixture {
  root: string;
  remoteDir: string;
  seedDir: string;
  inspectDir: string;
  repoDir: string;
  stagingSha: string;
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

async function createFixture(): Promise<RepoFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'promotion-integration-'));
  fixtureRoots.push(root);
  const remoteDir = path.join(root, 'remote.git');
  const seedDir = path.join(root, 'seed');
  const inspectDir = path.join(root, 'inspect');
  const repoDir = path.join(root, 'scratch');

  await fs.mkdir(remoteDir, { recursive: true });
  await fs.mkdir(seedDir, { recursive: true });

  await runGit(remoteDir, ['init', '--bare']);
  await runGit(seedDir, ['init', '--initial-branch=production']);
  await runGit(seedDir, ['config', 'user.email', 'test@example.com']);
  await runGit(seedDir, ['config', 'user.name', 'Promotion Integration Test']);

  await writeFile(seedDir, 'selected.md', 'main selected\n');
  await writeFile(seedDir, 'unselected.md', 'main unselected\n');
  await writeFile(seedDir, 'unchanged.md', 'same\n');
  await runGit(seedDir, ['add', '.']);
  await runGit(seedDir, ['commit', '-m', 'main content']);
  await runGit(seedDir, ['remote', 'add', 'origin', remoteDir]);
  await runGit(seedDir, ['push', 'origin', 'production']);

  await runGit(seedDir, ['switch', '-c', 'staging']);
  await writeFile(seedDir, 'selected.md', 'staging selected\n');
  await writeFile(seedDir, 'unselected.md', 'staging unselected\n');
  await runGit(seedDir, ['add', '.']);
  await runGit(seedDir, ['commit', '-m', 'staging content']);
  await runGit(seedDir, ['push', 'origin', 'staging']);
  const stagingSha = await runGit(seedDir, ['rev-parse', 'staging']);

  await runGit(root, ['clone', remoteDir, inspectDir]);

  return {
    root,
    remoteDir,
    seedDir,
    inspectDir,
    repoDir,
    stagingSha,
    config: {
      enabled: true,
      repoUrl: remoteDir,
      productionRepoUrl: remoteDir,
      stagingRepoUrl: remoteDir,
      repoDir,
      mainBranch: 'production',
      stagingBranch: 'staging',
      branchPrefix: 'promote/integration',
      mergeMethod: 'SQUASH',
      githubOwner: 'Lens-Academy',
      githubRepo: 'lens-edu-production',
      githubToken: 'ghs_test_token',
    },
  };
}

async function readRequestBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : null;
}

/** A GitHub that answers like an unprotected branch: a new PR can merge at once. `onMerge` gets the PR's head branch. */
async function startFakeGitHub(onMerge: (branch: string) => Promise<void>): Promise<{
  apiBaseUrl: string;
  graphqlUrl: string;
  pulls: RecordedRequest[];
  merges: RecordedRequest[];
  graphql: RecordedRequest[];
}> {
  const pulls: RecordedRequest[] = [];
  const merges: RecordedRequest[] = [];
  const graphql: RecordedRequest[] = [];

  const server = http.createServer(async (req, res) => {
    try {
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'accept, authorization, content-type, x-github-api-version',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders);
        res.end();
        return;
      }

      if (req.method === 'POST' && req.url === '/repos/Lens-Academy/lens-edu-production/pulls') {
        pulls.push({ path: req.url, body: await readRequestBody(req) });
        res.writeHead(201, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          number: 123,
          html_url: 'https://github.com/Lens-Academy/lens-edu-production/pull/123',
          node_id: 'PR_kwDOIntegration123',
        }));
        return;
      }

      if (req.method === 'GET' && req.url === '/repos/Lens-Academy/lens-edu-production/pulls/123') {
        res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ mergeable: true, mergeable_state: 'clean' }));
        return;
      }

      if (req.method === 'PUT' && req.url === '/repos/Lens-Academy/lens-edu-production/pulls/123/merge') {
        merges.push({ path: req.url, body: await readRequestBody(req) });
        await onMerge(String((pulls[0].body as { head: string }).head));
        res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ merged: true }));
        return;
      }

      if (req.method === 'POST' && req.url === '/graphql') {
        graphql.push({ path: req.url, body: await readRequestBody(req) });
        res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: {
            enablePullRequestAutoMerge: {
              pullRequest: { id: 'PR_kwDOIntegration123' },
            },
          },
        }));
        return;
      }

      res.writeHead(404, { ...corsHeaders, 'Content-Type': 'text/plain' });
      res.end('not found');
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end(error instanceof Error ? error.message : String(error));
    }
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return {
    apiBaseUrl: `http://127.0.0.1:${port}`,
    graphqlUrl: `http://127.0.0.1:${port}/graphql`,
    pulls,
    merges,
    graphql,
  };
}

async function branchDiffNames(fixture: RepoFixture, branch: string): Promise<string[]> {
  await runGit(fixture.inspectDir, ['fetch', 'origin', branch]);
  const output = await runGit(fixture.inspectDir, [
    'diff',
    '--name-only',
    '--no-renames',
    'origin/production',
    `origin/${branch}`,
  ]);
  return output ? output.split('\n') : [];
}

async function showFile(fixture: RepoFixture, rev: string, filePath: string): Promise<string> {
  return runGit(fixture.inspectDir, ['show', `${rev}:${filePath}`]);
}

describe('promotion route service integration', () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await Promise.all(fixtureRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
  });

  it('promotes selected files through real Git and fake GitHub network I/O, and merges them', async () => {
    const fixture = await createFixture();
    const gitPromotion = createGitPromotionService(fixture.config);
    const fakeGitHub = await startFakeGitHub(async branch => {
      // An open tab polls while GitHub merges: it caches production as it was before the merge.
      await gitPromotion.getChanges();
      await runGit(fixture.remoteDir, ['update-ref', 'refs/heads/production', `refs/heads/${branch}`]);
    });
    const githubPromotion = createGitHubPromotionService(fixture.config, {
      apiBaseUrl: fakeGitHub.apiBaseUrl,
      graphqlUrl: fakeGitHub.graphqlUrl,
      sleep: async () => {},
    });
    const routeService = createPromotionRouteService(gitPromotion, githubPromotion);

    const result = await routeService.createPromotionPr({
      paths: ['selected.md'],
      title: 'Promote selected lesson',
    });

    expect(result).toMatchObject({
      branch: expect.stringMatching(/^promote\/integration\//),
      prNumber: 123,
      prUrl: 'https://github.com/Lens-Academy/lens-edu-production/pull/123',
      merge: 'merged',
    });
    expect(result).not.toHaveProperty('sourceStagingSha');
    await expect(branchDiffNames(fixture, result.branch)).resolves.toEqual(['selected.md']);
    await expect(showFile(fixture, `origin/${result.branch}`, 'selected.md')).resolves.toBe('staging selected');
    await expect(showFile(fixture, `origin/${result.branch}`, 'unselected.md')).resolves.toBe('main unselected');

    expect(fakeGitHub.pulls).toHaveLength(1);
    expect(fakeGitHub.pulls[0].body).toMatchObject({
      title: 'Promote selected lesson',
      head: result.branch,
      base: 'production',
      body: expect.stringContaining(`Source staging commit: ${fixture.stagingSha}`),
    });
    expect(String((fakeGitHub.pulls[0].body as { body: string }).body)).toContain('- `selected.md`');
    expect(fakeGitHub.merges).toHaveLength(1);
    expect(fakeGitHub.merges[0].body).toEqual({
      merge_method: 'squash',
      sha: await runGit(fixture.inspectDir, ['rev-parse', `origin/${result.branch}`]),
    });
    expect(fakeGitHub.graphql).toHaveLength(0);

    // The next read sees the merge at once, not after the 30-second fetch throttle.
    const after = await routeService.getChanges();
    expect(after.files.map(file => file.path)).toEqual(['unselected.md']);
  });
});
