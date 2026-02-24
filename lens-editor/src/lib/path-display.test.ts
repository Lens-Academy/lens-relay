import { describe, it, expect } from 'vitest';
import { pathToSegments, pathToParentSegments, pathToDisplayString } from './path-display';

describe('pathToSegments', () => {
  it('splits a deep path into segments without .md', () => {
    expect(pathToSegments('/Lens Edu/Modules/Module_x/Getting Started.md'))
      .toEqual(['Lens Edu', 'Modules', 'Module_x', 'Getting Started']);
  });

  it('handles root-level files', () => {
    expect(pathToSegments('/Source.md')).toEqual(['Source']);
  });

  it('handles single folder + file', () => {
    expect(pathToSegments('/Lens/Introduction.md')).toEqual(['Lens', 'Introduction']);
  });

  it('returns empty array for undefined', () => {
    expect(pathToSegments(undefined)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(pathToSegments('')).toEqual([]);
  });

  it('handles path without leading slash', () => {
    expect(pathToSegments('Lens/Intro.md')).toEqual(['Lens', 'Intro']);
  });

  it('handles path without .md extension', () => {
    expect(pathToSegments('/Lens/Notes')).toEqual(['Lens', 'Notes']);
  });
});

describe('pathToParentSegments', () => {
  it('returns all segments except the filename', () => {
    expect(pathToParentSegments('/Lens Edu/Modules/Module_x/Getting Started.md'))
      .toEqual(['Lens Edu', 'Modules', 'Module_x']);
  });

  it('returns just the folder for a shallow path', () => {
    expect(pathToParentSegments('/Lens/Introduction.md')).toEqual(['Lens']);
  });

  it('returns empty array for root-level file', () => {
    expect(pathToParentSegments('/Source.md')).toEqual([]);
  });

  it('returns empty array for undefined', () => {
    expect(pathToParentSegments(undefined)).toEqual([]);
  });
});

describe('pathToDisplayString', () => {
  it('joins segments with /', () => {
    expect(pathToDisplayString('/Lens Edu/Modules/Module_x/Getting Started.md'))
      .toBe('Lens Edu/Modules/Module_x/Getting Started');
  });

  it('returns just the filename for root-level files', () => {
    expect(pathToDisplayString('/Source.md')).toBe('Source');
  });

  it('returns empty string for undefined', () => {
    expect(pathToDisplayString(undefined)).toBe('');
  });
});
