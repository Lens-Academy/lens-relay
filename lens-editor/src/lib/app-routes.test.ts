import { describe, it, expect } from 'vitest';
import { isDocRoute } from './app-routes';

describe('isDocRoute', () => {
  it('is false for the start page and the workflow pages', () => {
    for (const path of ['/', '/review', '/recent', '/promote', '/add-article', '/edu/abc', '/section-editor/abc']) {
      expect(isDocRoute(path), path).toBe(false);
    }
  });

  it('is true for document paths', () => {
    for (const path of ['/c0000001', '/c0000001/Relay Folder 1/Welcome.md', '/Lens/Some Doc.md']) {
      expect(isDocRoute(path), path).toBe(true);
    }
  });
});
