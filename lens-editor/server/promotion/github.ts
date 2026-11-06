import {
  PromotionError,
  type PromotionBranch,
  type PromotionConfig,
  type PromotionMerge,
  type PromotionPrResponse,
} from './types.ts';

type CreatePullRequestInput = PromotionBranch & { paths: string[]; title?: string };

interface GitHubPromotionService {
  createPullRequest(input: CreatePullRequestInput): Promise<PromotionPrResponse>;
}

interface GitHubPromotionServiceOptions {
  apiBaseUrl?: string;
  graphqlUrl?: string;
  fetchImpl?: typeof fetch;
  /** Waits between checks on a new PR; tests pass one that returns at once. */
  sleep?: (ms: number) => Promise<void>;
}

interface CreatePullRequestResponse {
  number?: unknown;
  html_url?: unknown;
  node_id?: unknown;
}

interface CreatedPullRequest {
  number: number;
  url: string;
  nodeId: string;
}

interface PullRequestState {
  mergeable?: unknown;
  mergeable_state?: unknown;
  merged?: unknown;
}

interface MergeResult {
  merge: PromotionMerge;
  warning?: string;
}

interface GraphQLErrorResponse {
  errors?: { message?: unknown }[];
}

const DEFAULT_API_BASE_URL = 'https://api.github.com';
const DEFAULT_GRAPHQL_URL = 'https://api.github.com/graphql';

// Each GitHub call gives up after this, so a hung one cannot leave the person
// on "Promoting..." for ever. Reads of the PR get less: there can be six of
// them, and the whole request must end inside the Cloudflare tunnel's 100 s.
const REQUEST_TIMEOUT_MS = 15_000;
const READ_TIMEOUT_MS = 5_000;

// GitHub works out in the background whether a new PR can merge, and reports
// `mergeable: null` until it has. These are the waits before each new look;
// they add up to 7.5 s, after which the merge is tried anyway.
const MERGEABLE_WAITS_MS = [500, 1000, 2000, 2000, 2000];

const OPEN_IT = 'Open the pull request on GitHub to merge it.';

