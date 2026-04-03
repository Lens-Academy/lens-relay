import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRelayDoc, updateRelayDoc } from './relay-docs';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  vi.stubEnv('RELAY_URL', 'http://localhost:8090');
  vi.stubEnv('RELAY_SERVER_TOKEN', 'test-token');
  mockFetch.mockReset();
});

/** Mock the 3-step session establishment: initialize, notify, create_session */
function mockSessionEstablishment() {
  // 1. initialize → returns session ID in header
  mockFetch.mockResolvedValueOnce({
    ok: true,
    headers: new Headers({ 'mcp-session-id': 'transport-123' }),
    json: async () => ({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '2025-03-26' },
    }),
  });
  // 2. notifications/initialized → no response body needed
  mockFetch.mockResolvedValueOnce({
    ok: true,
    headers: new Headers(),
    json: async () => ({}),
  });
  // 3. create_session tool → returns session_id
  mockFetch.mockResolvedValueOnce({
    ok: true,
    headers: new Headers({ 'mcp-session-id': 'transport-123' }),
    json: async () => ({
      jsonrpc: '2.0',
      id: 2,
      result: { content: [{ type: 'text', text: 'session-abc' }] },
    }),
  });
}

describe('createRelayDoc', () => {
  it('establishes session then calls create tool with session_id', async () => {
    mockSessionEstablishment();
    // 4. create tool
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'mcp-session-id': 'transport-123' }),
      json: async () => ({
        jsonrpc: '2.0',
        id: 3,
        result: {
          content: [
            { type: 'text', text: 'Created Lens Edu/video_transcripts/test.md' },
          ],
        },
      }),
    });

    await createRelayDoc('Lens Edu/video_transcripts/test.md', '# Hello');

    // 4 calls: initialize, notify, create_session, create
    expect(mockFetch).toHaveBeenCalledTimes(4);

    // Verify initialize
    const initBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(initBody.method).toBe('initialize');
    expect(initBody.id).toBeDefined();

    // Verify notification has no id
    const notifyBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(notifyBody.method).toBe('notifications/initialized');
    expect(notifyBody.id).toBeUndefined();

    // Verify create_session
    const csBody = JSON.parse(mockFetch.mock.calls[2][1].body);
    expect(csBody.method).toBe('tools/call');
    expect(csBody.params.name).toBe('create_session');

    // Verify create tool includes session_id
    const createBody = JSON.parse(mockFetch.mock.calls[3][1].body);
    expect(createBody.method).toBe('tools/call');
    expect(createBody.params.name).toBe('create');
    expect(createBody.params.arguments.file_path).toBe(
      'Lens Edu/video_transcripts/test.md'
    );
    expect(createBody.params.arguments.session_id).toBe('session-abc');
  });
});

describe('updateRelayDoc', () => {
  it('establishes session, reads actual content, then edits', async () => {
    mockSessionEstablishment();
    // 4. read tool
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'mcp-session-id': 'transport-123' }),
      json: async () => ({
        jsonrpc: '2.0',
        id: 4,
        result: { content: [{ type: 'text', text: '1\tOld content' }] },
      }),
    });
    // 5. edit tool
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'mcp-session-id': 'transport-123' }),
      json: async () => ({
        jsonrpc: '2.0',
        id: 5,
        result: { content: [{ type: 'text', text: 'Edited' }] },
      }),
    });

    await updateRelayDoc(
      'Lens Edu/video_transcripts/test.md',
      'Expected content',
      'New content'
    );

    // 5 calls: initialize, notify, create_session, read, edit
    expect(mockFetch).toHaveBeenCalledTimes(5);

    // Verify edit uses actual read content (not the expected oldContent param)
    const editBody = JSON.parse(mockFetch.mock.calls[4][1].body);
    expect(editBody.params.arguments.old_string).toBe('Old content');
    expect(editBody.params.arguments.new_string).toBe('New content');
    expect(editBody.params.arguments.session_id).toBe('session-abc');
  });
});
