import { Hono, type MiddlewareHandler } from 'hono';
import { roleAtLeast, shareTokenFromHeaders, verifyShareToken } from '../share-token.ts';
import {
  MAX_SPEAKING_RATE,
  MIN_SPEAKING_RATE,
  SPEECHIFY_API_URL,
  SpeechifyError,
  synthesize,
  type SynthesisOptions,
} from './speechify.ts';

/**
 * Read-aloud for the editor (src/lib/read-aloud):
 *
 *   POST /api/tts/stream  {text, voice_id?, speaking_rate?}
 *     → application/x-ndjson, one JSON object per line:
 *       {"type":"audio","data":<base64 PCM, s16le mono 24 kHz>}
 *       {"type":"timestamps","words":[…],"wordStartTimeSeconds":[…],"wordEndTimeSeconds":[…]}
 *       {"type":"done"} | {"type":"error","message":…}
 *   GET /api/tts/voices → [{id, displayName, gender, locale}]
 *
 * One sentence per request, like the platform's /ws/immersion, but over a
 * streamed fetch (the editor's Node server has no WebSocket endpoints) and
 * without the platform's audio cache: every listen is synthesized again.
 * Any valid share link may listen; the Speechify key stays on the server.
 * Without SPEECHIFY_API_KEY every route answers 503 and the editor hides
 * its Listen button.
 */

export interface TtsConfig {
  apiKey?: string;
  /** Characters one share token may synthesize per hour (cost guard). */
  charsPerHour: number;
  fetchImpl?: typeof fetch;
}

export const MAX_TEXT_CHARS = 2000;
// About four hours of listening at 1x (~54k characters an hour), so a team
// sharing one link never meets it, but a script looping on a leaked link
// costs at most a few dollars an hour.
const DEFAULT_CHARS_PER_HOUR = 250_000;
const VOICES_TTL_MS = 3600_000;

export function loadTtsConfig(env: NodeJS.ProcessEnv = process.env): TtsConfig {
  const limit = Number(env.TTS_CHARS_PER_HOUR);
  return {
    apiKey: env.SPEECHIFY_API_KEY?.trim() || undefined,
    charsPerHour: Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_CHARS_PER_HOUR,
  };
}

/** Any share token for any folder, view or better. */
function requireShareToken(): MiddlewareHandler {
  return async (c, next) => {
    const token = shareTokenFromHeaders(c.req.header('X-Share-Token'), c.req.header('Authorization'));
    if (!token) return c.json({ error: 'Authorization header required' }, 401);
    const payload = verifyShareToken(token);
    if (!payload) return c.json({ error: 'Invalid or expired token' }, 401);
    if (payload.purpose !== 'share' || !roleAtLeast(payload.role, 'view')) {
      return c.json({ error: 'Share token required' }, 403);
    }
    return next();
  };
}

/** Fixed one-hour windows of characters per token. */
class CharBudget {
  private windows = new Map<string, { start: number; used: number }>();
  constructor(private readonly limit: number, private readonly now = () => Date.now()) {}

  take(key: string, chars: number): boolean {
    const now = this.now();
    let w = this.windows.get(key);
    if (!w || now - w.start >= 3600_000) {
      w = { start: now, used: 0 };
      this.windows.set(key, w);
      if (this.windows.size > 1000) this.sweep(now);
    }
    if (w.used + chars > this.limit) return false;
    w.used += chars;
    return true;
  }

  private sweep(now: number) {
    for (const [k, w] of this.windows) if (now - w.start >= 3600_000) this.windows.delete(k);
  }
}

