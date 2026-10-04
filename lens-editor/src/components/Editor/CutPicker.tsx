import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  candidates,
  clipEndVolume,
  cutBefore,
  formatTime,
  suggestCut,
  type Word,
} from '../../lib/videoCuts';
import { loadYouTubeApi, type YouTubePlayer } from '../../lib/youtubeApi';
import type { SegmentTimeField } from '../../lib/segmentTime';

const STEPS = [0.1, 0.25, 0.5, 1];
const LEADS = [1.5, 2.5, 4];
const POLL_MS = 20;
const GAP_BETWEEN_MS = 450;
const START_TIMEOUT_MS = 8000;

interface CutPickerProps {
  videoId: string;
  /** Word timings from the transcript's sidecar; null when it has none. */
  words: Word[] | null;
  /** Current `from::` / `to::` in seconds (`to` may be missing). */
  from: number;
  to: number | null;
  /** Writes the chosen time into the segment; absent when the viewer may
   *  not edit. */
  onUse?: (field: SegmentTimeField, value: string) => void;
  onClose: () => void;
  /** Which time to tune first. */
  initialField?: SegmentTimeField;
  title?: string;
}

/**
 * Tune a video segment's start or end by ear: a row of candidate cuts around
 * the current one, each playing the seconds that lead up to it (end) or
 * follow it (start), stopped the way the platform stops a clip.
 */
