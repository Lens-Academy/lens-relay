import { describe, expect, it } from 'vitest';
import { createGitHubPromotionService } from './github.ts';
import { PromotionError, type PromotionConfig } from './types.ts';

interface RecordedFetch {
  url: string;
  init: RequestInit;
  body: unknown;
}

function createConfig(overrides: Partial<PromotionConfig> = {}): PromotionConfig {
  return {
    enabled: true,
    repoUrl: 'git@github.com:Lens-Academy/lens-edu-relay.git',
    repoDir: '/tmp/lens-edu-relay',
    mainBranch: 'main',
    stagingBranch: 'staging',
    branchPrefix: 'promote/lens-editor',
    mergeMethod: 'SQUASH',
    githubOwner: 'Lens-Academy',
    githubRepo: 'lens-edu-relay',
    githubToken: 'ghs_test_token',
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function textResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, init);
}

function createRecordingFetch(responses: Array<Response | Error>): {
  fetchImpl: typeof fetch;
  calls: RecordedFetch[];
} {
  const calls: RecordedFetch[] = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    calls.push({ url: String(input), init, body });
    const response = responses.shift();
    if (!response) throw new Error(`Unexpected fetch call to ${String(input)}`);
    if (response instanceof Error) throw response;
    return response;
  };
  return { fetchImpl, calls };
}

