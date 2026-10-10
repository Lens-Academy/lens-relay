import { relayHeaders } from '../relay-api';

/** What POST /api/tts/stream sends, one JSON object per line (server/tts/routes.ts). */
export type StreamEvent =
  | { type: 'audio'; pcm: Uint8Array }
  | { type: 'timestamps'; words: string[]; wordStartTimeSeconds: number[]; wordEndTimeSeconds: number[] }
  | { type: 'done' };

/** A refusal that stops the whole session rather than skipping one sentence. */
export class TtsUnavailableError extends Error {
  constructor(message: string, readonly code: 'disabled' | 'limit' | 'auth') {
    super(message);
  }
}

export interface Voice {
  id: string;
  displayName: string;
}

function decodeBase64(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function* streamSpeech(
  text: string,
  opts: { voiceId: string; speakingRate: number; signal: AbortSignal },
): AsyncGenerator<StreamEvent> {
  const response = await fetch('/api/tts/stream', {
    method: 'POST',
    headers: relayHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ text, voice_id: opts.voiceId, speaking_rate: opts.speakingRate }),
    signal: opts.signal,
  });
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({})) as { error?: string; code?: string };
    if (response.status === 503) throw new TtsUnavailableError(body.error ?? 'Read-aloud is not available', 'disabled');
    if (response.status === 429) throw new TtsUnavailableError(body.error ?? 'Read-aloud limit reached', 'limit');
    if (response.status === 401 || response.status === 403) throw new TtsUnavailableError('Sign in again to listen', 'auth');
    throw new Error(body.error ?? `Read-aloud failed (${response.status})`);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += value;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as { type: string; data?: string; message?: string };
        if (msg.type === 'audio' && msg.data) yield { type: 'audio', pcm: decodeBase64(msg.data) };
        else if (msg.type === 'timestamps') yield msg as StreamEvent;
        else if (msg.type === 'done') { yield { type: 'done' }; return; }
        else if (msg.type === 'error') throw new Error(msg.message ?? 'Synthesis failed');
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error('Read-aloud stream ended early');
}

let voicesPromise: Promise<Voice[]> | null = null;

export function loadVoices(): Promise<Voice[]> {
  voicesPromise ??= fetch('/api/tts/voices', { headers: relayHeaders() })
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .catch(err => {
      voicesPromise = null;
      throw err;
    });
  return voicesPromise;
}

/** Whether the server has read-aloud configured (any non-503 answer). Cached per page load. */
let availablePromise: Promise<boolean> | null = null;
export function readAloudAvailable(): Promise<boolean> {
  availablePromise ??= loadVoices().then(() => true, err => !String(err).includes('503'));
  return availablePromise;
}
