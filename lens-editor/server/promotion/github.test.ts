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
    repoUrl: 'git@github.com:Lens-Academy/lens-edu-production.git',
    productionRepoUrl: 'git@github.com:Lens-Academy/lens-edu-production.git',
    stagingRepoUrl: 'git@github.com:Lens-Academy/lens-edu-staging.git',
    repoDir: '/tmp/lens-edu-production',
    mainBranch: 'production',
    stagingBranch: 'staging',
    branchPrefix: 'promote/lens-editor',
    mergeMethod: 'SQUASH',
    githubOwner: 'Lens-Academy',
    githubRepo: 'lens-edu-production',
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

const MAIN_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const STAGING_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HEAD_SHA = 'cccccccccccccccccccccccccccccccccccccccc';

/** GitHub's answer to creating PR `number`. */
function prCreated(number: number): Response {
  return jsonResponse(
    {
      number,
      html_url: `https://github.com/Lens-Academy/lens-edu-production/pull/${number}`,
      node_id: `PR_kwDOTest${number}`,
    },
    { status: 201 },
  );
}

/** GitHub's answer to reading a PR: `mergeable` is null while GitHub is still working it out. */
function prState(mergeable: boolean | null, mergeableState: string): Response {
  return jsonResponse({ mergeable, mergeable_state: mergeableState });
}

const autoMergeQueued = () =>
  jsonResponse({ data: { enablePullRequestAutoMerge: { pullRequest: { id: 'PR_kwDOTest7' } } } });

function serviceFor(responses: Array<Response | Error>, config: Partial<PromotionConfig> = {}) {
  const { fetchImpl, calls } = createRecordingFetch(responses);
  const waits: number[] = [];
  const service = createGitHubPromotionService(createConfig(config), {
    apiBaseUrl: 'https://api.github.test',
    graphqlUrl: 'https://api.github.test/graphql',
    fetchImpl,
    sleep: async ms => {
      waits.push(ms);
    },
  });
  return { service, calls, waits };
}

function promote(service: ReturnType<typeof serviceFor>['service'], paths = ['lesson.md']) {
  return service.createPullRequest({
    branch: 'promote/lens-editor/test',
    mainSha: MAIN_SHA,
    sourceStagingSha: STAGING_SHA,
    headSha: HEAD_SHA,
    paths,
  });
}

