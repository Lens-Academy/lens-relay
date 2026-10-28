import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Y from 'yjs';
import {
  checkRelayArticleUrls,
  createRelayAttachment,
  createRelayDoc,
  editRelayDoc,
  findRelayAttachmentByHash,
  RelayAttachmentConflictError,
  updateRelayDoc,
} from './relay-docs';

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

describe('checkRelayArticleUrls', () => {
  it('returns paths and stub contents from the duplicate-check response', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        found: {
          'https://example.com/a': '/articles/a.md',
          'https://example.com/b': '/articles/b.md',
        },
        stubs: {
          'https://example.com/a': {
            path: '/articles/a.md',
            content: '---\\ntags: [article-stub]\\n---\\n',
          },
          'https://example.com/b': null,
        },
      }),
    );

    const result = await checkRelayArticleUrls([
      'https://example.com/a',
      'https://example.com/b',
    ]);

    expect(result.found['https://example.com/b']).toBe('/articles/b.md');
    expect(result.stubs['https://example.com/a']?.path).toBe('/articles/a.md');
  });
});

describe('createRelayAttachment', () => {
  it('POSTs raw bytes and returns the relay reply', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { doc_id: 'r-u', uuid: 'u', path: 'Lens Edu/attachments/a.png', hash: 'h', created: true, overwritten: false })
    );
    const out = await createRelayAttachment('Lens Edu', '/attachments/a.png', new Uint8Array([1, 2]), 'image/png');
    expect(out).toEqual({ doc_id: 'r-u', uuid: 'u', path: 'Lens Edu/attachments/a.png', hash: 'h', created: true, overwritten: false });
    const [url, opts] = mockFetch.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/doc/attachment');
    expect(parsed.searchParams.get('folder')).toBe('Lens Edu');
    expect(parsed.searchParams.get('path')).toBe('/attachments/a.png');
    expect(parsed.searchParams.get('overwrite')).toBeNull();
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('image/png');
  });

  it('sends overwrite=true when asked', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { doc_id: 'r-u', uuid: 'u', path: 'p', hash: 'h2', created: false, overwritten: true })
    );
    const out = await createRelayAttachment('Lens Edu', '/attachments/a.png', new Uint8Array([1]), 'image/png', undefined, { overwrite: true });
    expect(out.overwritten).toBe(true);
    expect(new URL(mockFetch.mock.calls[0][0]).searchParams.get('overwrite')).toBe('true');
  });

  // Prevents: the importer treating "different bytes already at this path"
  // as success again (the pre-409 behaviour that aliased figures).
  it('throws RelayAttachmentConflictError with the existing hash on 409', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(409, { error: 'taken', existing_hash: 'abc123', incoming_hash: 'def' })
    );
    const err = await createRelayAttachment('Lens Edu', '/attachments/a.png', new Uint8Array([1]), 'image/png').catch((e) => e);
    expect(err).toBeInstanceOf(RelayAttachmentConflictError);
    expect(err.existingHash).toBe('abc123');
    expect(err.path).toBe('/attachments/a.png');
  });

  it('throws a plain error on other failures', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(500, 'boom'));
    await expect(createRelayAttachment('Lens Edu', '/attachments/a.png', new Uint8Array([1]), 'image/png')).rejects.toThrow(/500/);
  });
});

describe('findRelayAttachmentByHash', () => {
  it('returns the entry when found and null otherwise', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { found: true, path: '/attachments/a.png', uuid: 'u', doc_id: 'r-u', mimetype: 'image/png' }));
    const hit = await findRelayAttachmentByHash('Lens Edu', 'ab'.repeat(32));
    expect(hit).toEqual({ path: '/attachments/a.png', uuid: 'u', doc_id: 'r-u', mimetype: 'image/png' });
    const parsed = new URL(mockFetch.mock.calls[0][0]);
    expect(parsed.pathname).toBe('/doc/attachment/by-hash');
    expect(parsed.searchParams.get('sha256')).toBe('ab'.repeat(32));
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer test-token');

    mockFetch.mockResolvedValueOnce(jsonResponse(200, { found: false }));
    expect(await findRelayAttachmentByHash('Lens Edu', 'cd'.repeat(32))).toBeNull();
  });
});

// editRelayDoc: the CLI's way to change a check file as the editor does.
describe('editRelayDoc', () => {
  // A relay holding one document: auth, its state, and the updates posted to it.
  function relayWith(text: string) {
    const doc = new Y.Doc();
    doc.getText('contents').insert(0, text);
    const posted: Uint8Array[] = [];
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/auth')) return jsonResponse(200, { baseUrl: 'http://localhost:8090/d/x', token: 't' });
      if (url.endsWith('/as-update')) {
        const bytes = Y.encodeStateAsUpdate(doc);
        return { ok: true, status: 200, statusText: '', headers: new Headers(), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
      }
      if (url.endsWith('/update')) { posted.push(new Uint8Array(init!.body as Uint8Array)); return jsonResponse(200, ''); }
      throw new Error(`unexpected ${url}`);
    });
    return { doc, posted };
  }

  it('sends only the change, which applies cleanly to the relay\'s copy', async () => {
    const { doc, posted } = relayWith('enabled: false\nrest\n');
    const sent = await editRelayDoc('x', (d) => {
      const t = d.getText('contents');
      t.delete(9, 5); t.insert(9, 'true');
    });
    expect(sent).toBe(true);
    expect(posted).toHaveLength(1);
    Y.applyUpdate(doc, posted[0]);
    expect(doc.getText('contents').toString()).toBe('enabled: true\nrest\n');
  });

  it('sends nothing when the edit changes nothing, or says there is nothing to change', async () => {
    const { posted } = relayWith('same\n');
    expect(await editRelayDoc('x', () => {})).toBe(false);
    // An edit that registers its author but then finds no change must not leave the entry.
    expect(await editRelayDoc('x', () => false)).toBe(false);
    expect(posted).toHaveLength(0);
  });
});
