import { describe, it, expect } from 'vitest';
import { loadPromotionConfig, promotionConfigReady } from './config.ts';

describe('promotion config', () => {
  it('is disabled by default', () => {
    const config = loadPromotionConfig({});
    expect(config.enabled).toBe(false);
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

  it('is ready when enabled and all operational fields are present', () => {
    const config = loadPromotionConfig({
      PROMOTION_ENABLED: 'true',
      PROMOTION_REPO_URL: 'git@github.com:Lens-Academy/lens-edu-relay.git',
      PROMOTION_REPO_DIR: '/tmp/lens-edu-relay',
      PROMOTION_GITHUB_OWNER: 'Lens-Academy',
      PROMOTION_GITHUB_REPO: 'lens-edu-relay',
      GITHUB_TOKEN: 'token',
    });

    expect(promotionConfigReady(config)).toBe(true);
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
      PROMOTION_REPO_URL: ' ',
      PROMOTION_REPO_DIR: '/tmp/lens-edu-relay',
      PROMOTION_GITHUB_OWNER: 'Lens-Academy',
      PROMOTION_GITHUB_REPO: 'lens-edu-relay',
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
