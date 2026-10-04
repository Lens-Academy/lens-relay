import { describe, expect, it } from 'vitest';
import { parseSections } from '../components/SectionEditor/parseSections';
import {
  resolvePending,
  segmentFields,
  segmentTimeChange,
  videoSectionAt,
  type SegmentTimeField,
  type SegmentTimeOptions,
} from './segmentTime';

const lens = `---
id: abc
---
### Lens: Ten reasons

#### Text
content:: Watch this.

#### Video
source:: [[../video_transcripts/ten-reasons]]
from:: 0:00
to:: 5:52

#### Video
source:: [[../video_transcripts/ten-reasons]]

#### Video
`;

const suggest: SegmentTimeOptions = { suggest: { author: 'Ann', timestamp: 1 } };
const META = '{"author":"Ann","timestamp":1}';

function videoStarts(text: string) {
  return parseSections(text)
    .filter((s) => s.type === 'video')
    .map((s) => s.from);
}

/** Set a time on the video segment whose heading starts at `at`. */
function apply(text: string, at: number, field: SegmentTimeField, value: string, options?: SegmentTimeOptions) {
  const section = videoSectionAt(text, at);
  expect(section).not.toBeNull();
  const change = segmentTimeChange(section!, field, value, options);
  if ('error' in change) throw new Error(change.error);
  return text.slice(0, change.from) + change.insert + text.slice(change.to);
}

function fields(text: string, at: number) {
  return segmentFields(videoSectionAt(text, at)!);
}

describe('segmentTimeChange, editing', () => {
  const [first, second, third] = videoStarts(lens);

  it('replaces only the value of an existing field', () => {
    expect(apply(lens, first, 'to', '5:51.75')).toBe(lens.replace('to:: 5:52', 'to:: 5:51.75'));
    expect(apply(lens, first, 'from', '0:03.5')).toBe(lens.replace('from:: 0:00', 'from:: 0:03.5'));
  });

  it('adds a missing field after source::, and to:: after from::', () => {
    expect(apply(lens, second, 'to', '7:00')).toContain('ten-reasons]]\nto:: 7:00\n\n#### Video\n');
    const both = apply(apply(lens, second, 'from', '6:00'), second, 'to', '7:00');
    expect(both).toContain('ten-reasons]]\nfrom:: 6:00\nto:: 7:00\n\n#### Video\n');
  });

  it('adds a field under a bare heading', () => {
    expect(apply(lens, third, 'to', '1:00').endsWith('#### Video\nto:: 1:00\n')).toBe(true);
  });

  it('takes over a pending suggestion on the value', () => {
    const suggested = apply(lens, first, 'to', '5:51', suggest);
    expect(apply(suggested, first, 'to', '5:50')).toBe(lens.replace('to:: 5:52', 'to:: 5:50'));
  });
});

describe('segmentTimeChange, suggesting', () => {
  const [first, second] = videoStarts(lens);

  it('writes a substitution on the value', () => {
    const out = apply(lens, first, 'to', '5:51.75', suggest);
    expect(out).toContain(`to:: {~~${META}@@5:52~>5:51.75~~}\n`);
    expect(fields(out, first).get('to')).toBe('5:51.75');
    expect(resolvePending(out, 'reject')).toBe(lens);
  });

  it('replaces its own earlier suggestion instead of nesting markup', () => {
    const once = apply(lens, first, 'to', '5:51', suggest);
    const twice = apply(once, first, 'to', '5:50.5', suggest);
    expect(twice).toContain(`to:: {~~${META}@@5:52~>5:50.5~~}\n`);
    expect(twice.match(/~~/g)).toHaveLength(2);
  });

  it('drops the suggestion when the live time is chosen again', () => {
    const once = apply(lens, first, 'to', '5:51', suggest);
    expect(apply(once, first, 'to', '5:52', suggest)).toBe(lens);
  });

  it('wraps a new line whole, so the other fields still read', () => {
    const out = apply(lens, second, 'to', '7:00', suggest);
    expect(out).toContain(`ten-reasons]]\n{++${META}@@to:: 7:00++}\n\n#### Video\n`);
    const f = fields(out, second);
    expect(f.get('to')).toBe('7:00');
    expect(f.get('source')).toBe('[[../video_transcripts/ten-reasons]]');
    // Suggesting again replaces the added line, with no stray markup
    const again = apply(out, second, 'to', '7:30', suggest);
    expect(again).toContain(`ten-reasons]]\n{++${META}@@to:: 7:30++}\n\n#### Video\n`);
    // Rejected, it leaves only a blank line behind
    expect(resolvePending(again, 'reject').replace(/\n{3,}/g, '\n\n')).toBe(lens);
    // and adding from:: then lands before the pending to:: line
    const withFrom = apply(again, second, 'from', '6:00', suggest);
    expect(fields(withFrom, second).get('from')).toBe('6:00');
    expect(fields(withFrom, second).get('to')).toBe('7:30');
  });

  it('refuses a line with other pending markup', () => {
    const commented = lens.replace('to:: 5:52', 'to:: 5:52{>>check this<<}');
    const change = segmentTimeChange(videoSectionAt(commented, first)!, 'to', '5:50', suggest);
    expect(change).toHaveProperty('error');
  });
});

describe('videoSectionAt', () => {
  it('finds the video segment at a heading position, and nothing elsewhere', () => {
    const [first] = videoStarts(lens);
    expect(videoSectionAt(lens, first)?.type).toBe('video');
    expect(videoSectionAt(lens, lens.indexOf('#### Text'))).toBeNull();
  });
});
