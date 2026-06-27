import { relayHeaders } from './relay-api';

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

export interface PromotionPrResponse {
  branch: string;
  prNumber: number;
  prUrl: string;
  mainSha: string;
  autoMergeEnabled: boolean;
  warning?: string;
}

async function promotionRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);

  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string; code?: string } | null;
    throw new Error(body?.error || body?.code || `Promotion request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function getPromotionChanges(): Promise<PromotionChangesResponse> {
  return promotionRequest('/api/promotion/changes', {
    headers: relayHeaders(),
  });
}

export function getPromotionStatus(path: string): Promise<PromotionStatusResponse> {
  return promotionRequest(`/api/promotion/status?path=${encodeURIComponent(path)}`, {
    headers: relayHeaders(),
  });
}

export function getPromotionDiff(path: string): Promise<PromotionDiffResponse> {
  return promotionRequest(`/api/promotion/diff?path=${encodeURIComponent(path)}`, {
    headers: relayHeaders(),
  });
}

export function createPromotionPr(input: { paths: string[]; title?: string }): Promise<PromotionPrResponse> {
  const body = input.title === undefined
    ? { paths: input.paths }
    : { paths: input.paths, title: input.title };

  return promotionRequest('/api/promotion/pr', {
    method: 'POST',
    headers: relayHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
}