export function createTtsRoutes(config: TtsConfig = loadTtsConfig(), now?: () => number): Hono {
  const app = new Hono();
  const apiKey = config.apiKey;
  if (!apiKey) {
    app.all('*', c => c.json({ error: 'Read-aloud is not configured (SPEECHIFY_API_KEY)', code: 'disabled' }, 503));
    return app;
  }
  const budget = new CharBudget(config.charsPerHour, now);
  const doFetch = config.fetchImpl ?? fetch;

  app.use('*', requireShareToken());

  let voices: { list: unknown[]; at: number } | null = null;
  app.get('/voices', async c => {
    if (voices && Date.now() - voices.at < VOICES_TTL_MS) return c.json(voices.list);
    const list: Array<{ id: string; displayName: string; gender?: string; locale?: string }> = [];
    let cursor: string | undefined;
    try {
      for (let page = 0; page < 30; page++) {
        const url = new URL(`${SPEECHIFY_API_URL}/voices`);
        url.searchParams.set('limit', '100');
        if (cursor) url.searchParams.set('cursor', cursor);
        const resp = await doFetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
        if (!resp.ok) throw new Error(`Speechify voices: ${resp.status}`);
        const body = await resp.json() as {
          voices?: Array<{ id: string; display_name?: string; gender?: string; locale?: string }>;
          next_cursor?: string;
          has_more?: boolean;
        };
        // The curated simba-3.2 voices are registered under ids ending in _32.
        for (const v of body.voices ?? []) {
          if (v.id.endsWith('_32')) {
            list.push({ id: v.id, displayName: v.display_name || v.id, gender: v.gender, locale: v.locale });
          }
        }
        cursor = body.next_cursor;
        if (!body.has_more || !cursor) break;
      }
    } catch (err) {
      console.warn('[tts] voice list failed:', err);
      return c.json({ error: 'Could not load voices' }, 502);
    }
    list.sort((a, b) => a.displayName.localeCompare(b.displayName));
    voices = { list, at: Date.now() };
    return c.json(list);
  });

  app.post('/stream', async c => {
    let body: { text?: unknown; voice_id?: unknown; speaking_rate?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'JSON body required' }, 400);
    }
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return c.json({ error: 'Missing text' }, 400);
    if (text.length > MAX_TEXT_CHARS) return c.json({ error: `Text exceeds ${MAX_TEXT_CHARS} characters` }, 400);
    const voiceId = typeof body.voice_id === 'string' && /^[\w-]{1,64}$/.test(body.voice_id) ? body.voice_id : undefined;
    let speakingRate: number | undefined;
    if (typeof body.speaking_rate === 'number' && Number.isFinite(body.speaking_rate)) {
      speakingRate = Math.min(MAX_SPEAKING_RATE, Math.max(MIN_SPEAKING_RATE, body.speaking_rate));
    }
    // requireShareToken has verified it; it also keys the character budget.
    const token = shareTokenFromHeaders(c.req.header('X-Share-Token'), c.req.header('Authorization'))!;
    if (!budget.take(token, text.length)) {
      return c.json({ error: 'Read-aloud limit reached for this link; try again within the hour', code: 'limit' }, 429);
    }

    // The browser aborts when the listener skips or stops; pass that on so
    // Speechify stops generating (and billing) the rest of the sentence.
    const upstream = new AbortController();
    c.req.raw.signal?.addEventListener('abort', () => upstream.abort());
    const opts: SynthesisOptions = { apiKey, voiceId, speakingRate, signal: upstream.signal, fetchImpl: config.fetchImpl };
    const encoder = new TextEncoder();
    const line = (obj: unknown) => encoder.encode(JSON.stringify(obj) + '\n');

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const event of synthesize(text, opts)) {
            if (event.type === 'audio') {
              controller.enqueue(line({ type: 'audio', data: Buffer.from(event.pcm).toString('base64') }));
            } else {
              controller.enqueue(line(event));
            }
          }
          controller.enqueue(line({ type: 'done' }));
        } catch (err) {
          if (upstream.signal.aborted) {
            controller.close();
            return;
          }
          const status = err instanceof SpeechifyError ? err.status : undefined;
          console.warn('[tts] synthesis failed:', err instanceof Error ? err.message : err);
          controller.enqueue(line({
            type: 'error',
            message: status === 401 || status === 403 ? 'Read-aloud is misconfigured' : 'Synthesis failed',
          }));
        }
        controller.close();
      },
      cancel() {
        upstream.abort();
      },
    });
    return c.body(stream, 200, {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
  });

  return app;
}
