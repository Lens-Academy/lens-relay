import { PromotionError, type PromotionConfig, type PromotionPrResponse } from './types.ts';

interface CreatePullRequestInput {
  branch: string;
  mainSha: string;
  sourceStagingSha: string;
  paths: string[];
  title?: string;
}

interface GitHubPromotionService {
  createPullRequest(input: CreatePullRequestInput): Promise<PromotionPrResponse>;
}

interface GitHubPromotionServiceOptions {
  apiBaseUrl?: string;
  graphqlUrl?: string;
  fetchImpl?: typeof fetch;
}

interface CreatePullRequestResponse {
  number?: unknown;
  html_url?: unknown;
  node_id?: unknown;
}

interface GraphQLErrorResponse {
  errors?: { message?: unknown }[];
}

const DEFAULT_API_BASE_URL = 'https://api.github.com';
const DEFAULT_GRAPHQL_URL = 'https://api.github.com/graphql';

export function createGitHubPromotionService(
  config: PromotionConfig,
  options: GitHubPromotionServiceOptions = {},
): GitHubPromotionService {
  const fetchGitHub = options.fetchImpl ?? fetch;
  const apiBaseUrl = trimTrailingSlash(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
  const graphqlUrl = options.graphqlUrl ?? DEFAULT_GRAPHQL_URL;

  async function createPullRequest(input: CreatePullRequestInput): Promise<PromotionPrResponse> {
    const pr = await createGitHubPullRequest(input);
    const autoMerge = await enableAutoMerge(pr.nodeId);

    return {
      branch: input.branch,
      prNumber: pr.number,
      prUrl: pr.url,
      mainSha: input.mainSha,
      autoMergeEnabled: autoMerge.enabled,
      ...(autoMerge.warning ? { warning: autoMerge.warning } : {}),
    };
  }

  async function createGitHubPullRequest(input: CreatePullRequestInput): Promise<{
    number: number;
    url: string;
    nodeId: string;
  }> {
    let response: Response;
    try {
      response = await fetchGitHub(`${apiBaseUrl}/repos/${encodeURIComponent(config.githubOwner)}/${encodeURIComponent(config.githubRepo)}/pulls`, {
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

  async function enableAutoMerge(pullRequestId: string): Promise<{ enabled: boolean; warning?: string }> {
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

      if (!response.ok) {
        return {
          enabled: false,
          warning: withResponseBody(
            `GitHub GraphQL auto-merge request failed with status ${response.status}`,
            await response.text(),
          ),
        };
      }

      const body = (await response.json()) as GraphQLErrorResponse;
      if (body.errors?.length) {
        return {
          enabled: false,
          warning: `GitHub GraphQL auto-merge request failed: ${formatGraphQLErrors(body.errors)}`,
        };
      }

      return { enabled: true };
    } catch (error) {
      return {
        enabled: false,
        warning: `GitHub GraphQL auto-merge request failed: ${errorMessage(error)}`,
      };
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
