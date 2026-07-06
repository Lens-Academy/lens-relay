import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRelayDoc, updateRelayDoc } from './relay-docs';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  vi.stubEnv('RELAY_URL', 'http://localhost:8090');
  vi.stubEnv('RELAY_SERVER_TOKEN', 'test-token');
  mockFetch.mockReset();
});

/** Minimal Response stand-in for fetchBytesWithTimeout (reads arrayBuffer). */
function jsonResponse(status: number, payload: unknown) {
  const bytes = new TextEncoder().encode(
    typeof payload === 'string' ? payload : JSON.stringify(payload)
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: new Headers(),
    arrayBuffer: async () => bytes.buffer,
  };
}

function mockUpsertSuccess(created: boolean) {
  mockFetch.mockResolvedValueOnce(
    jsonResponse(200, {
      doc_id: 'test-doc-id',
      path: 'Lens Edu/video_transcripts/test.md',
      created,
    })
  );
}

describe('createRelayDoc', () => {
  it('calls POST /doc/upsert with folder and path', async () => {
    mockUpsertSuccess(true);

    await createRelayDoc('Lens Edu/video_transcripts/test.md', '# Hello');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:8090/doc/upsert');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer test-token');

    const body = JSON.parse(opts.body);
    expect(body.folder).toBe('Lens Edu');
    expect(body.path).toBe('/video_transcripts/test.md');
    expect(body.content).toBe('# Hello');
  });

  it('works with .json files', async () => {
    mockUpsertSuccess(true);

    await createRelayDoc(
      'Lens Edu/video_transcripts/test.timestamps.json',
      '[{"text":"hello","start":"0:00.00"}]'
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.path).toBe('/video_transcripts/test.timestamps.json');
  });

  it('throws on 409 conflict for .json files', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(409, 'Path already exists'));

    await expect(
      createRelayDoc(
        'Lens Edu/video_transcripts/test.timestamps.json',
        '[{"text":"hello","start":"0:00.00"}]'
      )
    ).rejects.toThrow('Relay upsert failed: 409');
  });
});

describe('updateRelayDoc', () => {
  it('calls POST /doc/upsert with new content (ignores oldContent)', async () => {
    mockUpsertSuccess(false);

    await updateRelayDoc(
      'Lens Edu/video_transcripts/test.md',
      'Old content',
      'New content'
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.content).toBe('New content');
  });
});
