import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createTtsRoutes, loadTtsConfig, type TtsConfig } from './routes';
import { signShareToken, type ShareTokenPayload } from '../share-token';

function token(overrides: Partial<ShareTokenPayload> = {}): string {
  return signShareToken({
    purpose: 'share',
    role: 'view',
    folder: 'b0000001-0000-4000-8000-000000000001',
    expiry: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  });
}

function sse(events: unknown[]): Response {
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200 });
}

function mount(config: Partial<TtsConfig> = {}, speechify = vi.fn<typeof fetch>(async () => sse([
  { type: 'speech.chunk', audio: Buffer.from([1, 0, 2, 0]).toString('base64'), speech_marks: [{ type: 'word', start: 0, start_time: 0, end_time: 300 }] },
  { type: 'speech.done' },
]))) {
  const app = new Hono();
  app.route('/api/tts', createTtsRoutes({ apiKey: 'key', charsPerHour: 1000, fetchImpl: speechify, ...config }));
  return { app, speechify };
}

const post = (app: Hono, body: unknown, headers: Record<string, string> = { 'X-Share-Token': token() }) =>
  app.request('/api/tts/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('TTS routes', () => {
  it('answers 503 without a Speechify key', async () => {
    const { app } = mount({ apiKey: undefined });
    const res = await post(app, { text: 'Hi' });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'disabled' });
  });

  it('reads the key and the hourly budget from the environment', () => {
    expect(loadTtsConfig({ SPEECHIFY_API_KEY: ' k ', TTS_CHARS_PER_HOUR: '500' })).toEqual({ apiKey: 'k', charsPerHour: 500 });
    expect(loadTtsConfig({})).toMatchObject({ apiKey: undefined, charsPerHour: 500_000 });
  });

  it('requires a valid share token, any folder, any role', async () => {
    const { app, speechify } = mount();
    expect((await post(app, { text: 'Hi' }, {})).status).toBe(401);
    expect((await post(app, { text: 'Hi' }, { 'X-Share-Token': 'nope' })).status).toBe(401);
    expect((await post(app, { text: 'Hi' }, { 'X-Share-Token': token({ purpose: 'add-video' }) })).status).toBe(403);
    expect((await post(app, { text: 'Hi' }, { Authorization: `Bearer ${token({ role: 'view' })}` })).status).toBe(200);
    expect(speechify).toHaveBeenCalledTimes(1);
  });

  it('streams audio, timings and done as NDJSON', async () => {
    const { app, speechify } = mount();
    const res = await post(app, { text: '  Hello  ', voice_id: 'beatrice_32', speaking_rate: 9 });
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const lines = (await res.text()).trim().split('\n').map(l => JSON.parse(l));
    expect(lines).toEqual([
      { type: 'audio', data: Buffer.from([1, 0, 2, 0]).toString('base64') },
      { type: 'timestamps', words: ['Hello'], wordStartTimeSeconds: [0], wordEndTimeSeconds: [0.3] },
      { type: 'done' },
    ]);
    const sent = JSON.parse(speechify.mock.calls[0][1]!.body as string);
    expect(sent.voice_id).toBe('beatrice_32');
    // The speed is clamped to what Speechify is asked for.
    expect(sent.input).toBe('<speak><prosody rate="+350%">Hello</prosody></speak>');
  });

  it('reports a failed synthesis in the stream', async () => {
    const { app } = mount({}, vi.fn<typeof fetch>(async () => new Response('down', { status: 500 })));
    const lines = (await (await post(app, { text: 'Hi' })).text()).trim().split('\n').map(l => JSON.parse(l));
    expect(lines).toEqual([{ type: 'error', message: 'Synthesis failed' }]);
  });

  it('rejects missing or long text and bad voices', async () => {
    const { app, speechify } = mount({ charsPerHour: 1e6 });
    expect((await post(app, { text: '  ' })).status).toBe(400);
    expect((await post(app, { text: 'x'.repeat(2001) })).status).toBe(400);
    await post(app, { text: 'Hi', voice_id: '../evil' });
    expect(JSON.parse(speechify.mock.calls[0][1]!.body as string).voice_id).toBe('harper_32');
  });

  it('caps the characters one link may synthesize per hour', async () => {
    let now = 0;
    const app = new Hono();
    app.route('/api/tts', createTtsRoutes({ apiKey: 'key', charsPerHour: 10, fetchImpl: async () => sse([{ type: 'speech.done' }]) }, () => now));
    expect((await post(app, { text: '123456' })).status).toBe(200);
    const refused = await post(app, { text: '123456' });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ code: 'limit' });
    // Another link has its own budget; the hour resets it.
    expect((await post(app, { text: '123456' }, { 'X-Share-Token': token({ role: 'edit' }) })).status).toBe(200);
    now = 3600_000;
    expect((await post(app, { text: '123456' })).status).toBe(200);
  });

  it('lists the curated simba-3.2 voices', async () => {
    const speechify = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ voices: [{ id: 'old' }, { id: 'zed_32', display_name: 'Zed' }], has_more: true, next_cursor: 'c' }))
      .mockResolvedValueOnce(Response.json({ voices: [{ id: 'amy_32', display_name: 'Amy', gender: 'female', locale: 'en-US' }], has_more: false }));
    const { app } = mount({}, speechify);
    const res = await app.request('/api/tts/voices', { headers: { 'X-Share-Token': token() } });
    expect(await res.json()).toEqual([
      { id: 'amy_32', displayName: 'Amy', gender: 'female', locale: 'en-US' },
      { id: 'zed_32', displayName: 'Zed' },
    ]);
    expect(String(speechify.mock.calls[1][0])).toContain('cursor=c');
  });
});
