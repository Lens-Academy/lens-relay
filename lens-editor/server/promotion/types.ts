export type PromotionFileStatus = 'identical' | 'modified' | 'added' | 'deleted' | 'renamed';

export interface PromotionFileChange {
  path: string;
  oldPath: string | null;
  status: PromotionFileStatus;
  additions: number;
  deletions: number;
  isBinary: boolean;
}

export interface PromotionChangesResponse {
  mainSha: string;
  generatedAt: string;
  files: PromotionFileChange[];
  curriculum: PromotionCurriculumIndex;
}

export interface PromotionCurriculumMembership {
  coursePaths: string[];
  modulePaths: string[];
}

export interface PromotionCurriculumIndex {
  courses: Array<{ path: string; label: string; modulePaths: string[] }>;
  modules: Array<{ path: string; label: string; coursePaths: string[] }>;
  memberships: Record<string, PromotionCurriculumMembership>;
}

export interface PromotionStatusResponse extends PromotionFileChange {
  mainSha: string;
}

export interface PromotionDiffResponse {
  path: string;
  mainSha: string;
  status: PromotionFileStatus;
  isBinary: boolean;
  beforeBlob?: { oid: string; size: number } | null;
  afterBlob?: { oid: string; size: number } | null;
  diff: string;
}

export interface PromotionPrRequest {
  paths: string[];
  title?: string;
}

/**
 * What happened to a promotion's PR: `merged` into production at once,
 * `auto-merge` queued because the branch still requires a check, or still
 * `open` for a person to merge (the response's `warning` says why).
 */
export type PromotionMerge = 'merged' | 'auto-merge' | 'open';

export interface PromotionPrResponse {
  branch: string;
  prNumber: number;
  prUrl: string;
  mainSha: string;
  merge: PromotionMerge;
  /** Why the PR is still open, or why GitHub would not take auto-merge. */
  warning?: string;
}

/** A branch the editor pushed to production's repository, ready for its pull request. */
export interface PromotionBranch {
  branch: string;
  /** Production's head when the branch was made from it. */
  mainSha: string;
  sourceStagingSha: string;
  /** The commit the editor pushed: the merge takes this commit and no other. */
  headSha: string;
}

export interface PromotionConfig {
  enabled: boolean;
  repoUrl: string;
  productionRepoUrl: string;
  stagingRepoUrl: string;
  repoDir: string;
  mainBranch: string;
  stagingBranch: string;
  branchPrefix: string;
  mergeMethod: 'SQUASH' | 'MERGE' | 'REBASE';
  githubOwner: string;
  githubRepo: string;
  githubToken: string;
  /** Minimum ms between remote git fetches for read endpoints. Default 30s. */
  fetchMinIntervalMs?: number;
}

export class PromotionError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = 'PromotionError';
  }
}
