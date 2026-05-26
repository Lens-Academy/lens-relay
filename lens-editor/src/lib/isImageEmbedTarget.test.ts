import { describe, it, expect } from 'vitest';
import { isImageEmbedTarget } from './isImageEmbedTarget';

describe('isImageEmbedTarget', () => {
  it.each([
    'image.png',
    'photo.jpg',
    'photo.jpeg',
    'frame.gif',
    'art.webp',
    'icon.svg',
    'bitmap.bmp',
    'scan.tiff',
    'modern.avif',
    'phone.heic',
  ])('treats %s as an image', (path) => {
    expect(isImageEmbedTarget(path)).toBe(true);
  });

  it('matches extensions case-insensitively', () => {
    expect(isImageEmbedTarget('Diagram.PNG')).toBe(true);
    expect(isImageEmbedTarget('shot.WebP')).toBe(true);
  });

  it('matches deep paths', () => {
    expect(isImageEmbedTarget('attachments/sub/img.png')).toBe(true);
    expect(isImageEmbedTarget('../Lenses/diagram.svg')).toBe(true);
  });

  it.each([
    'note.md',
    'doc.pdf',
    'notes.txt',
    'archive.zip',
    'Some File',
    '../Lenses/Facilitator - M1 Welcome',
  ])('treats %s as a non-image', (path) => {
    expect(isImageEmbedTarget(path)).toBe(false);
  });

  it('returns false when there is no extension', () => {
    expect(isImageEmbedTarget('plainname')).toBe(false);
  });

  it('returns false on a trailing dot with no extension', () => {
    expect(isImageEmbedTarget('weird.')).toBe(false);
  });

  it('strips Obsidian alias before checking', () => {
    expect(isImageEmbedTarget('photo.png|caption text')).toBe(true);
    expect(isImageEmbedTarget('note|alt')).toBe(false);
  });

  it('trims surrounding whitespace before checking', () => {
    expect(isImageEmbedTarget('  photo.png  ')).toBe(true);
  });
});
