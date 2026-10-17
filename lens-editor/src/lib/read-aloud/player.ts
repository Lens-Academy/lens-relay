/**
 * Gapless playback of streamed 16-bit PCM through one AudioWorklet: the
 * linear16 path of lens-platform's useAudioPlayback, as a plain class so the
 * read-aloud engine can own it outside React.
 *
 * All audio of a reading session flows into one worklet queue, so sentence
 * boundaries cost no gap or click. `playbackTime` is in source samples
 * consumed (seconds of the PCM as synthesized), the same axis as the word
 * timings Speechify returns.
 */

import { SONIC_SPEECH_WORKLET_SOURCE } from './sonicSpeechWorklet';

export const PCM_SAMPLE_RATE = 24000;

/** Margin on top of the context's reported output latency before the worklet
 *  reports "empty", so the last word is not cut off. */
const DRAIN_PAD_SECONDS = 0.12;

export class PcmPlayer {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private nodeReady: Promise<AudioWorkletNode> | null = null;
  /** Resets posted to the current node; stats stamped with another epoch are stale. */
  private epoch = 0;
  /** Bumped on every reset; chunks queued before it are dropped. */
  private gen = 0;
  private chain: Promise<void> = Promise.resolve();
  private samplesPlayed = 0;
  private progressAt = 0;
  private draining = false;

  /** Called once the queue has drained after `drain()`. */
  onEmpty: (() => void) | null = null;

  /** Create or resume the context. Call from a user gesture. */
  async resume(): Promise<void> {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') await ctx.resume();
  }

  async suspend(): Promise<void> {
    if (this.ctx?.state === 'running') await this.ctx.suspend();
  }

  get suspended(): boolean {
    return this.ctx?.state === 'suspended';
  }

  /** Seconds of source audio played since the last reset. Interpolated
   *  between the worklet's progress reports (every 0.1 s). */
  get playbackTime(): number {
    const ctx = this.ctx;
    const base = this.samplesPlayed / PCM_SAMPLE_RATE;
    if (!ctx || ctx.state !== 'running' || this.progressAt === 0) return base;
    return base + Math.min(0.12, Math.max(0, ctx.currentTime - this.progressAt));
  }

  /** Queue PCM bytes (s16le mono 24 kHz). */
  push(bytes: Uint8Array): void {
    const gen = this.gen;
    const ctx = this.ensureContext();
    this.draining = false;
    this.chain = this.chain.then(async () => {
      if (gen !== this.gen) return;
      const node = await this.ensureNode(ctx);
      if (gen !== this.gen) return;
      const samples = new Int16Array(Math.floor(bytes.byteLength / 2));
      new Uint8Array(samples.buffer).set(bytes.subarray(0, samples.length * 2));
      node.port.postMessage({ type: 'chunk', data: samples }, [samples.buffer]);
    }).catch(err => console.error('[read-aloud] audio worklet failed:', err));
  }

  /** Queue `seconds` of silence (a pause between blocks). */
  pushSilence(seconds: number): void {
    this.push(new Uint8Array(Math.round(seconds * PCM_SAMPLE_RATE) * 2));
  }

  /** No more audio follows: play out what is queued, then call onEmpty. */
  drain(): void {
    const gen = this.gen;
    this.draining = true;
    this.chain = this.chain.then(() => {
      if (gen !== this.gen || !this.node || !this.ctx) return;
      const latency = (this.ctx.baseLatency ?? 0) + (this.ctx.outputLatency ?? 0);
      this.node.port.postMessage({
        type: 'drain',
        padSamples: Math.round((latency + DRAIN_PAD_SECONDS) * PCM_SAMPLE_RATE),
      });
    });
  }

  /** Drop everything queued and restart the clock at 0, keeping the context. */
  reset(): void {
    this.gen++;
    this.chain = Promise.resolve();
    this.draining = false;
    this.samplesPlayed = 0;
    this.progressAt = 0;
    if (this.node) {
      this.node.port.postMessage({ type: 'reset' });
      this.epoch++;
    }
  }

  /** Tear down the context. The next push creates a fresh one. */
  close(): void {
    this.reset();
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
    }
    this.node = null;
    this.nodeReady = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }

  private ensureContext(): AudioContext {
    if (this.ctx && this.ctx.state !== 'closed') return this.ctx;
    // Pinned to the source rate so the browser never resamples per chunk.
    try {
      this.ctx = new AudioContext({ sampleRate: PCM_SAMPLE_RATE });
    } catch {
      this.ctx = new AudioContext();
    }
    this.node = null;
    this.nodeReady = null;
    return this.ctx;
  }

  private ensureNode(ctx: AudioContext): Promise<AudioWorkletNode> {
    if (this.nodeReady) return this.nodeReady;
    this.epoch = 0;
    this.nodeReady = (async () => {
      const url = URL.createObjectURL(new Blob([SONIC_SPEECH_WORKLET_SOURCE], { type: 'application/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const node = new AudioWorkletNode(ctx, 'sonic-speech-player', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      // Speed is synthesized by Speechify; the worklet always plays at 1x,
      // where it passes samples through unchanged.
      node.port.postMessage({ type: 'rate', playbackRate: 1 });
      node.connect(ctx.destination);
      node.port.onmessage = (e: MessageEvent) => {
        const data = e.data as { type?: string; samplesPlayed?: number; epoch?: number };
        if (Number(data.epoch ?? 0) !== this.epoch) return;
        if (data.type === 'progress' || data.type === 'empty') {
          this.samplesPlayed = Number(data.samplesPlayed ?? 0);
          this.progressAt = ctx.currentTime;
        }
        if (data.type === 'empty' && this.draining) this.onEmpty?.();
      };
      this.node = node;
      return node;
    })();
    return this.nodeReady;
  }
}
