import { describe, it, expect, vi, afterEach } from 'vitest';
import { applySuggestionActionsViaServer } from './suggestion-actions';
import type { SuggestionItem } from '../hooks/useSuggestions';

function makeSuggestion(overrides: Partial<SuggestionItem> & { type: SuggestionItem['type'] }): SuggestionItem {
  return {
    content: '',
    old_content: null,
    new_content: null,
    author: null,
    timestamp: null,
    from: 0,
    to: 0,
    raw_markup: '',
    context_before: '',
    context_after: '',
    ...overrides,
  };
}

describe('applySuggestionActionsViaServer', () => {
  const docId = 'relay-1234-doc-5678';
  const folderId = 'relay-1234-folder-9abc';
  const sub = makeSuggestion({
    type: 'substitution',
    old_content: 'hello',
    new_content: 'goodbye',
    raw_markup: '{~~{"author":"AI"}@@hello~>goodbye~~}',
    from: 4,
  });
  const add = makeSuggestion({
    type: 'addition',
    content: 'world',
    raw_markup: '{++{"author":"AI"}@@world++}',
    from: 42,
  });

  function mockFetch(body: unknown, status = 200) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.removeItem('lens-share-token');
  });

  it('POSTs the apply contract and maps response indices back to SuggestionItems', async () => {
    const fetchMock = mockFetch({
      applied: [1],
      failed: [{ index: 0, reason: 'markup not found' }],
      remaining_suggestions: 3,
    });
    localStorage.setItem('lens-share-token', 'tok-123');

    const result = await applySuggestionActionsViaServer(docId, folderId, [sub, add], 'accept');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/relay/suggestions/apply?folder_id=${encodeURIComponent(folderId)}`);
    expect(init.method).toBe('POST');
    expect(init.headers['X-Share-Token']).toBe('tok-123');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({
      doc_id: docId,
      action: 'accept',
      suggestions: [
        {
          raw_markup: sub.raw_markup,
          type: 'substitution',
          content: sub.content,
          old_content: 'hello',
          new_content: 'goodbye',
        },
        {
          raw_markup: add.raw_markup,
          type: 'addition',
          content: 'world',
          old_content: null,
          new_content: null,
        },
      ],
    });

    expect(result.applied).toEqual([add]);
    expect(result.failed).toEqual([sub]);
  });

  it('omits X-Share-Token when no token is stored', async () => {
    const fetchMock = mockFetch({ applied: [0], failed: [], remaining_suggestions: 0 });

    await applySuggestionActionsViaServer(docId, folderId, [add], 'reject');

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['X-Share-Token']).toBeUndefined();
    expect(JSON.parse(init.body).action).toBe('reject');
  });

  it('returns an empty result without fetching for an empty batch', async () => {
    const fetchMock = mockFetch({ applied: [], failed: [], remaining_suggestions: 0 });

    const result = await applySuggestionActionsViaServer(docId, folderId, [], 'accept');

    expect(result).toEqual({ applied: [], failed: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on a non-ok response so callers keep the whole file visible for retry', async () => {
    mockFetch({ error: 'boom' }, 502);

    await expect(applySuggestionActionsViaServer(docId, folderId, [add], 'accept'))
      .rejects.toThrow('Failed to apply suggestions: 502');
  });

  it('ignores out-of-range indices in the response', async () => {
    mockFetch({
      applied: [0, 7],
      failed: [{ index: -1, reason: 'nope' }, { index: 1, reason: 'markup not found' }],
      remaining_suggestions: 1,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await applySuggestionActionsViaServer(docId, folderId, [sub, add], 'accept');

    expect(result.applied).toEqual([sub]);
    expect(result.failed).toEqual([add]);
    warn.mockRestore();
  });
});
