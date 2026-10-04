import { describe, expect, it } from 'vitest';
import {
  candidates,
  clipEndVolume,
  CLIP_FADE_SECONDS,
  cutBefore,
  formatTime,
  parseTime,
  suggestCut,
  toWords,
  youtubeId,
} from './videoCuts';

describe('parseTime / formatTime', () => {
  it('reads the forms the content processor accepts', () => {
    expect(parseTime('5:52')).toBe(352);
    expect(parseTime('05:52')).toBe(352);
    expect(parseTime('5:51.75')).toBeCloseTo(351.75);
    expect(parseTime('1:02:03')).toBe(3723);
    expect(parseTime('"5:52"')).toBe(352);
    expect(parseTime('75:30.5')).toBeCloseTo(4530.5);
  });

  it('refuses what the content processor refuses', () => {
    expect(parseTime('352')).toBeNull();
    expect(parseTime('1:02:03.5')).toBeNull();
    expect(parseTime('5:5x')).toBeNull();
  });

  it('writes whole seconds plainly and fractions to the hundredth', () => {
    expect(formatTime(352)).toBe('5:52');
    expect(formatTime(351.75)).toBe('5:51.75');
    expect(formatTime(351.5)).toBe('5:51.5');
    expect(formatTime(351.749999)).toBe('5:51.75');
    expect(formatTime(4530.25)).toBe('75:30.25');
    expect(formatTime(5.05)).toBe('0:05.05');
  });

  it('round-trips', () => {
    for (const t of [0, 0.25, 59.99, 352, 3723.5]) {
      expect(parseTime(formatTime(t))).toBeCloseTo(t);
    }
  });
});

describe('clipEndVolume', () => {
  it('is full until the fade and silent from the end on', () => {
    expect(clipEndVolume(10, 12)).toBe(1);
    expect(clipEndVolume(12 - CLIP_FADE_SECONDS / 2, 12)).toBeCloseTo(0.5);
    expect(clipEndVolume(12, 12)).toBe(0);
  });
});

const words = toWords([
  { text: 'That', start: '5:48.10' },
  { text: 'is', start: '5:48.40' },
  { text: 'alignment.', start: '5:49.00' },
  { text: 'Now', start: '5:51.20' },
  { text: 'consider', start: '5:51.50' },
  { text: 'this:', start: '5:52.00' },
  { text: 'the', start: '5:52.30' },
  { text: '"end."', start: '5:53.00' },
  { text: 'Next', start: '5:53.20' },
]);

describe('suggestCut', () => {
  it('cuts just before the first word of the nearest sentence', () => {
    expect(suggestCut(words, 352)).toEqual({ time: 351.05, wordIndex: 3 });
  });

  it('treats closing quotes after the full stop as a sentence end', () => {
    const s = suggestCut(words, 353.5);
    expect(s?.wordIndex).toBe(8);
  });

  it('keeps clear of the previous word when the gap is tight', () => {
    // "end." starts at 5:53.00 and "Next" at 5:53.20: the cut cannot come
    // 0.2 s after "end." without reaching "Next", so it sits on "Next"
    expect(cutBefore(words, 8)).toBeCloseTo(353.2);
  });

  it('finds nothing outside the window', () => {
    expect(suggestCut(words, 400)).toBeNull();
  });
});

describe('candidates', () => {
  it('steps either side of the centre', () => {
    expect(candidates(352, 0.25)).toEqual([351.25, 351.5, 351.75, 352, 352.25, 352.5, 352.75]);
  });

  it('drops times before the video starts', () => {
    expect(candidates(0.5, 0.5, 2)).toEqual([0, 0.5, 1, 1.5]);
  });
});

describe('youtubeId', () => {
  it('reads watch, short and embed links', () => {
    expect(youtubeId('https://www.youtube.com/watch?v=9i1WlcCudpU')).toBe('9i1WlcCudpU');
    expect(youtubeId('https://www.youtube.com/watch?t=3&v=9i1WlcCudpU')).toBe('9i1WlcCudpU');
    expect(youtubeId('https://youtu.be/9i1WlcCudpU?t=10')).toBe('9i1WlcCudpU');
    expect(youtubeId('https://www.youtube.com/embed/9i1WlcCudpU')).toBe('9i1WlcCudpU');
    expect(youtubeId('https://vimeo.com/123')).toBeNull();
  });
});
