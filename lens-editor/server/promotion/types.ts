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

export interface PromotionPrResponse {
  branch: string;
  prNumber: number;
  prUrl: string;
  mainSha: string;
  autoMergeEnabled: boolean;
  warning?: string;
}

export interface PromotionConfig {
  enabled: boolean;
  repoUrl: string;
  repoDir: string;
  mainBranch: string;
  stagingBranch: string;
  branchPrefix: string;
  mergeMethod: 'SQUASH' | 'MERGE' | 'REBASE';
  githubOwner: string;
  githubRepo: string;
  githubToken: string;
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