describe('GitHub promotion service', () => {
  it('creates a PR and enables auto-merge', async () => {
    const { fetchImpl, calls } = createRecordingFetch([
      jsonResponse({
        number: 42,
        html_url: 'https://github.com/Lens-Academy/lens-edu-relay/pull/42',
        node_id: 'PR_kwDOTest42',
      }),
      jsonResponse({ data: { enablePullRequestAutoMerge: { pullRequest: { id: 'PR_kwDOTest42' } } } }),
    ]);
    const service = createGitHubPromotionService(createConfig(), {
      apiBaseUrl: 'https://api.github.test',
      graphqlUrl: 'https://api.github.test/graphql',
      fetchImpl,
    });

    const result = await service.createPullRequest({
      branch: 'promote/lens-editor/20260627-abcdef12',
      mainSha: '1111111111111111111111111111111111111111',
      sourceStagingSha: '2222222222222222222222222222222222222222',
      paths: ['courses/intro.md', 'courses/advanced path.md'],
      title: 'Promote selected lessons',
    });

    expect(result).toEqual({
      branch: 'promote/lens-editor/20260627-abcdef12',
      prNumber: 42,
      prUrl: 'https://github.com/Lens-Academy/lens-edu-relay/pull/42',
      mainSha: '1111111111111111111111111111111111111111',
      autoMergeEnabled: true,
    });
    expect(result).not.toHaveProperty('sourceStagingSha');

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('https://api.github.test/repos/Lens-Academy/lens-edu-relay/pulls');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toMatchObject({
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ghs_test_token',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    });
    expect(calls[0].body).toEqual({
      title: 'Promote selected lessons',
      head: 'promote/lens-editor/20260627-abcdef12',
      base: 'main',
      maintainer_can_modify: true,
      body: [
        'Created by Lens Editor production promotion.',
        '',
        'Source staging commit: 2222222222222222222222222222222222222222',
        'Base main commit at branch creation: 1111111111111111111111111111111111111111',
        '',
        'Promoted files:',
        '- `courses/intro.md`',
        '- `courses/advanced path.md`',
      ].join('\n'),
    });

    expect(calls[1].url).toBe('https://api.github.test/graphql');
    expect(calls[1].init.method).toBe('POST');
    expect(calls[1].init.headers).toMatchObject({
      Authorization: 'Bearer ghs_test_token',
      'Content-Type': 'application/json',
    });
    expect(calls[1].body).toMatchObject({
      variables: {
        pullRequestId: 'PR_kwDOTest42',
        mergeMethod: 'SQUASH',
      },
    });
    expect(String((calls[1].body as { query: string }).query)).toContain('enablePullRequestAutoMerge');
  });

  it('returns a warning when auto-merge GraphQL returns errors after PR creation', async () => {
    const { fetchImpl } = createRecordingFetch([
      jsonResponse({
        number: 7,
        html_url: 'https://github.com/Lens-Academy/lens-edu-relay/pull/7',
        node_id: 'PR_kwDOTest7',
      }),
      jsonResponse({ errors: [{ message: 'Branch protection is not configured for auto-merge' }] }),
    ]);
    const service = createGitHubPromotionService(createConfig(), { fetchImpl });

    const result = await service.createPullRequest({
      branch: 'promote/lens-editor/test',
      mainSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sourceStagingSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      paths: ['lesson.md'],
    });

    expect(result).toMatchObject({
      branch: 'promote/lens-editor/test',
      prNumber: 7,
      prUrl: 'https://github.com/Lens-Academy/lens-edu-relay/pull/7',
      mainSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      autoMergeEnabled: false,
    });
    expect(result.warning).toContain('Branch protection is not configured for auto-merge');
  });

  it('preserves the PR response with a warning when auto-merge fetch rejects', async () => {
    const { fetchImpl } = createRecordingFetch([
      jsonResponse({
        number: 8,
        html_url: 'https://github.com/Lens-Academy/lens-edu-relay/pull/8',
        node_id: 'PR_kwDOTest8',
      }),
      new Error('network unavailable'),
    ]);
    const service = createGitHubPromotionService(createConfig(), { fetchImpl });

    const result = await service.createPullRequest({
      branch: 'promote/lens-editor/network-warning',
      mainSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sourceStagingSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      paths: ['lesson.md'],
    });

    expect(result).toMatchObject({
      branch: 'promote/lens-editor/network-warning',
      prNumber: 8,
      prUrl: 'https://github.com/Lens-Academy/lens-edu-relay/pull/8',
      mainSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      autoMergeEnabled: false,
      warning: expect.stringContaining('network unavailable'),
    });
    expect(result).not.toHaveProperty('sourceStagingSha');
  });

  it('preserves the PR response with a warning when auto-merge returns malformed JSON', async () => {
    const { fetchImpl } = createRecordingFetch([
      jsonResponse({
        number: 9,
        html_url: 'https://github.com/Lens-Academy/lens-edu-relay/pull/9',
        node_id: 'PR_kwDOTest9',
      }),
      textResponse('not json', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ]);
    const service = createGitHubPromotionService(createConfig(), { fetchImpl });

    const result = await service.createPullRequest({
      branch: 'promote/lens-editor/malformed-warning',
      mainSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sourceStagingSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      paths: ['lesson.md'],
    });

    expect(result).toMatchObject({
      branch: 'promote/lens-editor/malformed-warning',
      prNumber: 9,
      prUrl: 'https://github.com/Lens-Academy/lens-edu-relay/pull/9',
      mainSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      autoMergeEnabled: false,
      warning: expect.stringContaining('GitHub GraphQL auto-merge request failed'),
    });
    expect(result).not.toHaveProperty('sourceStagingSha');
  });

  it('throws PromotionError with github_failed when PR creation fails', async () => {
    const { fetchImpl } = createRecordingFetch([textResponse('rate limited', { status: 403 })]);
    const service = createGitHubPromotionService(createConfig(), { fetchImpl });

    let thrown: unknown;
    try {
      await service.createPullRequest({
        branch: 'promote/lens-editor/test',
        mainSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        sourceStagingSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        paths: ['lesson.md'],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PromotionError);
    expect(thrown).toMatchObject({
      status: 403,
      code: 'github_failed',
      message: expect.stringContaining('rate limited'),
    });
  });

  it('wraps PR creation fetch rejection in PromotionError with github_failed', async () => {
    const { fetchImpl } = createRecordingFetch([new Error('connection reset')]);
    const service = createGitHubPromotionService(createConfig(), { fetchImpl });

    let thrown: unknown;
    try {
      await service.createPullRequest({
        branch: 'promote/lens-editor/rest-network',
        mainSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        sourceStagingSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        paths: ['lesson.md'],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PromotionError);
    expect(thrown).toMatchObject({
      status: 502,
      code: 'github_failed',
      message: expect.stringContaining('connection reset'),
    });
  });

  it('wraps malformed PR creation JSON in PromotionError with github_failed', async () => {
    const { fetchImpl } = createRecordingFetch([
      textResponse('not json', { status: 201, headers: { 'Content-Type': 'application/json' } }),
    ]);
    const service = createGitHubPromotionService(createConfig(), { fetchImpl });

    let thrown: unknown;
    try {
      await service.createPullRequest({
        branch: 'promote/lens-editor/rest-malformed',
        mainSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        sourceStagingSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        paths: ['lesson.md'],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PromotionError);
    expect(thrown).toMatchObject({
      status: 502,
      code: 'github_failed',
      message: expect.stringContaining('GitHub pull request creation returned invalid JSON'),
    });
  });

  it.each([
    { paths: ['one.md'], expectedTitle: 'Promote 1 course file' },
    { paths: ['one.md', 'two.md'], expectedTitle: 'Promote 2 course files' },
  ])('uses a sensible default title for $expectedTitle', async ({ paths, expectedTitle }) => {
    const { fetchImpl, calls } = createRecordingFetch([
      jsonResponse({
        number: 11,
        html_url: 'https://github.com/Lens-Academy/lens-edu-relay/pull/11',
        node_id: 'PR_kwDOTest11',
      }),
      jsonResponse({ data: { enablePullRequestAutoMerge: { pullRequest: { id: 'PR_kwDOTest11' } } } }),
    ]);
    const service = createGitHubPromotionService(createConfig(), { fetchImpl });

    await service.createPullRequest({
      branch: 'promote/lens-editor/default-title',
      mainSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sourceStagingSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      paths,
    });

    expect(calls[0].body).toMatchObject({ title: expectedTitle });
  });

  it('uses injected endpoints and fetch implementation for both GitHub requests', async () => {
    const { fetchImpl, calls } = createRecordingFetch([
      jsonResponse({
        number: 13,
        html_url: 'https://github.test/custom/pull/13',
        node_id: 'PR_custom13',
      }),
      jsonResponse({}, { status: 500 }),
    ]);
    const service = createGitHubPromotionService(createConfig({ githubOwner: 'custom-owner', githubRepo: 'custom-repo' }), {
      apiBaseUrl: 'https://github.enterprise.test/api/v3/',
      graphqlUrl: 'https://github.enterprise.test/graphql',
      fetchImpl,
    });

    const result = await service.createPullRequest({
      branch: 'promote/custom/test',
      mainSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sourceStagingSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      paths: ['lesson.md'],
    });

    expect(calls.map(call => call.url)).toEqual([
      'https://github.enterprise.test/api/v3/repos/custom-owner/custom-repo/pulls',
      'https://github.enterprise.test/graphql',
    ]);
    expect(result).toMatchObject({
      autoMergeEnabled: false,
      warning: expect.stringContaining('GitHub GraphQL auto-merge request failed with status 500'),
    });
  });
});
