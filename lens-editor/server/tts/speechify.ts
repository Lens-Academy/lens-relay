/**
 * Speechify synthesis for read-aloud: one request per sentence, raw PCM and
 * word timings streamed back as server-sent events.
 *
 * A port of lens-platform's core/tts/speechify.py (same model, voice, format,
 * SSML speed and word tokens), minus its cache and pronunciation lexicon.
 * Keep the two in step when Speechify's behaviour is re-measured.
 */

export const SPEECHIFY_API_URL = 'https://api.speechify.ai/v1';
/** Speechify's streaming-native English model, as on the platform. */
export const DEFAULT_MODEL = 'simba-3.2';
/** Female, US English, tagged for e-learning by Speechify (the platform's default). */
export const DEFAULT_VOICE_ID = 'harper_32';
/** 24 kHz is what the model produces; the browser's AudioContext is pinned to it. */
export const PCM_OUTPUT_FORMAT = 'pcm_24000';
export const PCM_SAMPLE_RATE = 24000;

export const MIN_SPEAKING_RATE = 0.5;
export const MAX_SPEAKING_RATE = 4.5;

// Speechify answers 429 with `ratelimit-reset` in seconds. The limit is per
// API key (measured 2026-09 on the platform: ~1 request/s sustained, burst of
// 10) and the reader fetches a couple of sentences ahead, so a burst waits
// instead of dropping a sentence. The budget caps how long one sentence queues.
const RATE_LIMIT_WAIT_BUDGET_S = 30;
const RATE_LIMIT_MAX_WAIT_S = 10;

export interface TimestampsMessage {
  type: 'timestamps';
  words: string[];
  wordStartTimeSeconds: number[];
  wordEndTimeSeconds: number[];
}

export type SynthesisEvent =
  | { type: 'audio'; pcm: Uint8Array }
  | TimestampsMessage;

export interface SynthesisOptions {
  apiKey: string;
  voiceId?: string;
  /** Multiplier on natural speed, applied by Speechify via SSML prosody. */
  speakingRate?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * Plain text as SSML, with the speed as a prosody tag. On simba-3.2
 * `rate="+N%"` speeds audio up by (1 + N/100) and the word timings follow the
 * sped-up audio. Always wrapping (and escaping) keeps `<` and `&` in page text
 * from being read as markup.
 */
export function ssmlFor(text: string, speakingRate?: number): string {
  let body = escapeXml(text);
  if (speakingRate !== undefined && Math.abs(speakingRate - 1) >= 0.005) {
    const percent = Math.round((speakingRate - 1) * 100);
    body = `<prosody rate="${percent >= 0 ? '+' : ''}${percent}%">${body}</prosody>`;
  }
  return `<speak>${body}</speak>`;
}

interface SpeechMark {
  type?: string;
  start: number;
  start_time: number;
  end_time: number;
}

/**
 * Turns Speechify word marks into `timestamps` messages whose tokens
 * partition the text exactly: each token runs from its mark's start to the
 * next mark's start. A mark may span several words, be punctuation only or
 * skip a word, so marks alone do not give that. One mark is held back until
 * the next arrives; `flush` releases it with the tail of the text.
 */
export class WordTokens {
  private cursor = 0;
  private pending: SpeechMark | null = null;

  constructor(private readonly text: string) {}

  push(marks: SpeechMark[]): TimestampsMessage | null {
    const done: Array<[string, SpeechMark]> = [];
    for (const mark of marks) {
      if (mark.type !== 'word') continue;
      if (this.pending) {
        const end = Math.max(this.cursor, mark.start);
        done.push([this.text.slice(this.cursor, end), this.pending]);
        this.cursor = end;
      }
      this.pending = mark;
    }
    return message(done);
  }

  flush(): TimestampsMessage | null {
    if (!this.pending) return null;
    const done: Array<[string, SpeechMark]> = [[this.text.slice(this.cursor), this.pending]];
    this.cursor = this.text.length;
    this.pending = null;
    return message(done);
  }
}

function message(done: Array<[string, SpeechMark]>): TimestampsMessage | null {
  if (done.length === 0) return null;
  return {
    type: 'timestamps',
    words: done.map(([token]) => token),
    wordStartTimeSeconds: done.map(([, m]) => m.start_time / 1000),
    wordEndTimeSeconds: done.map(([, m]) => m.end_time / 1000),
  };
}

/** The JSON `data:` payload of each event in an SSE body. */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('data:')) data.push(line.slice(5).trim());
        else if (line === '' && data.length) {
          yield JSON.parse(data.join('\n'));
          data = [];
        }
      }
      if (done) break;
    }
    if (buffer.startsWith('data:')) data.push(buffer.slice(5).trim());
    if (data.length) yield JSON.parse(data.join('\n'));
  } finally {
    reader.releaseLock();
  }
}

export class SpeechifyError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** POST to the with-timestamps stream, waiting out 429s within the budget. */
async function postStream(body: unknown, opts: SynthesisOptions): Promise<Response> {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));
  let waited = 0;
  for (;;) {
    const response = await doFetch(`${SPEECHIFY_API_URL}/audio/stream/with-timestamps`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (response.status !== 429) return response;
    let wait = Number(response.headers.get('ratelimit-reset') ?? 1);
    if (!Number.isFinite(wait)) wait = 1;
    wait = Math.min(Math.max(wait, 0), RATE_LIMIT_MAX_WAIT_S);
    if (waited + wait > RATE_LIMIT_WAIT_BUDGET_S) return response;
    await response.body?.cancel();
    await sleep(wait * 1000);
    waited += wait;
  }
}

/**
 * Synthesize one text. Yields PCM (whole 16-bit samples) and timestamps
 * messages in the order Speechify sends them. Throws SpeechifyError when
 * Speechify refuses or the stream reports an error.
 */
export async function* synthesize(text: string, opts: SynthesisOptions): AsyncGenerator<SynthesisEvent> {
  const response = await postStream({
    input: ssmlFor(text, opts.speakingRate),
    voice_id: opts.voiceId ?? DEFAULT_VOICE_ID,
    model: DEFAULT_MODEL,
    output_format: PCM_OUTPUT_FORMAT,
  }, opts);
  if (response.status !== 200 || !response.body) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new SpeechifyError(`Speechify returned ${response.status}: ${detail}`, response.status);
  }

  const tokens = new WordTokens(text);
  // Speechify's chunks split 16-bit samples at odd byte offsets; carry the
  // odd byte so every yielded chunk is whole samples.
  let carry: Uint8Array | null = null;
  for await (const event of sseEvents(response.body)) {
    if (event.type === 'speech.chunk') {
      const marks = event.speech_marks as SpeechMark[] | undefined;
      if (marks?.length) {
        const msg = tokens.push(marks);
        if (msg) yield msg;
      }
      if (typeof event.audio === 'string' && event.audio) {
        let bytes: Uint8Array = Buffer.from(event.audio, 'base64');
        if (carry) {
          const joined = new Uint8Array(carry.length + bytes.length);
          joined.set(carry);
          joined.set(bytes, carry.length);
          bytes = joined;
          carry = null;
        }
        if (bytes.length % 2) {
          carry = bytes.slice(bytes.length - 1);
          bytes = bytes.slice(0, bytes.length - 1);
        }
        if (bytes.length) yield { type: 'audio', pcm: bytes };
      }
    } else if (event.type === 'speech.done') {
      const msg = tokens.flush();
      if (msg) yield msg;
    } else if (event.type === 'speech.error') {
      throw new SpeechifyError(`Speechify stream error: ${JSON.stringify(event).slice(0, 300)}`);
    }
  }
}
