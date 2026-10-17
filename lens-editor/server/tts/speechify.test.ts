import { describe, expect, it, vi } from 'vitest';
import { ssmlFor, synthesize, WordTokens, type SynthesisEvent } from './speechify';

function sse(events: unknown[]): Response {
  const body = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function collect(gen: AsyncGenerator<SynthesisEvent>): Promise<SynthesisEvent[]> {
  const out: SynthesisEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe('ssmlFor', () => {
  it('escapes markup and applies the speed as prosody', () => {
    expect(ssmlFor('a < b & c')).toBe('<speak>a &lt; b &amp; c</speak>');
    expect(ssmlFor('Hi', 1.5)).toBe('<speak><prosody rate="+50%">Hi</prosody></speak>');
    expect(ssmlFor('Hi', 0.75)).toBe('<speak><prosody rate="-25%">Hi</prosody></speak>');
    expect(ssmlFor('Hi', 1.001)).toBe('<speak>Hi</speak>');
  });
});

describe('WordTokens', () => {
  it('turns word marks into tokens that partition the text', () => {
    const t = new WordTokens('Hello, big world.');
    const mark = (start: number, ms: number) => ({ type: 'word', start, start_time: ms, end_time: ms + 100 });
    expect(t.push([mark(0, 0), mark(7, 300)])).toEqual({
      type: 'timestamps', words: ['Hello, '], wordStartTimeSeconds: [0], wordEndTimeSeconds: [0.1],
    });
    expect(t.push([{ type: 'sentence', start: 0, start_time: 0, end_time: 0 }, mark(11, 600)])?.words).toEqual(['big ']);
    expect(t.flush()).toEqual({
      type: 'timestamps', words: ['world.'], wordStartTimeSeconds: [0.6], wordEndTimeSeconds: [0.7],
    });
    expect(t.flush()).toBeNull();
  });
});

describe('synthesize', () => {
  it('streams whole 16-bit samples and timings, re-aligning odd chunks', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => sse([
      { type: 'speech.chunk', audio: Buffer.from([1, 2, 3]).toString('base64'), speech_marks: [{ type: 'word', start: 0, start_time: 0, end_time: 200 }] },
      { type: 'speech.chunk', audio: Buffer.from([4, 5, 6]).toString('base64') },
      { type: 'speech.done', audio_duration_ms: 1 },
    ]));
    const events = await collect(synthesize('Hello', { apiKey: 'k', speakingRate: 2, fetchImpl }));
    const audio = events.filter(e => e.type === 'audio').map(e => Array.from((e as { pcm: Uint8Array }).pcm));
    expect(audio).toEqual([[1, 2], [3, 4, 5, 6]]);
    expect(events.at(-1)).toMatchObject({ type: 'timestamps', words: ['Hello'] });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('https://api.speechify.ai/v1/audio/stream/with-timestamps');
    expect(JSON.parse(init!.body as string)).toEqual({
      input: '<speak><prosody rate="+100%">Hello</prosody></speak>',
      voice_id: 'harper_32',
      model: 'simba-3.2',
      output_format: 'pcm_24000',
    });
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer k');
  });

  it('waits out a 429 and retries', async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('slow down', { status: 429, headers: { 'ratelimit-reset': '2' } }))
      .mockResolvedValueOnce(sse([{ type: 'speech.done' }]));
    await collect(synthesize('Hi', { apiKey: 'k', fetchImpl, sleep }));
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws with the status when Speechify refuses', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('bad key', { status: 401 }));
    await expect(collect(synthesize('Hi', { apiKey: 'k', fetchImpl }))).rejects.toMatchObject({ status: 401 });
  });
});
