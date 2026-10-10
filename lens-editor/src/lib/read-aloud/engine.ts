/**
 * The read-aloud engine: plays a list of sentences ("units") through
 * Speechify, fetching a few ahead, and reports which sentence and word are
 * being heard. It knows nothing about where the text came from: the Markdown
 * editor and the HTML preview each build units from their own text and turn
 * the reported positions into highlights.
 *
 * A slimmed port of lens-platform's useImmersionPlayback: one request per
 * sentence, all audio into one gapless worklet queue, each sentence placed on
 * a timeline by the bytes queued before it, and the heard word found by
 * binary search over Speechify's word timings. No audio is kept across
 * sessions (no cache): a sentence is fetched again whenever it is played again
 * after a restart.
 */

import { PcmPlayer, PCM_SAMPLE_RATE } from './player';
import { streamSpeech, TtsUnavailableError, type StreamEvent } from './api';
import { findActiveWord, findSpokenWord, prepareTtsText, type CharRange } from './text';
import { loadPrefs, savePrefs, type ReadAloudPrefs } from './prefs';

export interface ReadingUnit {
  /** The sentence as shown; word positions are offsets into it. */
  text: string;
  /** Silence before it, in seconds (a pause between blocks). */
  pauseBefore?: number;
}

export type ReadAloudStatus = 'idle' | 'loading' | 'playing' | 'paused';

export interface ReadAloudSnapshot {
  status: ReadAloudStatus;
  /** The unit being heard (or about to be), null when idle. */
  current: number | null;
  unitCount: number;
  prefs: ReadAloudPrefs;
  /** Why playback stopped, when it stopped on an error. */
  error: string | null;
  /** The player bar is shown (Listen was pressed and the bar not closed). */
  open: boolean;
  /** The listener scrolled away, so the page no longer follows the sentence. */
  autoScrollPaused: boolean;
}

export interface ReadAloudHighlight {
  unit: number;
  /** The heard word within the unit's text; null in sentence mode or between words. */
  word: CharRange | null;
}

export type FetchSpeech = (
  text: string,
  opts: { voiceId: string; speakingRate: number; signal: AbortSignal },
) => AsyncIterable<StreamEvent>;

interface Entry {
  text: string;
  chunks: Uint8Array[];
  bytes: number;
  starts: number[];
  ranges: Array<CharRange | null>;
  cursor: number;
  done: boolean;
  failed: boolean;
  abort: AbortController;
}

interface Placed {
  unit: number;
  entry: Entry;
  start: number;
  /** Known once the unit's audio is complete. */
  end: number | null;
}

const BASE_PREFETCH = 2;
const RESTART_DEBOUNCE_MS = 250;

/** Sentences fetched ahead: more at high speed, where each covers less time. */
export function prefetchDepthFor(rate: number): number {
  return rate <= 1.5 ? BASE_PREFETCH : BASE_PREFETCH + Math.ceil((rate - 1.5) / 0.75);
}

export class ReadAloudEngine {
  private units: ReadingUnit[] = [];
  private entries = new Map<number, Entry>();
  /** Units fed into the player since the last reset, in order. */
  private timeline: Placed[] = [];
  /** Seconds of audio (and silence) queued since the last reset. */
  private queued = 0;
  /** The unit whose audio is going into the player now; null when all is queued. */
  private feeding: number | null = null;
  private paused = false;
  private active = false;
  private raf = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private lastHighlight: ReadAloudHighlight | null = null;
  private listeners = new Set<() => void>();
  private highlightListeners = new Set<(h: ReadAloudHighlight | null) => void>();
  private snapshot: ReadAloudSnapshot;

  constructor(
    private readonly fetchSpeech: FetchSpeech = streamSpeech,
    private readonly player = new PcmPlayer(),
  ) {
    this.snapshot = {
      status: 'idle', current: null, unitCount: 0, prefs: loadPrefs(), error: null, open: false, autoScrollPaused: false,
    };
    this.player.onEmpty = () => this.finish();
  }

  // -- store interface (useSyncExternalStore) --

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.snapshot;

  private update(patch: Partial<ReadAloudSnapshot>) {
    const next = { ...this.snapshot, ...patch };
    if (Object.keys(patch).every(k => next[k as keyof ReadAloudSnapshot] === this.snapshot[k as keyof ReadAloudSnapshot])) return;
    this.snapshot = next;
    for (const fn of this.listeners) fn();
  }

