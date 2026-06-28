import type { PromotionConfig } from './types.ts';

const LENS_EDU_GITHUB_OWNER = 'Lens-Academy';
const LENS_EDU_STAGING_GITHUB_REPO = 'lens-edu-staging';
const LENS_EDU_PRODUCTION_GITHUB_REPO = 'lens-edu-production';
const LENS_EDU_PRODUCTION_BRANCH = 'production';
const LENS_EDU_STAGING_BRANCH = 'staging';

export function loadPromotionConfig(env: NodeJS.ProcessEnv = process.env): PromotionConfig {
  const productionRepoUrl = readEnvString(env.PROMOTION_PRODUCTION_REPO_URL);
  const stagingRepoUrl = readEnvString(env.PROMOTION_STAGING_REPO_URL);
  return {
    enabled: env.PROMOTION_ENABLED === 'true',
    repoUrl: productionRepoUrl,
    productionRepoUrl,
    stagingRepoUrl,
    repoDir: readEnvString(env.PROMOTION_REPO_DIR),
    mainBranch: readEnvStringWithDefault(env.PROMOTION_MAIN_BRANCH, 'main'),
    stagingBranch: readEnvStringWithDefault(env.PROMOTION_STAGING_BRANCH, 'staging'),
    branchPrefix: readEnvStringWithDefault(env.PROMOTION_BRANCH_PREFIX, 'promote/lens-editor'),
    mergeMethod: parseMergeMethod(env.PROMOTION_MERGE_METHOD),
    githubOwner: readEnvString(env.PROMOTION_GITHUB_OWNER),
    githubRepo: readEnvString(env.PROMOTION_GITHUB_REPO),
    githubToken: readEnvString(env.GITHUB_TOKEN),
  };
}

export function promotionConfigReady(config: PromotionConfig): boolean {
  if (!config.enabled) return false;

  return Boolean(
    config.productionRepoUrl &&
      config.stagingRepoUrl &&
      config.repoDir &&
      config.mainBranch &&
      config.stagingBranch &&
      config.branchPrefix &&
      config.mergeMethod &&
      config.githubOwner &&
      config.githubRepo &&
      config.githubToken &&
      config.githubOwner === LENS_EDU_GITHUB_OWNER &&
      promotionReposTargetLensEdu(config) &&
      promotionBranchesTargetLensEdu(config) &&
      config.stagingBranch === LENS_EDU_STAGING_BRANCH,
  );
}

function promotionReposTargetLensEdu(config: PromotionConfig): boolean {
  if (config.githubRepo === LENS_EDU_PRODUCTION_GITHUB_REPO) {
    return repoUrlTargetsGitHubRepo(config.productionRepoUrl, LENS_EDU_PRODUCTION_GITHUB_REPO) &&
      repoUrlTargetsGitHubRepo(config.stagingRepoUrl, LENS_EDU_STAGING_GITHUB_REPO);
  }

  return false;
}

function promotionBranchesTargetLensEdu(config: PromotionConfig): boolean {
  if (config.githubRepo === LENS_EDU_PRODUCTION_GITHUB_REPO) {
    return config.mainBranch === LENS_EDU_PRODUCTION_BRANCH;
  }
  return false;
}

function repoUrlTargetsGitHubRepo(repoUrl: string, repo: string): boolean {
  return repoUrl.endsWith(`:${LENS_EDU_GITHUB_OWNER}/${repo}.git`) ||
    repoUrl === `https://github.com/${LENS_EDU_GITHUB_OWNER}/${repo}.git`;
}

function parseMergeMethod(value: string | undefined): PromotionConfig['mergeMethod'] {
  const normalized = readEnvString(value);
  if (normalized === 'MERGE' || normalized === 'REBASE' || normalized === 'SQUASH') return normalized;
  return 'SQUASH';
}

function readEnvString(value: string | undefined): string {
  return value?.trim() ?? '';
}

function readEnvStringWithDefault(value: string | undefined, fallback: string): string {
  const normalized = readEnvString(value);
  return normalized || fallback;
}
