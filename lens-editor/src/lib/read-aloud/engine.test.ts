import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOOKAHEAD_SECONDS, PAGE_SOURCE, ReadAloudEngine, prefetchDepthFor, type FetchSpeech, type ReadAloudHighlight } from './engine';
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
    expect(highlights.at(-1)).toEqual({ source: PAGE_SOURCE, unit: 0, word: { start: 6, end: 10 } });
    player.playbackTime = 1.1;
    runFrame();
    expect(highlights.at(-1)).toEqual({ source: PAGE_SOURCE, unit: 1, word: { start: 0, end: 5 } });
    expect(engine.getSnapshot()).toMatchObject({ current: 1, status: 'playing' });
    engine.setPrefs({ highlightMode: 'sentence' });
    runFrame();
    expect(highlights.at(-1)).toEqual({ source: PAGE_SOURCE, unit: 1, word: null });
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

  it('fetches only a little ahead of what is heard, also after a jump', async () => {
    const { engine, player, requested } = setup();
    const units = Array.from({ length: 300 }, (_, i) => ({ text: `Sentence ${i}` }));
    engine.setUnits(units);
    engine.play(0);
    await flush();
    // Each sentence is 1 s of audio: queued up to the look-ahead, plus a few being fetched.
    const ahead = LOOKAHEAD_SECONDS + prefetchDepthFor(1.5) + 2;
    expect(requested.length).toBeLessThanOrEqual(ahead);
    expect(player.queued.length).toBeGreaterThanOrEqual(LOOKAHEAD_SECONDS);

    // Playback moves on: the queue is topped up.
    player.playbackTime = 30;
    runFrame();
    await flush();
    expect(requested.length).toBeGreaterThan(ahead);
    expect(requested.length).toBeLessThanOrEqual(30 + ahead);

    // A click on a later sentence costs the sentences near it, not the rest of the page.
    requested.length = 0;
    engine.play(200);
    await flush();
    expect(requested[0]).toBe('Sentence 200');
    expect(requested.length).toBeLessThanOrEqual(ahead);
  });

  it('tops up the queue on the player\'s progress reports alone (a background tab has no frames)', async () => {
    const { engine, player, requested } = setup();
    engine.setUnits(Array.from({ length: 100 }, (_, i) => ({ text: `Sentence ${i}` })));
    engine.play(0);
    await flush();
    const queued = player.queued.length;
    const fetched = requested.length;
    player.playbackTime = 20;
    (player as unknown as { onProgress: (() => void) | null }).onProgress?.();
    await flush();
    expect(player.queued.length).toBeGreaterThan(queued);
    expect(requested.length).toBeGreaterThan(fetched);
  });

  it('queues a sentence inserted right after the last queued one', async () => {
    const { engine, player, requested } = setup();
    const units = Array.from({ length: 40 }, (_, i) => ({ text: `Sentence ${i}` }));
    engine.setUnits(units);
    engine.play(0);
    await flush();
    const at = player.queued.length; // the first unit not queued yet
    engine.setUnits([...units.slice(0, at), { text: 'Inserted i' }, ...units.slice(at)], null);
    player.playbackTime = 10;
    runFrame();
    await flush();
    expect(requested).toContain('Inserted i');
  });

  it('keeps playing when an edit removes the sentence waiting to be queued', async () => {
    const { engine, player, requested } = setup();
    const units = Array.from({ length: 40 }, (_, i) => ({ text: `Sentence ${i}` }));
    engine.setUnits(units);
    engine.play(0);
    await flush();
    const queued = player.queued.length;
    const next = queued; // 1 s sentences, no pauses: the first one not queued yet
    const edited = units.filter((_, i) => i !== next);
    engine.setUnits(edited, null);
    expect(player.queued.length).toBe(queued); // no restart
    requested.length = 0;
    player.playbackTime = 10;
    runFrame();
    await flush();
    expect(player.queued.length).toBeGreaterThan(queued);
    expect(requested).not.toContain(`Sentence ${next}`);

    // An edit that ends the page with what is queued drains it.
    engine.setUnits(edited.slice(0, player.queued.length), null);
    expect(player.drained).toBe(true);
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

  it('reads another source (a comment), then is back on the page where it was', async () => {
    const { engine, player, requested, highlights } = setup();
    engine.setUnits([{ text: 'Page one' }, { text: 'Page two' }, { text: 'Page three' }]);
    engine.playPage(1);
    await flush();
    runFrame();
    expect(highlights.at(-1)).toMatchObject({ source: PAGE_SOURCE, unit: 1 });

    requested.length = 0;
    engine.playOther('comment:t1', [{ text: 'Nice point' }, { text: 'Agreed' }], 0);
    await flush();
    expect(requested).toEqual(['Nice point', 'Agreed']);
    expect(engine.getSnapshot()).toMatchObject({ source: 'comment:t1', unitCount: 2 });
    runFrame();
    expect(highlights.at(-1)).toMatchObject({ source: 'comment:t1', unit: 0 });

    // The page changes meanwhile: kept for later, not read now.
    engine.setUnits([{ text: 'Page one' }, { text: 'Page two' }, { text: 'Page three' }, { text: 'Page four' }]);
    expect(engine.getSnapshot().unitCount).toBe(2);

    // The comment ends: back on the page, and Play goes on from page sentence 1.
    player.onEmpty?.();
    expect(engine.getSnapshot()).toMatchObject({ source: PAGE_SOURCE, status: 'idle', unitCount: 4 });
    requested.length = 0;
    engine.play();
    await flush();
    expect(requested[0]).toBe('Page two');
  });

  it('goes from a comment straight back to a clicked page sentence', async () => {
    const { engine, requested } = setup();
    engine.setUnits([{ text: 'Page one' }, { text: 'Page two' }]);
    engine.playPage(0);
    engine.playOther('comment:t1', [{ text: 'Hello' }]);
    requested.length = 0;
    engine.playPage(1);
    await flush();
    expect(engine.getSnapshot().source).toBe(PAGE_SOURCE);
    expect(requested[0]).toBe('Page two');
  });

  it('resumes the page at the same sentence after an edit above it during a comment', async () => {
    const { engine, requested } = setup();
    engine.setUnits([{ text: 'Page one' }, { text: 'Page two' }, { text: 'Page three' }]);
    engine.playPage(2);
    await flush();
    runFrame();
    engine.playOther('comment:t1', [{ text: 'Hello' }]);
    // Two sentences inserted above; the caller's mapping (here a stale one) is only a hint.
    engine.setUnits([{ text: 'New a' }, { text: 'New b' }, { text: 'Page one' }, { text: 'Page two' }, { text: 'Page three' }], 0);
    engine.stop();
    requested.length = 0;
    engine.play();
    await flush();
    expect(requested[0]).toBe('Page three');
  });
});