export function createGitHubPromotionService(
  config: PromotionConfig,
  options: GitHubPromotionServiceOptions = {},
): GitHubPromotionService {
  const fetchImpl = options.fetchImpl ?? fetch;
  const fetchGitHub = (url: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS) =>
    fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const apiBaseUrl = trimTrailingSlash(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
  const graphqlUrl = options.graphqlUrl ?? DEFAULT_GRAPHQL_URL;
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const pullsUrl = `${apiBaseUrl}/repos/${encodeURIComponent(config.githubOwner)}/${encodeURIComponent(config.githubRepo)}/pulls`;

  async function createPullRequest(input: CreatePullRequestInput): Promise<PromotionPrResponse> {
    const pr = await createGitHubPullRequest(input);
    const result = await mergeOrQueue(pr, input.headSha);

    return {
      branch: input.branch,
      prNumber: pr.number,
      prUrl: pr.url,
      mainSha: input.mainSha,
      merge: result.merge,
      ...(result.warning ? { warning: result.warning } : {}),
    };
  }

  /**
   * Merges the PR at once when GitHub allows it, and asks for auto-merge only
   * when the branch still requires something (`blocked`). GitHub refuses
   * auto-merge for a PR that can merge at once, because there is nothing to
   * wait for: so on a branch that requires no checks, auto-merge alone left
   * every promotion open until a person merged it.
   */
  async function mergeOrQueue(pr: CreatedPullRequest, headSha: string): Promise<MergeResult> {
    const state = await mergeableState(pr.number);
    if (state === 'dirty') {
      return {
        merge: 'open',
        warning: 'GitHub did not merge the pull request: it conflicts with production. Open it on GitHub to resolve the conflict.',
      };
    }
    if (state === 'behind') {
      // Auto-merge would wait for ever: GitHub does not bring the branch up to date itself.
      return {
        merge: 'open',
        warning: 'GitHub did not merge the pull request: production requires the branch to be up to date first. Open the pull request on GitHub and update its branch.',
      };
    }
    if (state === 'blocked') return enableAutoMerge(pr.nodeId);
    return mergePullRequest(pr.number, headSha);
  }

  /**
   * The PR's `mergeable_state`, or 'dirty' whenever GitHub says it cannot
   * merge, or 'unknown' if GitHub has not worked it out after every wait.
   */
  async function mergeableState(prNumber: number): Promise<string> {
    for (const wait of MERGEABLE_WAITS_MS) {
      await sleep(wait);
      const pr = await readPullRequest(prNumber);
      if (pr?.mergeable === false) return 'dirty';
      if (pr?.mergeable === true && typeof pr.mergeable_state === 'string' && pr.mergeable_state !== 'unknown') {
        return pr.mergeable_state;
      }
    }
    return 'unknown';
  }

  /** The PR as GitHub reports it now, or null when GitHub cannot say. */
  async function readPullRequest(prNumber: number): Promise<PullRequestState | null> {
    try {
      const response = await fetchGitHub(`${pullsUrl}/${prNumber}`, { headers: restHeaders() }, READ_TIMEOUT_MS);
      return response.ok ? ((await response.json()) as PullRequestState) : null;
    } catch {
      return null;
    }
  }

  async function mergePullRequest(prNumber: number, headSha: string): Promise<MergeResult> {
    let response: Response;
    try {
      response = await fetchGitHub(`${pullsUrl}/${prNumber}/merge`, {
        method: 'PUT',
        headers: restHeaders(),
        // `sha`: merge only the commit the editor pushed, not anything added to the branch since.
        body: JSON.stringify({ merge_method: config.mergeMethod.toLowerCase(), sha: headSha }),
      });
    } catch (error) {
      return mergedAfterAll(prNumber, `The merge request to GitHub failed: ${errorMessage(error)}.`);
    }
    if (!response.ok) {
      const reason = `GitHub did not merge the pull request: ${githubMessage(await response.text().catch(() => ''), response.status)}`;
      // A 5xx can come after GitHub merged, so look before saying it did not.
      return response.status >= 500 ? mergedAfterAll(prNumber, reason) : { merge: 'open', warning: `${reason} ${OPEN_IT}` };
    }
    const body = (await response.json().catch(() => null)) as { merged?: unknown } | null;
    if (body?.merged === true) return { merge: 'merged' };
    return mergedAfterAll(prNumber, 'GitHub answered the merge request without saying that the pull request merged.');
  }

  /** After a merge request with no clear answer: whether GitHub merged the PR all the same. */
  async function mergedAfterAll(prNumber: number, why: string): Promise<MergeResult> {
    const pr = await readPullRequest(prNumber);
    return pr?.merged === true ? { merge: 'merged' } : { merge: 'open', warning: `${why} ${OPEN_IT}` };
  }

  async function createGitHubPullRequest(input: CreatePullRequestInput): Promise<CreatedPullRequest> {
    let response: Response;
    try {
      response = await fetchGitHub(pullsUrl, {
        method: 'POST',
        headers: restHeaders(),
        body: JSON.stringify({
          title: input.title ?? defaultTitle(input.paths),
          head: input.branch,
          base: config.mainBranch,
          maintainer_can_modify: true,
          body: createPullRequestBody(input),
        }),
      });
    } catch (error) {
      throw new PromotionError(
        502,
        `GitHub pull request creation request failed: ${errorMessage(error)}`,
        'github_failed',
      );
    }

    if (!response.ok) {
      throw new PromotionError(
        response.status,
        withResponseBody(`GitHub pull request creation failed with status ${response.status}`, await response.text()),
        'github_failed',
      );
    }

    let body: CreatePullRequestResponse;
    try {
      body = (await response.json()) as CreatePullRequestResponse;
    } catch (error) {
      throw new PromotionError(
        502,
        `GitHub pull request creation returned invalid JSON: ${errorMessage(error)}`,
        'github_failed',
      );
    }

    if (typeof body.number !== 'number' || typeof body.html_url !== 'string' || typeof body.node_id !== 'string') {
      throw new PromotionError(502, 'GitHub pull request creation returned an unexpected response', 'github_failed');
    }

    return {
      number: body.number,
      url: body.html_url,
      nodeId: body.node_id,
    };
  }

  /** Production still requires something: ask GitHub to merge the PR once it is met. */
  async function enableAutoMerge(pullRequestId: string): Promise<MergeResult> {
    const notQueued = (why: string): MergeResult => ({
      merge: 'open',
      warning: `Production requires a check or review first, and GitHub would not turn on auto-merge: ${why} ${OPEN_IT}`,
    });
    try {
      const response = await fetchGitHub(graphqlUrl, {
        method: 'POST',
        headers: graphqlHeaders(),
        body: JSON.stringify({
          query: enableAutoMergeMutation(),
          variables: {
            pullRequestId,
            mergeMethod: config.mergeMethod,
          },
        }),
      });
      if (!response.ok) return notQueued(githubMessage(await response.text().catch(() => ''), response.status));

      const body = (await response.json()) as GraphQLErrorResponse;
      if (body.errors?.length) return notQueued(`${formatGraphQLErrors(body.errors)}.`);
      return { merge: 'auto-merge' };
    } catch (error) {
      return notQueued(`${errorMessage(error)}.`);
    }
  }

  function restHeaders(): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${config.githubToken}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  function graphqlHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${config.githubToken}`,
      'Content-Type': 'application/json',
    };
  }

  return { createPullRequest };
}

function createPullRequestBody(input: CreatePullRequestInput): string {
  return [
    'Created by Lens Editor production promotion.',
    '',
    `Source staging commit: ${input.sourceStagingSha}`,
    `Base main commit at branch creation: ${input.mainSha}`,
    '',
    'Promoted files:',
    ...input.paths.map(filePath => `- \`${filePath}\``),
  ].join('\n');
}

function defaultTitle(paths: string[]): string {
  const count = paths.length;
  return `Promote ${count} course ${count === 1 ? 'file' : 'files'}`;
}

function enableAutoMergeMutation(): string {
  return `
    mutation EnablePromotionAutoMerge($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
      enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod }) {
        pullRequest {
          id
        }
      }
    }
  `;
}

function formatGraphQLErrors(errors: { message?: unknown }[]): string {
  return errors
    .map(error => (typeof error.message === 'string' ? error.message : 'Unknown GraphQL error'))
    .join('; ');
}

/** GitHub's own words from an error answer: its JSON `message`, else the text, with the status. */
function githubMessage(body: string, status: number): string {
  try {
    const message = (JSON.parse(body) as { message?: unknown }).message;
    if (typeof message === 'string' && message) return `${message.replace(/\.$/, '')} (status ${status}).`;
  } catch {
    // Not JSON: use the text as it is.
  }
  return body.trim() ? `${body.trim()} (status ${status}).` : `status ${status}.`;
}

function withResponseBody(message: string, body: string): string {
  const trimmedBody = body.trim();
  return trimmedBody ? `${message}: ${trimmedBody}` : message;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