  /** Be told whenever the heard sentence or word changes (null when stopped). */
  onHighlight(fn: (h: ReadAloudHighlight | null) => void): () => void {
    this.highlightListeners.add(fn);
    return () => this.highlightListeners.delete(fn);
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Playing or about to (loading): what "audio is playing" means for clicks. */
  get isPlaying(): boolean {
    return this.active && !this.paused;
  }

  // -- units --

  /**
   * Replace the units, e.g. after an edit. `current` is the new index of the
   * unit being heard (the caller maps it through the edit). Fetched audio is
   * kept for every unit whose text is unchanged.
   */
  setUnits(units: ReadingUnit[], current?: number | null) {
    const old = this.units;
    this.units = units;
    this.update({ unitCount: units.length });
    if (!this.active) return;
    const shift = current != null && this.snapshot.current != null ? current - this.snapshot.current : 0;
    const remap = (i: number): number => {
      const text = old[i]?.text;
      for (const d of [0, 1, -1, 2, -2, 3, -3]) {
        const j = i + shift + d;
        if (units[j]?.text === text) return j;
      }
      return -1;
    };
    const entries = new Map<number, Entry>();
    for (const [i, entry] of this.entries) {
      const j = remap(i);
      if (j >= 0 && !entries.has(j)) entries.set(j, entry);
      else if (!this.timeline.some(p => p.entry === entry)) entry.abort.abort();
    }
    this.entries = entries;
    for (const placed of this.timeline) placed.unit = remap(placed.unit);
    if (this.feeding != null) {
      const j = remap(this.feeding);
      if (j < 0) {
        // The sentence being fed was edited away: carry on from where the
        // caller says the listener is.
        this.startAt(Math.min(current ?? 0, units.length - 1));
        return;
      }
      this.feeding = j;
    }
    const heard = this.heardPlacement();
    this.update({ current: heard?.unit ?? this.feeding ?? null });
    this.lastHighlight = null;
    this.prefetch();
  }

  // -- controls --

  /** Show the player bar. */
  open() {
    this.update({ open: true });
  }

  /** Stop and hide the player bar. */
  close() {
    this.stop();
    this.update({ open: false, error: null });
  }

  /** The listener scrolled away (true), or asked to follow again (false). */
  setAutoScrollPaused(paused: boolean) {
    this.update({ autoScrollPaused: paused });
  }

  /** Start (or restart) at unit `from`; resume when paused and no unit is given. Call from a user gesture. */
  play(from?: number) {
    void this.player.resume();
    if (from == null && this.active && this.paused) {
      this.paused = false;
      this.update({ status: this.statusNow() });
      return;
    }
    const start = from ?? this.snapshot.current ?? 0;
    if (start < 0 || start >= this.units.length) return;
    this.paused = false;
    this.update({ open: true, autoScrollPaused: false });
    this.startAt(start);
  }

  pause() {
    if (!this.active) return;
    this.paused = true;
    void this.player.suspend();
    this.update({ status: 'paused' });
  }

  toggle() {
    if (this.isPlaying) this.pause();
    else this.play();
  }

  skip(delta: 1 | -1) {
    const cur = this.snapshot.current ?? 0;
    const next = Math.min(this.units.length - 1, Math.max(0, cur + delta));
    if (!this.active) {
      this.update({ current: next });
      return;
    }
    if (next !== cur || delta < 0) this.play(next);
  }

  stop() {
    this.active = false;
    this.paused = false;
    this.clearRestart();
    this.player.close();
    for (const entry of this.entries.values()) entry.abort.abort();
    this.entries.clear();
    this.timeline = [];
    this.queued = 0;
    this.feeding = null;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.emitHighlight(null);
    this.update({ status: 'idle', current: null });
  }

  setPrefs(patch: Partial<ReadAloudPrefs>) {
    const prefs = { ...this.snapshot.prefs, ...patch };
    savePrefs(prefs);
    const restart = (patch.speakingRate !== undefined && patch.speakingRate !== this.snapshot.prefs.speakingRate)
      || (patch.voiceId !== undefined && patch.voiceId !== this.snapshot.prefs.voiceId);
    this.update({ prefs });
    this.lastHighlight = null;
    if (restart && this.active) {
      // Audio is synthesized at the chosen speed and voice, so everything
      // fetched is stale. Debounced so dragging the slider restarts once.
      this.clearRestart();
      const at = this.snapshot.current ?? 0;
      for (const entry of this.entries.values()) entry.abort.abort();
      this.entries.clear();
      this.player.reset();
      this.timeline = [];
      this.queued = 0;
      this.feeding = null;
      this.update({ status: this.paused ? 'paused' : 'loading' });
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.startAt(at);
      }, RESTART_DEBOUNCE_MS);
    }
  }

  destroy() {
    this.stop();
    this.listeners.clear();
    this.highlightListeners.clear();
  }

  // -- internals --

  private clearRestart() {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private startAt(index: number) {
    this.clearRestart();
    this.active = true;
    this.update({ error: null });
    this.player.reset();
    this.timeline = [];
    this.queued = 0;
    // Keep fetched audio near the new position (skip back, skip ahead); drop the rest.
    const depth = prefetchDepthFor(this.snapshot.prefs.speakingRate);
    for (const [i, entry] of this.entries) {
      if (i < index - 2 || i > index + depth || entry.failed || this.units[i]?.text !== entry.text) {
        entry.abort.abort();
        this.entries.delete(i);
      }
    }
    this.feeding = index;
    this.update({ current: index, status: this.paused ? 'paused' : 'loading' });
    this.lastHighlight = null;
    this.feed();
    this.prefetch();
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  private entryFor(i: number): Entry {
    let entry = this.entries.get(i);
    if (entry) return entry;
    const text = this.units[i].text;
    entry = {
      text, chunks: [], bytes: 0, starts: [], ranges: [], cursor: 0,
      done: false, failed: false, abort: new AbortController(),
    };
    this.entries.set(i, entry);
    void this.load(entry);
    return entry;
  }

  private async load(entry: Entry) {
    const { voiceId, speakingRate } = this.snapshot.prefs;
    try {
      for await (const event of this.fetchSpeech(prepareTtsText(entry.text), { voiceId, speakingRate, signal: entry.abort.signal })) {
        if (entry.abort.signal.aborted) return;
        if (event.type === 'audio') {
          entry.chunks.push(event.pcm);
          entry.bytes += event.pcm.byteLength;
          if (this.feedingEntry() === entry) {
            this.player.push(event.pcm);
            this.queued += event.pcm.byteLength / 2 / PCM_SAMPLE_RATE;
          }
        } else if (event.type === 'timestamps') {
          this.addTimings(entry, event);
        }
      }
      entry.done = true;
    } catch (err) {
      if (entry.abort.signal.aborted) return;
      entry.failed = true;
      entry.done = true;
      if (err instanceof TtsUnavailableError) {
        this.stop();
        this.update({ error: err.message });
        return;
      }
      console.warn('[read-aloud] sentence skipped:', err);
    }
    if (this.feedingEntry() === entry) this.advance();
  }

  private addTimings(entry: Entry, msg: Extract<StreamEvent, { type: 'timestamps' }>) {
    msg.words.forEach((token, k) => {
      const word = token.trim();
      const range = findSpokenWord(entry.text, entry.cursor, word, Math.min(60, entry.text.length - entry.cursor));
      if (range) entry.cursor = range.end;
      entry.starts.push(msg.wordStartTimeSeconds[k]);
      entry.ranges.push(range);
    });
  }

  private feedingEntry(): Entry | null {
    return this.feeding == null ? null : this.entries.get(this.feeding) ?? null;
  }

  /** Put the feeding unit on the timeline and queue what it has so far. */
  private feed() {
    const i = this.feeding;
    if (i == null) return;
    const pause = this.timeline.length ? this.units[i].pauseBefore ?? 0 : 0;
    if (pause > 0) {
      this.player.pushSilence(pause);
      this.queued += pause;
    }
    const entry = this.entryFor(i);
    this.timeline.push({ unit: i, entry, start: this.queued, end: null });
    for (const chunk of entry.chunks) {
      this.player.push(chunk);
      this.queued += chunk.byteLength / 2 / PCM_SAMPLE_RATE;
    }
    if (entry.done) this.advance();
  }

  /** The feeding unit is complete: close its span and move on. */
  private advance() {
    const placed = this.timeline[this.timeline.length - 1];
    if (placed) placed.end = this.queued;
    const next = (this.feeding ?? -1) + 1;
    if (next >= this.units.length) {
      this.feeding = null;
      this.player.drain();
      return;
    }
    this.feeding = next;
    this.feed();
    this.prefetch();
  }

  private prefetch() {
    if (this.feeding == null) return;
    const depth = prefetchDepthFor(this.snapshot.prefs.speakingRate);
    for (let i = this.feeding; i <= Math.min(this.units.length - 1, this.feeding + depth); i++) this.entryFor(i);
  }

  private heardPlacement(): Placed | null {
    const t = this.player.playbackTime;
    for (let k = this.timeline.length - 1; k >= 0; k--) {
      if (this.timeline[k].start <= t) return this.timeline[k];
    }
    return this.timeline[0] ?? null;
  }

  private statusNow(): ReadAloudStatus {
    if (!this.active) return 'idle';
    if (this.paused) return 'paused';
    // Loading while nothing queued is left to hear.
    return this.player.playbackTime + 0.05 >= this.queued ? 'loading' : 'playing';
  }

  private tick = () => {
    this.raf = 0;
    if (!this.active) return;
    const placed = this.heardPlacement();
    if (placed && placed.unit >= 0) {
      const t = this.player.playbackTime - placed.start;
      let word: CharRange | null = null;
      if (this.snapshot.prefs.highlightMode === 'word' && (placed.end == null || this.player.playbackTime < placed.end)) {
        let k = findActiveWord(placed.entry.starts, t);
        while (k >= 0 && !placed.entry.ranges[k]) k--;
        word = k >= 0 ? placed.entry.ranges[k] : null;
      }
      this.emitHighlight({ unit: placed.unit, word });
      this.update({ current: placed.unit, status: this.statusNow() });
    } else {
      this.update({ status: this.statusNow() });
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private emitHighlight(h: ReadAloudHighlight | null) {
    const prev = this.lastHighlight;
    if (prev === h) return;
    if (prev && h && prev.unit === h.unit && prev.word?.start === h.word?.start && prev.word?.end === h.word?.end) return;
    this.lastHighlight = h;
    for (const fn of this.highlightListeners) fn(h);
  }

  private finish() {
    if (!this.active || this.feeding != null) return;
    this.stop();
  }
}
