/**
 * The read-aloud player bar, after lens-platform's ImmersionBar: back, play /
 * pause and forward by sentence, a settings popover (highlight, speed,
 * voice) and close; a "Back to current sentence" pill when the listener has
 * scrolled away. Space, [ / ] and the arrow keys work while focus is not in
 * the editor or a field.
 *
 * Shown at the bottom centre of its (relatively positioned) container.
 */

import { useEffect, useRef, useState } from 'react';
import { useReadAloudSnapshot } from './useReadAloudSnapshot';
import { Icon } from '../Icon';
import type { ReadAloudEngine } from '../../lib/read-aloud/engine';
import { loadVoices, type Voice } from '../../lib/read-aloud/api';
import { MAX_SPEAKING_RATE, MIN_SPEAKING_RATE, SPEAKING_RATE_STEP } from '../../lib/read-aloud/prefs';


export function ReadAloudBar({ engine }: { engine: ReadAloudEngine | null }) {
  const snap = useReadAloudSnapshot(engine);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const open = snap?.open ?? false;

  useEffect(() => {
    if (!open || voices.length) return;
    let cancelled = false;
    loadVoices().then(
      list => { if (!cancelled) setVoices(list); },
      err => { if (!cancelled) setVoicesError(String(err?.message ?? err)); },
    );
    return () => { cancelled = true; };
  }, [open, voices.length]);

  // Close the settings popover on an outside click or Escape.
  useEffect(() => {
    if (!settingsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!settingsRef.current?.contains(e.target as Node)) setSettingsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSettingsOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [settingsOpen]);

  useEffect(() => {
    if (!open || !engine) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      if (e.code === 'Space') {
        e.preventDefault();
        engine.toggle();
      } else if (e.key === ']' || e.key === 'ArrowRight') {
        e.preventDefault();
        engine.skip(1);
      } else if (e.key === '[' || e.key === 'ArrowLeft') {
        e.preventDefault();
        engine.skip(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, engine]);

  if (!engine || !snap || !open) return null;
  const playing = snap.status === 'playing';
  const loading = snap.status === 'loading';
  const iconBtn = 'rounded-md p-2 text-gray-700 hover:bg-gray-100 disabled:opacity-40 cursor-pointer';

  return (
    <div
      role="region"
      aria-label="Read-aloud controls"
      data-read-aloud-bar
      className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center pb-[env(safe-area-inset-bottom)]"
    >
      {snap.autoScrollPaused && snap.status !== 'idle' && (
        <button
          type="button"
          onClick={() => engine.setAutoScrollPaused(false)}
          aria-label="Scroll back to current sentence and resume auto-scroll"
          className="pointer-events-auto absolute -top-12 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-[#b87018] px-4 py-2 text-sm font-medium text-white shadow-lg transition hover:brightness-105 active:scale-95 cursor-pointer"
        >
          <Icon name="locate-fixed" className="h-3.5 w-3.5" />
          Back to current sentence
        </button>
      )}

      <div className="pointer-events-auto relative m-3 inline-flex items-center gap-1.5 rounded-2xl border border-[#fde6c8] bg-white/95 px-2.5 py-2 shadow-lg backdrop-blur">
        <button type="button" aria-label="Skip back to previous sentence" title="Previous sentence ([)" onClick={() => engine.skip(-1)} className={iconBtn} disabled={snap.unitCount === 0}>
          <Icon name="skip-back" className="h-[18px] w-[18px]" />
        </button>
        <button
          type="button"
          aria-label={playing || loading ? 'Pause' : 'Play'}
          title={playing || loading ? 'Pause (Space)' : 'Play (Space)'}
          onClick={() => engine.toggle()}
          disabled={snap.unitCount === 0}
          className="rounded-full bg-[#b87018] p-3 text-white hover:brightness-105 disabled:opacity-50 cursor-pointer"
        >
          {loading ? (
            <Icon name="loader" className="h-[18px] w-[18px] animate-spin" />
          ) : (
            <Icon name={playing ? 'pause' : 'play'} className="h-[18px] w-[18px]" />
          )}
        </button>
        <button type="button" aria-label="Skip ahead to next sentence" title="Next sentence (])" onClick={() => engine.skip(1)} className={iconBtn} disabled={snap.unitCount === 0}>
          <Icon name="skip-forward" className="h-[18px] w-[18px]" />
        </button>

        <div ref={settingsRef} className="relative ml-3">
          <button
            type="button"
            aria-label="Reading settings"
            aria-expanded={settingsOpen}
            aria-haspopup="dialog"
            onClick={() => setSettingsOpen(o => !o)}
            className={`rounded-md p-2 text-gray-700 transition cursor-pointer ${settingsOpen ? 'bg-gray-100' : 'hover:bg-gray-100'}`}
          >
            <Icon name="settings" className="h-[18px] w-[18px]" />
          </button>
          {settingsOpen && (
            <div
              role="dialog"
              aria-label="Reading settings"
              className="absolute bottom-full right-0 z-50 mb-2 w-72 rounded-xl border border-gray-200 bg-white p-3 shadow-xl"
            >
              <div className="mb-3">
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">Highlight</div>
                <div className="flex gap-1 rounded-lg bg-gray-100 p-0.5">
                  {(['sentence', 'word'] as const).map(mode => {
                    const active = snap.prefs.highlightMode === mode;
                    return (
                      <button
                        key={mode}
                        type="button"
                        aria-pressed={active}
                        onClick={() => engine.setPrefs({ highlightMode: mode })}
                        className={`flex-1 rounded-md px-2 py-1 text-sm font-medium transition cursor-pointer ${active ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}
                      >
                        {mode === 'sentence' ? 'Sentence' : 'Word'}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="mb-3">
                <div className="mb-1.5 flex items-baseline justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Speed</span>
                  <span className="text-xs font-medium tabular-nums text-gray-900">{snap.prefs.speakingRate}×</span>
                </div>
                <input
                  type="range"
                  min={MIN_SPEAKING_RATE}
                  max={MAX_SPEAKING_RATE}
                  step={SPEAKING_RATE_STEP}
                  value={snap.prefs.speakingRate}
                  onChange={e => engine.setPrefs({ speakingRate: Number(e.target.value) })}
                  aria-label="Playback speed"
                  className="w-full accent-[#b87018]"
                />
                <div className="flex justify-between text-[10px] tabular-nums text-gray-400">
                  <span>{MIN_SPEAKING_RATE}×</span>
                  <span>{MAX_SPEAKING_RATE}×</span>
                </div>
              </div>

              <div>
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">Voice</div>
                <select
                  value={snap.prefs.voiceId}
                  onChange={e => engine.setPrefs({ voiceId: e.target.value })}
                  disabled={voices.length === 0}
                  className="w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm"
                >
                  {voices.length === 0 ? (
                    <option value={snap.prefs.voiceId}>{snap.prefs.voiceId}</option>
                  ) : (
                    voices.map(v => <option key={v.id} value={v.id}>{v.displayName}</option>)
                  )}
                </select>
                {voicesError && <div className="mt-1 text-xs text-red-600">Couldn't load voices: {voicesError}</div>}
              </div>
            </div>
          )}
        </div>

        <button type="button" aria-label="Close read-aloud" title="Close" onClick={() => { setSettingsOpen(false); engine.close(); }} className={iconBtn}>
          <Icon name="x" className="h-[18px] w-[18px]" />
        </button>

        {snap.error && (
          <div role="alert" className="absolute bottom-full left-1/2 mb-2 w-max max-w-xs -translate-x-1/2 rounded-lg bg-red-50 px-3 py-1.5 text-xs text-red-700 shadow">
            {snap.error}
          </div>
        )}
      </div>
    </div>
  );
}
