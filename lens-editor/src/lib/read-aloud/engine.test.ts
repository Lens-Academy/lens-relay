import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadAloudEngine, prefetchDepthFor, type FetchSpeech, type ReadAloudHighlight } from './engine';
import { TtsUnavailableError, type StreamEvent } from './api';
import type { PcmPlayer } from './player';

/** A player whose clock the test sets; it records what was queued. */
class FakePlayer {
  playbackTime = 0;
  queued: number[] = [];
  drained = false;
  onEmpty: (() => void) | null = null;
  push(bytes: Uint8Array) { this.queued.push(bytes.byteLength); }
  pushSilence(seconds: number) { this.queued.push(-seconds); }
  drain() { this.drained = true; }
  reset() { this.queued = []; this.playbackTime = 0; this.drained = false; }
  close() { this.reset(); }
  async resume() {}
  async suspend() {}
}

/** One second of audio at 24 kHz, with two words at 0 s and 0.5 s. */
function* sentence(text: string): Generator<StreamEvent> {
  const words = text.split(' ');
  yield { type: 'audio', pcm: new Uint8Array(48000) };
  yield { type: 'timestamps', words: words.map(w => `${w} `), wordStartTimeSeconds: words.map((_, i) => i * 0.5), wordEndTimeSeconds: words.map((_, i) => i * 0.5 + 0.4) };
  yield { type: 'done' };
}

let frames: FrameRequestCallback[] = [];
const runFrame = () => {
  const due = frames;
  frames = [];
  for (const f of due) f(0);
};

beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { frames.push(f); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

function setup(fetchSpeech?: FetchSpeech) {
  const requested: string[] = [];
  const fetcher: FetchSpeech = fetchSpeech ?? (async function* (text) {
    requested.push(text);
    yield* sentence(text);
  });
  const player = new FakePlayer();
  const engine = new ReadAloudEngine(fetcher, player as unknown as PcmPlayer);
  const highlights: Array<ReadAloudHighlight | null> = [];
  engine.onHighlight(h => highlights.push(h));
  return { engine, player, requested, highlights };
}

const flush = () => new Promise(r => setTimeout(r, 0));

describe('ReadAloudEngine', () => {
  it('fetches a few sentences ahead, more at high speed', () => {
    expect(prefetchDepthFor(1)).toBe(2);
    expect(prefetchDepthFor(1.5)).toBe(2);
    expect(prefetchDepthFor(3)).toBe(4);
    expect(prefetchDepthFor(4.5)).toBe(6);
  });

  it('plays units in order with pauses between blocks, then drains', async () => {
    const { engine, player, requested } = setup();
    engine.setUnits([{ text: 'One two' }, { text: 'Three four', pauseBefore: 0.3 }, { text: 'Five six' }]);
    engine.play(0);
    await flush();
    expect(requested).toEqual(['One two', 'Three four', 'Five six']);
    expect(player.queued).toEqual([48000, -0.3, 48000, 48000]);
    expect(player.drained).toBe(true);
    expect(engine.getSnapshot()).toMatchObject({ open: true, current: 0 });
  });

  it('reports the heard sentence and word from the player clock', async () => {
    const { engine, player, highlights } = setup();
    engine.setUnits([{ text: 'Alpha beta' }, { text: 'Gamma delta' }]);
    engine.play(0);
    await flush();
    player.playbackTime = 0.6;
    runFrame();
    expect(highlights.at(-1)).toEqual({ unit: 0, word: { start: 6, end: 10 } });
    player.playbackTime = 1.1;
    runFrame();
    expect(highlights.at(-1)).toEqual({ unit: 1, word: { start: 0, end: 5 } });
    expect(engine.getSnapshot()).toMatchObject({ current: 1, status: 'playing' });
    engine.setPrefs({ highlightMode: 'sentence' });
    runFrame();
    expect(highlights.at(-1)).toEqual({ unit: 1, word: null });
  });

  it('stops at the end, when the player has played everything', async () => {
    const { engine, player, highlights } = setup();
    engine.setUnits([{ text: 'Only one' }]);
    engine.play(0);
    await flush();
    runFrame();
    expect(highlights.at(-1)?.unit).toBe(0);
    player.onEmpty?.();
    expect(engine.getSnapshot()).toMatchObject({ status: 'idle', current: null, open: true });
    expect(highlights.at(-1)).toBeNull();
  });

  it('skips and pauses', async () => {
    const { engine, player } = setup();
    engine.setUnits([{ text: 'A a' }, { text: 'B b' }, { text: 'C c' }, { text: 'D d' }]);
    engine.play(0);
    await flush();
    engine.skip(1);
    await flush();
    expect(engine.getSnapshot().current).toBe(1);
    expect(player.queued[0]).toBe(48000);
    engine.pause();
    expect(engine.getSnapshot().status).toBe('paused');
    expect(engine.isPlaying).toBe(false);
    engine.play();
    expect(engine.isPlaying).toBe(true);
  });

  it('keeps going through edits, following the heard sentence to its new index', async () => {
    const { engine, player, highlights } = setup();
    engine.setUnits([{ text: 'A a' }, { text: 'B b' }, { text: 'C c' }]);
    engine.play(1);
    await flush();
    player.playbackTime = 0.2;
    runFrame();
    expect(highlights.at(-1)?.unit).toBe(1);
    // A new sentence was inserted before the one being heard.
    engine.setUnits([{ text: 'New n' }, { text: 'A a' }, { text: 'B b' }, { text: 'C c' }], 2);
    runFrame();
    expect(highlights.at(-1)?.unit).toBe(2);
    expect(engine.getSnapshot().current).toBe(2);
  });

  it('skips a sentence that fails, and stops on a refusal', async () => {
    const { engine, player } = setup(async function* (text) {
      if (text === 'Bad b') throw new Error('Synthesis failed');
      yield* sentence(text);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    engine.setUnits([{ text: 'Bad b' }, { text: 'Good g' }]);
    engine.play(0);
    await flush();
    expect(player.queued).toEqual([48000]);

    const refused = setup(async function* (text) {
      if (text) throw new TtsUnavailableError('Read-aloud limit reached', 'limit');
      yield* sentence(text);
    });
    refused.engine.setUnits([{ text: 'X x' }]);
    refused.engine.play(0);
    await flush();
    expect(refused.engine.getSnapshot()).toMatchObject({ status: 'idle', error: 'Read-aloud limit reached' });
  });

  it('refetches at the new speed after a speed change', async () => {
    vi.useFakeTimers();
    const rates: number[] = [];
    const { engine } = setup(async function* (text, opts) {
      rates.push(opts.speakingRate);
      yield* sentence(text);
    });
    engine.setUnits([{ text: 'A a' }]);
    engine.play(0);
    await vi.advanceTimersByTimeAsync(0);
    engine.setPrefs({ speakingRate: 2 });
    engine.setPrefs({ speakingRate: 2.5 });
    await vi.advanceTimersByTimeAsync(300);
    expect(rates).toEqual([1.5, 2.5]);
    expect(JSON.parse(localStorage.getItem('lens-read-aloud-prefs')!)).toMatchObject({ speakingRate: 2.5 });
    vi.useRealTimers();
  });

  it('dots acronyms in what is sent, not in what is highlighted', async () => {
    const { engine, requested } = setup();
    engine.setUnits([{ text: 'The ASI risk' }]);
    engine.play(0);
    await flush();
    expect(requested).toEqual(['The A.S.I. risk']);
  });
});
