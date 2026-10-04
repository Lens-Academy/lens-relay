import { describe, expect, it } from 'vitest';
import { parseSections } from '../components/SectionEditor/parseSections';
import { resolvePending, segmentTimeEdit, type SegmentTimeField } from './segmentTime';

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

function videoIndexes(text: string) {
  return parseSections(text)
    .map((s, i) => (s.type === 'video' ? i : -1))
    .filter((i) => i >= 0);
}

function apply(text: string, i: number, field: SegmentTimeField, value: string) {
  const edit = segmentTimeEdit(text, i, field, value);
  expect(edit).not.toBeNull();
  return text.slice(0, edit!.index) + edit!.insert + text.slice(edit!.index + edit!.deleteCount);
}

describe('segmentTimeEdit', () => {
  const [first, second, third] = videoIndexes(lens);

  it('replaces only the value of an existing field', () => {
    expect(segmentTimeEdit(lens, first, 'to', '5:51.75')).toEqual({
      index: lens.indexOf('5:52'),
      deleteCount: 4,
      insert: '5:51.75',
    });
    expect(apply(lens, first, 'from', '0:03.5')).toBe(lens.replace('from:: 0:00', 'from:: 0:03.5'));
  });

  it('adds a missing field after source::', () => {
    expect(apply(lens, second, 'to', '7:00')).toContain(
      'source:: [[../video_transcripts/ten-reasons]]\nto:: 7:00\n\n#### Video\n',
    );
    expect(apply(lens, second, 'from', '6:00')).toContain('ten-reasons]]\nfrom:: 6:00\n\n#### Video\n');
  });

  it('adds to:: after from:: when it has to add both', () => {
    let out = apply(lens, second, 'from', '6:00');
    out = apply(out, second, 'to', '7:00');
    expect(out).toContain('ten-reasons]]\nfrom:: 6:00\nto:: 7:00\n\n#### Video\n');
  });

  it('adds a field under a bare heading', () => {
    expect(apply(lens, third, 'to', '1:00').endsWith('#### Video\nto:: 1:00\n')).toBe(true);
  });

  it('refuses a section that is not a video segment', () => {
    expect(segmentTimeEdit(lens, 1, 'to', '1:00')).toBeNull();
    expect(segmentTimeEdit(lens, 99, 'to', '1:00')).toBeNull();
  });
});

describe('resolvePending', () => {
  const pending = '{~~{"author":"Iris","timestamp":1}@@0:35.5~>0:35.75~~}';

  it('reads a suggested time as accepted or as live', () => {
    expect(resolvePending(pending, 'accept')).toBe('0:35.75');
    expect(resolvePending(pending, 'reject')).toBe('0:35.5');
    expect(resolvePending('0:36', 'accept')).toBe('0:36');
  });
});
