import { describe, it, expect } from 'vitest';
import { nextUntitledHtmlName } from './untitled-name';

describe('nextUntitledHtmlName', () => {
  it('returns "Untitled.html" when no collision', () => {
    expect(nextUntitledHtmlName('/Lens', {})).toBe('Untitled.html');
    expect(nextUntitledHtmlName('/Lens/Notes', {})).toBe('Untitled.html');
  });

  it('returns "Untitled 1.html" when "Untitled.html" already exists in the folder', () => {
    expect(nextUntitledHtmlName('/Lens', { '/Lens/Untitled.html': {} as any })).toBe('Untitled 1.html');
  });

  it('returns "Untitled 2.html" when both "Untitled.html" and "Untitled 1.html" exist', () => {
    expect(nextUntitledHtmlName('/Lens', {
      '/Lens/Untitled.html': {} as any,
      '/Lens/Untitled 1.html': {} as any,
    })).toBe('Untitled 2.html');
  });

  it('ignores collisions in other folders (prefix-scoped)', () => {
    expect(nextUntitledHtmlName('/Lens/Notes', {
      '/Lens/Untitled.html': {} as any,
      '/Lens/Notes/Untitled.html': {} as any,
    })).toBe('Untitled 1.html');
  });

  it('ignores entries in deeper subfolders (only direct children count)', () => {
    expect(nextUntitledHtmlName('/Lens', { '/Lens/Notes/Untitled.html': {} as any })).toBe('Untitled.html');
  });

  it('ignores collisions on differently-suffixed files (e.g. .md)', () => {
    expect(nextUntitledHtmlName('/Lens', { '/Lens/Untitled.md': {} as any })).toBe('Untitled.html');
  });

  it('handles folderPath with trailing slash', () => {
    expect(nextUntitledHtmlName('/Lens/', { '/Lens/Untitled.html': {} as any })).toBe('Untitled 1.html');
  });

  it('returns "Untitled.html" when only "Untitled 1.html" exists (fills lowest gap)', () => {
    expect(nextUntitledHtmlName('/Lens', { '/Lens/Untitled 1.html': {} as any })).toBe('Untitled.html');
  });
});