async function promotionError(service: ReturnType<typeof serviceFor>['service']): Promise<unknown> {
  try {
    await promote(service);
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promotion to fail');
}

describe('GitHub promotion service', () => {
  it('creates a PR and merges it once GitHub has worked out that it can', async () => {
    const { service, calls, waits } = serviceFor([
      prCreated(42),
      prState(null, 'unknown'),
      prState(true, 'clean'),
      jsonResponse({ merged: true, sha: 'dddddddddddddddddddddddddddddddddddddddd' }),
    ]);

    const result = await service.createPullRequest({
      branch: 'promote/lens-editor/20260627-abcdef12',
      mainSha: '1111111111111111111111111111111111111111',
      sourceStagingSha: '2222222222222222222222222222222222222222',
      headSha: HEAD_SHA,
      paths: ['courses/intro.md', 'courses/advanced path.md'],
      title: 'Promote selected lessons',
    });

    expect(result).toEqual({
      branch: 'promote/lens-editor/20260627-abcdef12',
      prNumber: 42,
      prUrl: 'https://github.com/Lens-Academy/lens-edu-production/pull/42',
      mainSha: '1111111111111111111111111111111111111111',
      merge: 'merged',
    });
    expect(result).not.toHaveProperty('sourceStagingSha');
    expect(result).not.toHaveProperty('headSha');

    expect(calls.map(call => `${call.init.method ?? 'GET'} ${call.url}`)).toEqual([
      'POST https://api.github.test/repos/Lens-Academy/lens-edu-production/pulls',
      'GET https://api.github.test/repos/Lens-Academy/lens-edu-production/pulls/42',
      'GET https://api.github.test/repos/Lens-Academy/lens-edu-production/pulls/42',
      'PUT https://api.github.test/repos/Lens-Academy/lens-edu-production/pulls/42/merge',
    ]);
    expect(waits).toEqual([500, 1000]);
    for (const call of calls) {
      expect(call.init.headers).toMatchObject({
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ghs_test_token',
        'X-GitHub-Api-Version': '2022-11-28',
      });
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(calls[0].body).toEqual({
      title: 'Promote selected lessons',
      head: 'promote/lens-editor/20260627-abcdef12',
      base: 'production',
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
    expect(calls[3].body).toEqual({ merge_method: 'squash', sha: HEAD_SHA });
  });

  it.each(['unstable', 'has_hooks'])('merges a PR in state %s, which GitHub lets merge', async state => {
    const { service } = serviceFor([prCreated(5), prState(true, state), jsonResponse({ merged: true })]);
    await expect(promote(service)).resolves.toMatchObject({ merge: 'merged' });
  });

  it('uses the configured merge method', async () => {
    const { service, calls } = serviceFor(
      [prCreated(5), prState(true, 'clean'), jsonResponse({ merged: true })],
      { mergeMethod: 'REBASE' },
    );
    await promote(service);
    expect(calls[2].body).toMatchObject({ merge_method: 'rebase' });
  });

  it('asks for auto-merge when the branch still requires something', async () => {
    const { service, calls } = serviceFor([prCreated(7), prState(true, 'blocked'), autoMergeQueued()]);

    await expect(promote(service)).resolves.toMatchObject({ prNumber: 7, merge: 'auto-merge' });
    expect(calls[2].url).toBe('https://api.github.test/graphql');
    expect(calls[2].init.headers).toMatchObject({ Authorization: 'Bearer ghs_test_token' });
    expect(calls[2].body).toMatchObject({ variables: { pullRequestId: 'PR_kwDOTest7', mergeMethod: 'SQUASH' } });
    expect(String((calls[2].body as { query: string }).query)).toContain('enablePullRequestAutoMerge');
  });

  it.each(['dirty', 'blocked', 'unknown'])(
    'leaves a PR that GitHub says cannot merge (state %s) open, and says it conflicts',
    async state => {
      const { service, calls } = serviceFor([prCreated(7), prState(false, state)]);

      const result = await promote(service);

      expect(result).toMatchObject({ merge: 'open', warning: expect.stringContaining('conflicts with production') });
      expect(calls).toHaveLength(2);
    },
  );

  it('leaves a PR that is behind a production requiring up-to-date branches open, and says what to do', async () => {
    const { service, calls } = serviceFor([prCreated(7), prState(true, 'behind')]);

    const result = await promote(service);

    expect(result).toMatchObject({ merge: 'open', warning: expect.stringContaining('update its branch') });
    expect(calls).toHaveLength(2);
  });

  it('tries the merge anyway when GitHub has not worked out the PR after every wait', async () => {
    const { service, calls, waits } = serviceFor([
      prCreated(7),
      ...Array.from({ length: 5 }, () => prState(null, 'unknown')),
      jsonResponse({ merged: true }),
    ]);

    await expect(promote(service)).resolves.toMatchObject({ merge: 'merged' });
    expect(waits).toEqual([500, 1000, 2000, 2000, 2000]);
    expect(calls.at(-1)?.init.method).toBe('PUT');
  });

  it.each([
    ['answers with an error', textResponse('bad gateway', { status: 502 })],
    ['cannot be reached', new Error('connection reset')],
  ])('keeps looking when GitHub %s on reading the PR', async (_name, answer) => {
    const { service, calls } = serviceFor([prCreated(7), answer, prState(false, 'dirty')]);
    await expect(promote(service)).resolves.toMatchObject({ merge: 'open' });
    expect(calls).toHaveLength(3);
  });

  it.each([
    [
      'refuses the merge',
      textResponse('{"message":"Head branch was modified. Review and try the merge again."}', { status: 409 }),
      'GitHub did not merge the pull request: Head branch was modified. Review and try the merge again (status 409). Open the pull request on GitHub to merge it.',
    ],
    [
      'refuses the merge without JSON',
      textResponse('', { status: 403 }),
      'GitHub did not merge the pull request: status 403. Open the pull request on GitHub to merge it.',
    ],
  ])('leaves the PR open with GitHub\'s reason when GitHub %s', async (_name, answer, warning) => {
    const { service, calls } = serviceFor([prCreated(8), prState(true, 'clean'), answer]);

    const result = await promote(service);

    expect(result).toEqual(expect.objectContaining({ prNumber: 8, merge: 'open', warning }));
    expect(calls).toHaveLength(3);
  });

  it('leaves the PR open, without failing the promotion, when the body of a refusal breaks off', async () => {
    const broken = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('socket hang up'));
        },
      }),
      { status: 405 },
    );
    const { service } = serviceFor([prCreated(8), prState(true, 'clean'), broken]);

    await expect(promote(service)).resolves.toMatchObject({
      merge: 'open',
      warning: 'GitHub did not merge the pull request: status 405. Open the pull request on GitHub to merge it.',
    });
  });

  it('looks again after a 5xx from the merge, which can come after GitHub merged', async () => {
    const gatewayError = () => jsonResponse({ message: 'Bad Gateway' }, { status: 502 });
    const merged = serviceFor([prCreated(8), prState(true, 'clean'), gatewayError(), jsonResponse({ merged: true })]);
    await expect(promote(merged.service)).resolves.toMatchObject({ merge: 'merged' });

    const notMerged = serviceFor([prCreated(8), prState(true, 'clean'), gatewayError(), jsonResponse({ merged: false })]);
    await expect(promote(notMerged.service)).resolves.toMatchObject({
      merge: 'open',
      warning: 'GitHub did not merge the pull request: Bad Gateway (status 502). Open the pull request on GitHub to merge it.',
    });
  });

  it.each([
    ['cannot be reached', () => new Error('network unavailable'), 'The merge request to GitHub failed: network unavailable.'],
    [
      'answers with JSON it cannot read',
      () => textResponse('{"merg', { status: 200 }),
      'GitHub answered the merge request without saying that the pull request merged.',
    ],
    [
      'answers without merging',
      () => jsonResponse({ merged: false }),
      'GitHub answered the merge request without saying that the pull request merged.',
    ],
  ])('looks again when the merge request %s', async (_name, answer, why) => {
    const merged = serviceFor([prCreated(8), prState(true, 'clean'), answer(), jsonResponse({ merged: true })]);
    await expect(promote(merged.service)).resolves.toMatchObject({ merge: 'merged' });
    expect(merged.calls.at(-1)?.url).toBe('https://api.github.test/repos/Lens-Academy/lens-edu-production/pulls/8');

    const notMerged = serviceFor([prCreated(8), prState(true, 'clean'), answer(), jsonResponse({ merged: false })]);
    await expect(promote(notMerged.service)).resolves.toMatchObject({
      merge: 'open',
      warning: `${why} Open the pull request on GitHub to merge it.`,
    });
  });

  it.each([
    ['returns errors', jsonResponse({ errors: [{ message: 'Auto merge is not allowed for this repository' }] }), 'Auto merge is not allowed for this repository'],
    ['cannot be reached', new Error('network unavailable'), 'network unavailable'],
    [
      'returns malformed JSON',
      textResponse('not json', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      'GitHub would not turn on auto-merge',
    ],
    ['fails', jsonResponse({ message: 'Server Error' }, { status: 500 }), 'would not turn on auto-merge: Server Error (status 500). Open the pull request on GitHub to merge it.'],
  ])('leaves a blocked PR open with a warning when the auto-merge request %s', async (_name, answer, warning) => {
    const { service } = serviceFor([prCreated(7), prState(true, 'blocked'), answer]);
    await expect(promote(service)).resolves.toMatchObject({ merge: 'open', warning: expect.stringContaining(warning) });
  });

  it.each([
    ['fails', textResponse('rate limited', { status: 403 }), 403, 'rate limited'],
    ['cannot be reached', new Error('connection reset'), 502, 'connection reset'],
    [
      'returns malformed JSON',
      textResponse('not json', { status: 201, headers: { 'Content-Type': 'application/json' } }),
      502,
      'GitHub pull request creation returned invalid JSON',
    ],
  ])('throws PromotionError with github_failed when PR creation %s', async (_name, answer, status, message) => {
    const { service } = serviceFor([answer]);
    const thrown = await promotionError(service);
    expect(thrown).toBeInstanceOf(PromotionError);
    expect(thrown).toMatchObject({ status, code: 'github_failed', message: expect.stringContaining(message) });
  });

  it.each([
    { paths: ['one.md'], expectedTitle: 'Promote 1 course file' },
    { paths: ['one.md', 'two.md'], expectedTitle: 'Promote 2 course files' },
  ])('uses a sensible default title for $expectedTitle', async ({ paths, expectedTitle }) => {
    const { service, calls } = serviceFor([prCreated(11), prState(true, 'clean'), jsonResponse({ merged: true })]);
    await promote(service, paths);
    expect(calls[0].body).toMatchObject({ title: expectedTitle });
  });

  it('uses injected endpoints for every GitHub request', async () => {
    const { fetchImpl, calls } = createRecordingFetch([prCreated(13), prState(true, 'blocked'), autoMergeQueued()]);
    const service = createGitHubPromotionService(createConfig({ githubOwner: 'custom-owner', githubRepo: 'custom-repo' }), {
      apiBaseUrl: 'https://github.enterprise.test/api/v3/',
      graphqlUrl: 'https://github.enterprise.test/graphql',
      fetchImpl,
      sleep: async () => {},
    });

    await promote(service);

    expect(calls.map(call => call.url)).toEqual([
      'https://github.enterprise.test/api/v3/repos/custom-owner/custom-repo/pulls',
      'https://github.enterprise.test/api/v3/repos/custom-owner/custom-repo/pulls/13',
      'https://github.enterprise.test/graphql',
    ]);
  });
});
