import { describe, it, expect } from 'vitest';
import { loadPromotionConfig, promotionConfigReady } from './config.ts';

describe('promotion config', () => {
  it('is disabled by default', () => {
    const config = loadPromotionConfig({});
    expect(config.enabled).toBe(false);
    expect(config.productionRepoUrl).toBe('');
    expect(config.stagingRepoUrl).toBe('');
    expect(config.mainBranch).toBe('main');
    expect(config.stagingBranch).toBe('staging');
    expect(config.branchPrefix).toBe('promote/lens-editor');
    expect(config.mergeMethod).toBe('SQUASH');
    expect(promotionConfigReady(config)).toBe(false);
  });

  it('requires all operational fields when enabled', () => {
    const config = loadPromotionConfig({ PROMOTION_ENABLED: 'true' });
    expect(config.enabled).toBe(true);
    expect(promotionConfigReady(config)).toBe(false);
  });

  it('does not allow the legacy single-repo Lens Edu promotion configuration', () => {
    const config = loadPromotionConfig({
      PROMOTION_ENABLED: 'true',
      PROMOTION_REPO_URL: 'git@github.com:Lens-Academy/lens-edu-relay.git',
      PROMOTION_REPO_DIR: '/tmp/lens-edu-relay',
      PROMOTION_GITHUB_OWNER: 'Lens-Academy',
      PROMOTION_GITHUB_REPO: 'lens-edu-relay',
      GITHUB_TOKEN: 'token',
    });

    expect(promotionConfigReady(config)).toBe(false);
  });

  it('is ready for separate Lens Edu staging and production repositories', () => {
    const config = loadPromotionConfig({
      PROMOTION_ENABLED: 'true',
      PROMOTION_PRODUCTION_REPO_URL: 'git@github.com:Lens-Academy/lens-edu-production.git',
      PROMOTION_STAGING_REPO_URL: 'git@github.com:Lens-Academy/lens-edu-staging.git',
      PROMOTION_REPO_DIR: '/tmp/lens-edu-production',
      PROMOTION_MAIN_BRANCH: 'production',
      PROMOTION_GITHUB_OWNER: 'Lens-Academy',
      PROMOTION_GITHUB_REPO: 'lens-edu-production',
      GITHUB_TOKEN: 'token',
    });

    expect(config.repoUrl).toBe('git@github.com:Lens-Academy/lens-edu-production.git');
    expect(config.productionRepoUrl).toBe('git@github.com:Lens-Academy/lens-edu-production.git');
    expect(config.stagingRepoUrl).toBe('git@github.com:Lens-Academy/lens-edu-staging.git');
    expect(promotionConfigReady(config)).toBe(true);
  });

  it('does not allow the legacy single-repo SSH host alias for Lens Edu promotion', () => {
    const config = loadPromotionConfig({
      PROMOTION_ENABLED: 'true',
      PROMOTION_REPO_URL: 'git@github.com-lens-editor-promotion:Lens-Academy/lens-edu-relay.git',
      PROMOTION_REPO_DIR: '/data/lens-editor/promotion-repos/lens-edu-relay',
      PROMOTION_GITHUB_OWNER: 'Lens-Academy',
      PROMOTION_GITHUB_REPO: 'lens-edu-relay',
      GITHUB_TOKEN: 'token',
    });

    expect(promotionConfigReady(config)).toBe(false);
  });

  it('accepts documented SSH host aliases for separate Lens Edu repositories', () => {
    const config = loadPromotionConfig({
      PROMOTION_ENABLED: 'true',
      PROMOTION_PRODUCTION_REPO_URL: 'git@github.com-lens-editor-promotion:Lens-Academy/lens-edu-production.git',
      PROMOTION_STAGING_REPO_URL: 'git@github.com-lens-editor-promotion:Lens-Academy/lens-edu-staging.git',
      PROMOTION_REPO_DIR: '/data/lens-editor/promotion-repos/lens-edu-production',
      PROMOTION_MAIN_BRANCH: 'production',
      PROMOTION_GITHUB_OWNER: 'Lens-Academy',
      PROMOTION_GITHUB_REPO: 'lens-edu-production',
      GITHUB_TOKEN: 'token',
    });

    expect(promotionConfigReady(config)).toBe(true);
  });

  it('is not ready when configured for a non-Lens-Edu repository or branch', () => {
    const baseEnv = {
      PROMOTION_ENABLED: 'true',
      PROMOTION_PRODUCTION_REPO_URL: 'git@github.com:Lens-Academy/lens-edu-production.git',
      PROMOTION_STAGING_REPO_URL: 'git@github.com:Lens-Academy/lens-edu-staging.git',
      PROMOTION_REPO_DIR: '/tmp/lens-edu-production',
      PROMOTION_MAIN_BRANCH: 'production',
      PROMOTION_GITHUB_OWNER: 'Lens-Academy',
      PROMOTION_GITHUB_REPO: 'lens-edu-production',
      GITHUB_TOKEN: 'token',
    };

    expect(promotionConfigReady(loadPromotionConfig({
      ...baseEnv,
      PROMOTION_PRODUCTION_REPO_URL: 'git@github.com:Lens-Academy/lens-relay.git',
    }))).toBe(false);
    expect(promotionConfigReady(loadPromotionConfig({
      ...baseEnv,
      PROMOTION_GITHUB_REPO: 'lens-relay',
    }))).toBe(false);
    expect(promotionConfigReady(loadPromotionConfig({
      ...baseEnv,
      PROMOTION_STAGING_BRANCH: 'main',
    }))).toBe(false);
    expect(promotionConfigReady(loadPromotionConfig({
      ...baseEnv,
      PROMOTION_GITHUB_REPO: 'lens-edu-relay',
    }))).toBe(false);
  });

  it('defaults invalid branch and branch prefix values', () => {
    const config = loadPromotionConfig({
      PROMOTION_MAIN_BRANCH: '',
      PROMOTION_STAGING_BRANCH: ' ',
      PROMOTION_BRANCH_PREFIX: '',
    });

    expect(config.mainBranch).toBe('main');
    expect(config.stagingBranch).toBe('staging');
    expect(config.branchPrefix).toBe('promote/lens-editor');
  });

  it('does not treat whitespace operational fields as ready', () => {
    const config = loadPromotionConfig({
      PROMOTION_ENABLED: 'true',
      PROMOTION_PRODUCTION_REPO_URL: ' ',
      PROMOTION_STAGING_REPO_URL: 'git@github.com:Lens-Academy/lens-edu-staging.git',
      PROMOTION_REPO_DIR: '/tmp/lens-edu-production',
      PROMOTION_MAIN_BRANCH: 'production',
      PROMOTION_GITHUB_OWNER: 'Lens-Academy',
      PROMOTION_GITHUB_REPO: 'lens-edu-production',
      GITHUB_TOKEN: 'token',
    });

    expect(promotionConfigReady(config)).toBe(false);
  });

  it('defaults merge method to SQUASH and accepts configured methods', () => {
    expect(loadPromotionConfig({ PROMOTION_MERGE_METHOD: 'BOGUS' }).mergeMethod).toBe('SQUASH');
    expect(loadPromotionConfig({ PROMOTION_MERGE_METHOD: 'MERGE' }).mergeMethod).toBe('MERGE');
    expect(loadPromotionConfig({ PROMOTION_MERGE_METHOD: 'REBASE' }).mergeMethod).toBe('REBASE');
  });
});
