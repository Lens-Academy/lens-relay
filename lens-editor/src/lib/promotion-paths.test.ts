import { describe, expect, it } from 'vitest';
import { editorPathToPromotionPath, promotionPathToEditorPath } from './promotion-paths';

describe('promotion path helpers', () => {
  it('maps Lens Edu editor paths to repo-relative promotion paths', () => {
    expect(editorPathToPromotionPath('/Lens Edu/Modules/Intro.md')).toBe('Modules/Intro.md');
  });

  it('returns null for paths outside the promotion folder', () => {
    expect(editorPathToPromotionPath('/Lens/Notes.md')).toBeNull();
    expect(editorPathToPromotionPath('/Lens Edu')).toBeNull();
  });

  it('maps repo-relative promotion paths back to Lens Edu editor paths', () => {
    expect(promotionPathToEditorPath('Modules/Intro.md')).toBe('/Lens Edu/Modules/Intro.md');
  });
});
