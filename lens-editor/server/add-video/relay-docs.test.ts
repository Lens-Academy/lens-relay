import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRelayDoc, updateRelayDoc } from './relay-docs';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  vi.stubEnv('RELAY_URL', 'http://localhost:8090');
  vi.stubEnv('RELAY_SERVER_TOKEN', 'test-token');
  mockFetch.mockReset();
});

describe('createRelayDoc', () => {
  it('calls relay MCP create tool with correct params', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: 'Created Lens Edu/video_transcripts/test.md' }] },
      }),
    });

    await createRelayDoc('Lens Edu/video_transcripts/test.md', '# Hello');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:8090/mcp');
    const body = JSON.parse(opts.body);
    expect(body.method).toBe('tools/call');
    expect(body.params.name).toBe('create');
    expect(body.params.arguments.file_path).toBe('Lens Edu/video_transcripts/test.md');
  });
});

describe('updateRelayDoc', () => {
  it('reads then edits the document via MCP', async () => {
    // First call: initialize (returns session-id header)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'mcp-session-id': 'sess123' }),
      json: async () => ({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } }),
    });
    // Second call: read
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        jsonrpc: '2.0',
        id: 2,
        result: { content: [{ type: 'text', text: '1\tOld content' }] },
      }),
    });
    // Third call: edit
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        jsonrpc: '2.0',
        id: 3,
        result: { content: [{ type: 'text', text: 'Edited' }] },
      }),
    });

    await updateRelayDoc('Lens Edu/video_transcripts/test.md', 'Old content', 'New content');

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
