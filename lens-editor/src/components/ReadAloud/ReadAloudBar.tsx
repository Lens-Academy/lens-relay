/**
 * The read-aloud player bar, after lens-platform's ImmersionBar: back, play /
 * pause and forward by sentence, an always-visible speed slider, a settings
 * popover (highlight, voice) and close; a "Back to current sentence" pill when
 * the listener has scrolled away. Space, [ / ], the arrow keys and < / > (speed,
 * as on YouTube) work while focus is not in the editor or a field
 * (`lib/read-aloud/keys.ts`; an HTML preview forwards them from its frame).
 *
 * Shown at the bottom of its (relatively positioned) container, centred under
 * the editor's text column when there is one.
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useReadAloudSnapshot } from './useReadAloudSnapshot';
import { Icon } from '../Icon';
import type { ReadAloudEngine } from '../../lib/read-aloud/engine';
import { loadVoices, type Voice } from '../../lib/read-aloud/api';
import { MAX_SPEAKING_RATE, MIN_SPEAKING_RATE, SPEAKING_RATE_STEP } from '../../lib/read-aloud/prefs';
import { applyReadAloudKey, readAloudKeyFor } from '../../lib/read-aloud/keys';


export function ReadAloudBar({ engine }: { engine: ReadAloudEngine | null }) {
  const snap = useReadAloudSnapshot(engine);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const regionRef = useRef<HTMLDivElement>(null);
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
      const key = readAloudKeyFor(e);
      if (!key) return;
      e.preventDefault();
      if (key !== 'swallow') applyReadAloudKey(engine, key);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, engine]);


  // Centred under the text column rather than the page area, which is wider
  // on one side; measured again as the sidebars and window change its width
  useLayoutEffect(() => {
    const region = regionRef.current;
    const area = region?.parentElement;
    if (!open || !region || !area) return;
    const centre = () => {
      const column = area.querySelector('.cm-content');
      if (!column) {
        region.style.transform = '';
        return;
      }
      const page = area.getBoundingClientRect();
      const text = column.getBoundingClientRect();
      region.style.transform = `translateX(${Math.round(text.left + text.width / 2 - (page.left + page.width / 2))}px)`;
    };
    centre();
    const observer = new ResizeObserver(centre);
    observer.observe(area);
    const column = area.querySelector('.cm-content');
    if (column) observer.observe(column);
    return () => observer.disconnect();
  }, [open]);

  if (!engine || !snap || !open) return null;
  const playing = snap.status === 'playing';
  const loading = snap.status === 'loading';
  const rate = snap.prefs.speakingRate;
  const fill = ((rate - MIN_SPEAKING_RATE) / (MAX_SPEAKING_RATE - MIN_SPEAKING_RATE)) * 100;

  return (
    <div
      ref={regionRef}
      role="region"
      aria-label="Read-aloud controls"
      data-read-aloud-bar
      className="lens-player-region"
    >
      {snap.autoScrollPaused && snap.status !== 'idle' && (
        <button
          type="button"
          onClick={() => engine.setAutoScrollPaused(false)}
          aria-label="Scroll back to current sentence and resume auto-scroll"
          className="lens-player-back"
        >
          <Icon name="locate-fixed" className="h-3.5 w-3.5" />
          Back to current sentence
        </button>
      )}

      <div className="lens-player">
        <button type="button" aria-label="Skip back to previous sentence" title="Previous sentence ([)" onClick={() => engine.skip(-1)} className="lens-player-button" disabled={snap.unitCount === 0}>
          <Icon name="skip-back" className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label={playing || loading ? 'Pause' : 'Play'}
          title={playing || loading ? 'Pause (Space)' : 'Play (Space)'}
          onClick={() => engine.toggle()}
          disabled={snap.unitCount === 0}
          className="lens-player-play"
        >
          {loading ? (
            <Icon name="loader" className="h-4 w-4 animate-spin" />
          ) : (
            <Icon name={playing ? 'pause' : 'play'} className="h-4 w-4" />
          )}
        </button>
        <button type="button" aria-label="Skip ahead to next sentence" title="Next sentence (])" onClick={() => engine.skip(1)} className="lens-player-button" disabled={snap.unitCount === 0}>
          <Icon name="skip-forward" className="h-4 w-4" />
        </button>

        <span className="lens-player-divider" aria-hidden="true" />
        <label className="lens-player-speed" title="Speed (< slower, > faster)">
          <input
            type="range"
            min={MIN_SPEAKING_RATE}
            max={MAX_SPEAKING_RATE}
            step={SPEAKING_RATE_STEP}
            value={rate}
            onChange={e => engine.setPrefs({ speakingRate: Number(e.target.value) })}
            aria-label="Playback speed"
            aria-valuetext={`${rate}×`}
            className="lens-player-slider"
            style={{ '--fill': `${fill}%` } as CSSProperties}
          />
          <span className="lens-player-rate">{rate}×</span>
        </label>
        <span className="lens-player-divider" aria-hidden="true" />

        <div ref={settingsRef} className="relative">
          <button
            type="button"
            aria-label="Reading settings"
            aria-expanded={settingsOpen}
            aria-haspopup="dialog"
            onClick={() => setSettingsOpen(o => !o)}
            className={`lens-player-button${settingsOpen ? ' is-on' : ''}`}
          >
            <Icon name="settings" className="h-4 w-4" />
          </button>
          {settingsOpen && (
            <div role="dialog" aria-label="Reading settings" className="lens-popover lens-player-settings">
              <div className="mb-3">
                <div className="lens-player-label">Highlight</div>
                <div className="lens-segmented">
                  {(['sentence', 'word'] as const).map(mode => (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={snap.prefs.highlightMode === mode}
                      onClick={() => engine.setPrefs({ highlightMode: mode })}
                    >
                      {mode === 'sentence' ? 'Sentence' : 'Word'}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="lens-player-label">Voice</div>
                <select
                  value={snap.prefs.voiceId}
                  onChange={e => engine.setPrefs({ voiceId: e.target.value })}
                  disabled={voices.length === 0}
                  className="lens-input w-full"
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

        <button type="button" aria-label="Close read-aloud" title="Close" onClick={() => { setSettingsOpen(false); engine.close(); }} className="lens-player-button">
          <Icon name="x" className="h-4 w-4" />
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