export function CutPicker({ videoId, words, from, to, onUse, onClose, initialField, title }: CutPickerProps) {
  const [field, setField] = useState<SegmentTimeField>(initialField ?? (to !== null ? 'to' : 'from'));
  const current = field === 'to' ? to : from;
  const [step, setStep] = useState(0.25);
  const [lead, setLead] = useState(2.5);
  const [centre, setCentre] = useState<number>(current ?? 0);
  const [selected, setSelected] = useState<number>(current ?? 0);
  const [playing, setPlaying] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);

  const mountRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YouTubePlayer | null>(null);
  const runRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  // The listener's own volume: read when idle, put back after every fade
  const volumeRef = useRef(100);
  const restoreTimerRef = useRef<number | null>(null);
  const resolveRef = useRef<(() => void) | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Take the keys (← → Space) as soon as the picker opens
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const suggestion = useMemo(
    () => (words && current !== null ? suggestCut(words, current) : null),
    [words, current],
  );

  useEffect(() => {
    let cancelled = false;
    loadYouTubeApi()
      .then((YT) => {
        if (cancelled || !mountRef.current) return;
        const target = document.createElement('div');
        mountRef.current.appendChild(target);
        playerRef.current = new YT.Player(target, {
          videoId,
          width: '100%',
          height: '100%',
          playerVars: { controls: 1, rel: 0, playsinline: 1, modestbranding: 1 },
          events: {
            onReady: () => {
              if (cancelled) return;
              volumeRef.current = playerRef.current?.getVolume() || 100;
              setReady(true);
            },
          },
        });
      })
      .catch((e: Error) => !cancelled && setLoadError(e.message));
    const runs = runRef;
    return () => {
      cancelled = true;
      runs.current++;
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      if (restoreTimerRef.current !== null) window.clearTimeout(restoreTimerRef.current);
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, [videoId]);

  /** Stop whatever plays (a candidate, or Play all) and put the listener's
   *  volume back. */
  const stop = useCallback(() => {
    runRef.current++;
    resolveRef.current?.();
    resolveRef.current = null;
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    const player = playerRef.current;
    if (player) {
      player.pauseVideo();
      if (restoreTimerRef.current !== null) {
        window.clearTimeout(restoreTimerRef.current);
        restoreTimerRef.current = null;
      }
      player.setVolume(volumeRef.current);
    }
    setPlaying(null);
  }, []);

  /** Play one candidate; resolves when it has stopped (or was interrupted). */
  const play = useCallback(
    (cut: number): Promise<boolean> => {
      const player = playerRef.current;
      if (!player) return Promise.resolve(false);
      // Idle and not fading: the player's volume is the listener's choice
      if (timerRef.current === null && restoreTimerRef.current === null) {
        volumeRef.current = player.getVolume() || volumeRef.current;
      }
      stop();
      const startAt = field === 'to' ? Math.max(0, cut - lead) : cut;
      const stopAt = field === 'to' ? cut : cut + lead;
      const volume = volumeRef.current;
      setPlaying(cut);
      player.seekTo(startAt, true);
      player.playVideo();
      const startedAt = Date.now();
      let lastShare = 1;
      return new Promise((resolve) => {
        // stop() ends this run without the poll seeing it: resolve then too
        resolveRef.current = () => resolve(false);
        const finish = (ok: boolean) => {
          resolveRef.current = null;
          window.clearInterval(timerRef.current!);
          timerRef.current = null;
          setPlaying(null);
          resolve(ok);
        };
        timerRef.current = window.setInterval(() => {
          const t = player.getCurrentTime();
          // Until the seek has landed the player reports the old position
          if (t < startAt - 0.3 || t > stopAt + 1) {
            if (Date.now() - startedAt > START_TIMEOUT_MS) {
              player.pauseVideo();
              setPlayError('YouTube did not start the video. Press play in the video once, then try again.');
              finish(false);
            }
            return;
          }
          setPlayError(null);
          const share = clipEndVolume(t, stopAt);
          if (share > 0) {
            if (share !== lastShare) player.setVolume(Math.round(volume * share));
            lastShare = share;
            return;
          }
          player.setVolume(0);
          player.pauseVideo();
          // The volume comes back once the pause has surely reached the player
          restoreTimerRef.current = window.setTimeout(() => {
            restoreTimerRef.current = null;
            player.setVolume(volumeRef.current);
          }, 250);
          finish(true);
        }, POLL_MS);
      });
    },
    [field, lead, stop],
  );

  const row = useMemo(() => candidates(centre, step), [centre, step]);

  const choose = useCallback(
    (cut: number) => {
      setSelected(cut);
      void play(cut);
    },
    [play],
  );

  const playAll = useCallback(async () => {
    for (const cut of row) {
      setSelected(cut);
      const finished = await play(cut);
      if (!finished) return;
      // A Stop (or any other play) during the gap ends the round
      const run = runRef.current;
      await new Promise((r) => window.setTimeout(r, GAP_BETWEEN_MS));
      if (runRef.current !== run) return;
    }
  }, [row, play]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      stop();
      onClose();
      return;
    }
    // Arrows and Space belong to the picker itself and its candidates;
    // other controls (selects, buttons) keep their own keys
    const target = e.target as HTMLElement;
    if (target !== e.currentTarget && !target.dataset.cut) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      const next = Math.max(0, Math.round((selected + dir * step) * 100) / 100);
      // Moving past either end of the row slides the row along
      if (next < row[0] - 0.001 || next > row[row.length - 1] + 0.001) setCentre(next);
      choose(next);
    } else if (e.key === ' ') {
      e.preventDefault();
      if (playing !== null) stop();
      else void play(selected);
    }
  };

  // The transcript around the cut, so a gap can be picked by clicking the
  // word the clip should end before (or start with)
  const nearby = useMemo(() => {
    if (!words) return [];
    const out: Array<{ word: Word; index: number }> = [];
    words.forEach((word, index) => {
      if (word.start >= centre - 7 && word.start <= centre + 4) out.push({ word, index });
    });
    return out;
  }, [words, centre]);

  const label = field === 'to' ? 'End' : 'Start';
  const unchanged = current !== null && Math.abs(selected - current) < 0.005;

  return (
    <div
      className="border-b border-[rgba(184,112,24,0.1)] bg-white/70 px-6 py-4 text-sm outline-none"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
      ref={rootRef}
      tabIndex={-1}
      aria-label="Cut picker"
      data-testid="cut-picker"
    >
      <div className="flex flex-wrap items-center gap-3 mb-3">
        {title && <div className="font-medium text-gray-800 truncate max-w-[320px]" title={title}>{title}</div>}
        <div className="inline-flex rounded-md border border-gray-200 overflow-hidden" role="tablist">
          {(['from', 'to'] as const).map((f) => (
            <button
              key={f}
              role="tab"
              aria-selected={field === f}
              onClick={() => {
                stop();
                setField(f);
                // Switching between start and end re-centres on that time
                const t = (f === 'to' ? to : from) ?? 0;
                setCentre(t);
                setSelected(t);
              }}
              className={`px-3 py-1 text-xs font-medium ${field === f ? 'bg-teal-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
            >
              {f === 'from' ? 'Start' : 'End'} ({f}::{' '}
              {(f === 'to' ? to : from) !== null ? formatTime((f === 'to' ? to : from)!) : 'none'})
            </button>
          ))}
        </div>
        <label className="text-xs text-gray-500">
          Step{' '}
          <select
            value={step}
            onChange={(e) => setStep(Number(e.target.value))}
            className="ml-1 border border-gray-200 rounded px-1 py-0.5"
          >
            {STEPS.map((s) => (
              <option key={s} value={s}>
                {s} s
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-gray-500">
          Play{' '}
          <select
            value={lead}
            onChange={(e) => setLead(Number(e.target.value))}
            className="ml-1 border border-gray-200 rounded px-1 py-0.5"
          >
            {LEADS.map((s) => (
              <option key={s} value={s}>
                {s} s {field === 'to' ? 'before' : 'after'}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={() => {
            stop();
            onClose();
          }}
          className="ml-auto text-xs text-gray-400 hover:text-gray-700"
          aria-label="Close cut picker"
        >
          Close
        </button>
      </div>

      <div className="flex gap-4 items-start">
        <div ref={mountRef} className="w-[420px] max-w-[45%] aspect-video shrink-0 bg-black rounded overflow-hidden" />
        <div className="flex-1 min-w-0">
          {(loadError || playError) && <div className="text-red-600 text-xs mb-2">{loadError ?? playError}</div>}
          <div className="text-xs text-gray-500 mb-2">
            {field === 'to'
              ? `Each button plays the ${lead} s before that end time and stops there, as on the platform.`
              : `Each button plays ${lead} s from that start time.`}{' '}
            ← → move and play, Space replays, Esc closes.
          </div>
          <div className="grid grid-cols-7 gap-1 mb-3">
            {row.map((cut) => {
              const isSelected = Math.abs(cut - selected) < 0.001;
              const isCurrent = current !== null && Math.abs(cut - current) < 0.001;
              const isSuggested = suggestion !== null && Math.abs(cut - suggestion.time) < 0.001;
              return (
                <button
                  key={cut}
                  data-cut={cut}
                  disabled={!ready}
                  onClick={() => choose(cut)}
                  aria-pressed={isSelected}
                  title={isSuggested ? 'Suggested from the word timings' : undefined}
                  className={`relative min-w-0 px-0.5 py-1.5 rounded border text-xs tabular-nums transition-colors disabled:opacity-40 ${
                    isSelected ? 'border-teal-600 bg-teal-50 text-teal-800' : 'border-gray-200 bg-white text-gray-700 hover:border-teal-400'
                  } ${playing !== null && Math.abs(cut - playing) < 0.001 ? 'ring-2 ring-teal-400' : ''}`}
                >
                  <div className="font-medium">{formatTime(cut)}</div>
                  <div className="text-[10px] text-gray-400">
                    {isCurrent ? 'now' : isSuggested ? '★ suggested' : `${cut - (current ?? cut) > 0 ? '+' : ''}${(cut - (current ?? cut)).toFixed(2)}`}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              disabled={!ready}
              onClick={() => (playing !== null ? stop() : void play(selected))}
              className="px-3 py-1 rounded border border-teal-600/50 bg-white text-xs font-medium text-teal-800 hover:bg-teal-50 disabled:opacity-40"
              title="Space"
            >
              {playing !== null ? '■ Stop' : `▶ Play ${formatTime(selected)}`}
            </button>
            <button
              disabled={!ready}
              onClick={() => void playAll()}
              className="px-3 py-1 rounded border border-gray-200 bg-white text-xs hover:border-teal-400 disabled:opacity-40"
            >
              Play all in turn
            </button>
            {suggestion && Math.abs(suggestion.time - selected) > 0.001 && (
              <button
                disabled={!ready}
                onClick={() => {
                  setCentre(suggestion.time);
                  choose(suggestion.time);
                }}
                title="The suggested cut sits just before the first word of the next sentence, from the transcript's word timings. This moves the row of times to it and plays it."
                className="px-3 py-1 rounded border border-gray-200 bg-white text-xs hover:border-teal-400 disabled:opacity-40"
              >
                ★ Try the suggested cut {formatTime(suggestion.time)}
              </button>
            )}
            {onUse ? (
              <button
                disabled={unchanged}
                onClick={() => {
                  stop();
                  onUse(field, formatTime(selected));
                  // The button now disables itself: keep the keys in the picker
                  rootRef.current?.focus();
                }}
                className="ml-auto px-3 py-1 rounded bg-teal-600 text-white text-xs font-medium hover:bg-teal-700 disabled:opacity-40"
              >
                {unchanged ? `${field}:: is ${formatTime(selected)}` : `Use ${formatTime(selected)} as ${field}::`}
              </button>
            ) : (
              <span className="ml-auto text-xs text-gray-500">
                View only: you cannot change this file.
              </span>
            )}
          </div>
        </div>
      </div>

      {nearby.length > 0 && (
        <div className="mt-3 text-[13px] leading-7 text-gray-700" data-testid="cut-words">
          <div className="text-[10px] uppercase tracking-wider text-gray-400 mb-0.5">
            Transcript around the cut — click a word to {field === 'to' ? 'end just before' : 'start just before'} it
          </div>
          {nearby.map(({ word, index }) => {
            const prev = index > 0 ? words![index - 1].start : -Infinity;
            const markHere = selected > prev && selected <= word.start;
            return (
              <span key={index}>
                {markHere && <span className="inline-block w-[2px] h-4 bg-teal-600 align-middle mx-0.5" title={`${label} ${formatTime(selected)}`} />}
                <button
                  onClick={() => {
                    const cut = cutBefore(words!, index);
                    setCentre(cut);
                    choose(cut);
                  }}
                  title={formatTime(word.start)}
                  className={`px-0.5 rounded hover:bg-teal-50 ${suggestion?.wordIndex === index ? 'underline decoration-dotted decoration-teal-500' : ''}`}
                >
                  {word.text}
                </button>{' '}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
