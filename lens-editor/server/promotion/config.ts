import type { PromotionConfig } from './types.ts';

export function loadPromotionConfig(env: NodeJS.ProcessEnv = process.env): PromotionConfig {
  return {
    enabled: env.PROMOTION_ENABLED === 'true',
    repoUrl: readEnvString(env.PROMOTION_REPO_URL),
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
