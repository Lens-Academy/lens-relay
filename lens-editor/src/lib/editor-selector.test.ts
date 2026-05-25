import { describe, it, expect } from 'vitest';
import { pickEditor } from './editor-selector';

describe('pickEditor', () => {
  it('returns "blob" when the entry has a hash', () => {
    expect(pickEditor('/data.json', { type: 'file', id: 'x', version: 0, hash: 'abc' }))
      .toBe('blob');
  });

  it('returns "html" for .html paths with type "file" (no hash)', () => {
    expect(pickEditor('/page.html', { type: 'file', id: 'x', version: 0 }))
      .toBe('html');
  });

  it('returns "markdown" for .md paths', () => {
    expect(pickEditor('/note.md', { type: 'markdown', id: 'x', version: 0 }))
      .toBe('markdown');
  });

  it('returns "markdown" when path is unknown extension and no hash (fallback)', () => {
    expect(pickEditor('/noext', { type: 'markdown', id: 'x', version: 0 }))
      .toBe('markdown');
  });

  it('returns "markdown" when filePath is null (no entry yet - default editor)', () => {
    expect(pickEditor(null, null)).toBe('markdown');
  });

  it('returns "image" for image entries with a hash', () => {
    expect(pickEditor('/attachments/photo.png', { type: 'image', id: 'x', version: 0, hash: 'abc', mimetype: 'image/png' }))
      .toBe('image');
  });

  it('returns "markdown" for image entries without a hash', () => {
    expect(pickEditor('/attachments/photo.png', { type: 'image', id: 'x', version: 0 }))
      .toBe('markdown');
  });
});
