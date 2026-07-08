import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPromotionPr,
  getPromotionChanges,
  getPromotionDiff,
  getPromotionStatus,
  type PromotionPrResponse,
} from './promotion-api';

const mockFetch = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', mockFetch);

type Assert<T extends true> = T;
type HasNoSourceStagingSha = Assert<'sourceStagingSha' extends keyof PromotionPrResponse ? false : true>;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('promotion-api', () => {
  beforeEach(() => {
    localStorage.clear();
    mockFetch.mockReset();
  });

  it('adds X-Share-Token header when fetching changes', async () => {
    localStorage.setItem('lens-share-token', 'share-token');
    const response = {
      mainSha: 'main-sha',
      generatedAt: '2026-06-27T00:00:00.000Z',
      files: [],
    };
    mockFetch.mockResolvedValueOnce(jsonResponse(response));

    await expect(getPromotionChanges()).resolves.toEqual(response);

    expect(mockFetch).toHaveBeenCalledWith('/api/promotion/changes', {
      headers: { 'X-Share-Token': 'share-token' },
    });
  });

  it('URL-encodes path when fetching status', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      path: 'Lessons/One & Two.md',
      oldPath: null,
      status: 'modified',
      additions: 2,
      deletions: 1,
      isBinary: false,
      mainSha: 'main-sha',
    }));

    await getPromotionStatus('Lessons/One & Two.md');

    expect(mockFetch).toHaveBeenCalledWith('/api/promotion/status?path=Lessons%2FOne%20%26%20Two.md', {
      headers: {},
    });
  });

  it('URL-encodes path when fetching diff', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      path: 'Nested/#Plan?.md',
      mainSha: 'main-sha',
      status: 'modified',
      isBinary: false,
      beforeBlob: null,
      afterBlob: { oid: 'after', size: 42 },
      diff: '@@ diff',
    }));

    await getPromotionDiff('Nested/#Plan?.md');

    expect(mockFetch).toHaveBeenCalledWith('/api/promotion/diff?path=Nested%2F%23Plan%3F.md', {
      headers: {},
    });
  });

  it('posts selected paths and omits undefined title', async () => {
    localStorage.setItem('lens-share-token', 'share-token');
    const response: PromotionPrResponse = {
      branch: 'promote/one',
      prNumber: 12,
      prUrl: 'https://github.example/pr/12',
      mainSha: 'main-sha',
      autoMergeEnabled: true,
    };
    mockFetch.mockResolvedValueOnce(jsonResponse(response));

    await expect(createPromotionPr({ paths: ['A.md', 'B.md'], title: undefined })).resolves.toEqual(response);

    expect(mockFetch).toHaveBeenCalledWith('/api/promotion/pr', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Share-Token': 'share-token',
      },
      body: JSON.stringify({ paths: ['A.md', 'B.md'] }),
    });
  });

  it('posts title when provided', async () => {
    const response: PromotionPrResponse = {
      branch: 'promote/titled',
      prNumber: 13,
      prUrl: 'https://github.example/pr/13',
      mainSha: 'main-sha',
      autoMergeEnabled: false,
      warning: 'Auto-merge unavailable',
    };
    mockFetch.mockResolvedValueOnce(jsonResponse(response));

    await createPromotionPr({ paths: ['A.md'], title: 'Promote A' });

    expect(mockFetch).toHaveBeenCalledWith('/api/promotion/pr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['A.md'], title: 'Promote A' }),
    });
  });

  it('throws useful message from non-ok JSON error response', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'No paths selected', code: 'empty_paths' }, { status: 400 }));

    await expect(createPromotionPr({ paths: [] })).rejects.toThrow('No paths selected');
  });

  it('throws fallback message from non-ok non-JSON error response', async () => {
    mockFetch.mockResolvedValueOnce(new Response('upstream unavailable', { status: 503 }));

    await expect(getPromotionChanges()).rejects.toThrow('Promotion request failed: 503');
  });

  it('PR response type and shape do not include sourceStagingSha', () => {
    const response: PromotionPrResponse = {
      branch: 'promote/no-sha',
      prNumber: 14,
      prUrl: 'https://github.example/pr/14',
      mainSha: 'main-sha',
      autoMergeEnabled: true,
    };
    const _typeCheck: HasNoSourceStagingSha = true;

    expect(_typeCheck).toBe(true);
    expect(response).not.toHaveProperty('sourceStagingSha');
  });
});
