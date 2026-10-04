import { describe, expect, it } from 'vitest';
import { findVideoCutLines } from './videoCutButtons';

const lens = `### Lens: Ten reasons

#### Video
source:: [[../video_transcripts/ten-reasons]]
from:: 0:05
to:: 0:36

#### Text
content:: to:: is not a field here

#### Video
from:: 1:00
to:: 2:00
`;

describe('findVideoCutLines', () => {
  it('finds from:: and to:: lines of video segments, ending at the line end', () => {
    const lines = findVideoCutLines(lens);
    expect(lines.map((l) => l.field)).toEqual(['from', 'to', 'from', 'to']);
    expect(lens.slice(0, lines[1].lineEnd).endsWith('to:: 0:36')).toBe(true);
  });

  it('lets a segment without source:: inherit the previous video source', () => {
    const lines = findVideoCutLines(lens);
    expect(lines[3].source).toBe('[[../video_transcripts/ten-reasons]]');
  });

  it('skips video segments with no source to play', () => {
    expect(findVideoCutLines('#### Video\nto:: 1:00\n')).toEqual([]);
  });

  it('ignores documents without video segments', () => {
    expect(findVideoCutLines('from:: 1:00\nto:: 2:00\n')).toEqual([]);
  });
});
