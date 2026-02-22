import { describe, it, expect, vi, beforeEach } from 'vitest';

// We need to mock global fetch before importing the module
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

// Set required env var before importing
vi.stubEnv('DISCORD_BOT_TOKEN', 'test-bot-token');

// Import after mocks are set up
const { sendWebhookMessage } = await import('./discord-client.ts');

// Helper to create a mock Response
function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

describe('sendWebhookMessage', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('sends to regular channel without thread_id', async () => {
    // 1. fetchChannelInfo → regular text channel (type 0)
    fetchMock.mockResolvedValueOnce(
      mockResponse({ id: '111', name: 'general', type: 0, parent_id: null })
    );
    // 2. List webhooks → empty (no existing webhook)
    fetchMock.mockResolvedValueOnce(mockResponse([]));
    // 3. Create webhook
    fetchMock.mockResolvedValueOnce(
      mockResponse({ id: 'wh1', token: 'wh-token-1' })
    );
    // 4. Execute webhook
    fetchMock.mockResolvedValueOnce(
      mockResponse({ id: 'msg1', content: 'hello', author: {}, timestamp: '', type: 0 })
    );

    await sendWebhookMessage('111', 'hello', 'TestUser');

    // Webhook should be created on channel 111 (not a thread)
    const createCall = fetchMock.mock.calls[2];
    expect(createCall[0]).toBe('https://discord.com/api/v10/channels/111/webhooks');

    // Execute URL should NOT have thread_id
    const execCall = fetchMock.mock.calls[3];
    expect(execCall[0]).toBe('https://discord.com/api/v10/webhooks/wh1/wh-token-1?wait=true');
    expect(execCall[0]).not.toContain('thread_id');
  });

  it('sends to thread using parent channel webhook + thread_id', async () => {
    // 1. fetchChannelInfo → public thread (type 11) with parent
    fetchMock.mockResolvedValueOnce(
      mockResponse({ id: '222', name: 'my-thread', type: 11, parent_id: '100' })
    );
    // 2. List webhooks on PARENT channel 100 → empty
    fetchMock.mockResolvedValueOnce(mockResponse([]));
    // 3. Create webhook on PARENT channel 100
    fetchMock.mockResolvedValueOnce(
      mockResponse({ id: 'wh2', token: 'wh-token-2' })
    );
    // 4. Execute webhook with thread_id
    fetchMock.mockResolvedValueOnce(
      mockResponse({ id: 'msg2', content: 'hi thread', author: {}, timestamp: '', type: 0 })
    );

    await sendWebhookMessage('222', 'hi thread', 'TestUser');

    // Webhook should be created on PARENT channel 100
    const createCall = fetchMock.mock.calls[2];
    expect(createCall[0]).toBe('https://discord.com/api/v10/channels/100/webhooks');

    // Execute URL should include thread_id=222
    const execCall = fetchMock.mock.calls[3];
    expect(execCall[0]).toContain('thread_id=222');
    expect(execCall[0]).toContain('wait=true');
  });

  it('sends to forum post using parent channel webhook + thread_id', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({ id: '333', name: 'forum-post', type: 11, parent_id: '200' })
    );
    fetchMock.mockResolvedValueOnce(mockResponse([]));
    fetchMock.mockResolvedValueOnce(
      mockResponse({ id: 'wh3', token: 'wh-token-3' })
    );
    fetchMock.mockResolvedValueOnce(
      mockResponse({ id: 'msg3', content: 'forum msg', author: {}, timestamp: '', type: 0 })
    );

    await sendWebhookMessage('333', 'forum msg', 'TestUser');

    const createCall = fetchMock.mock.calls[2];
    expect(createCall[0]).toBe('https://discord.com/api/v10/channels/200/webhooks');

    const execCall = fetchMock.mock.calls[3];
    expect(execCall[0]).toContain('thread_id=333');
  });
});
