import { describe, it, expect } from 'vitest';
import { resolveWikilinkToUuid, resolveRelativePath } from './resolveDocPath';

describe('resolveRelativePath', () => {
  it('resolves sibling reference', () => {
    expect(resolveRelativePath('../Lenses/AI Control', 'Lens Edu/modules/feedback-loops.md'))
      .toBe('Lens Edu/Lenses/AI Control');
  });

  it('resolves same-directory reference', () => {
    expect(resolveRelativePath('../Learning Outcomes/Foom', 'Lens Edu/modules/feedback-loops.md'))
      .toBe('Lens Edu/Learning Outcomes/Foom');
  });

  it('resolves from LO to Lens', () => {
    expect(resolveRelativePath('../Lenses/Cascades and Cycles', 'Lens Edu/Learning Outcomes/Some LO.md'))
      .toBe('Lens Edu/Lenses/Cascades and Cycles');
  });

  it('resolves article reference from lens', () => {
    expect(resolveRelativePath('../articles/carlsmith-ai-for-ai-safety', 'Lens Edu/Lenses/AI for AI safety.md'))
      .toBe('Lens Edu/articles/carlsmith-ai-for-ai-safety');
  });

  it('resolves video transcript reference', () => {
    expect(resolveRelativePath('../video_transcripts/kurzgesagt-ai', 'Lens Edu/Lenses/Some Lens.md'))
      .toBe('Lens Edu/video_transcripts/kurzgesagt-ai');
  });
});

describe('resolveWikilinkToUuid', () => {
  const metadata: Record<string, { id: string }> = {
    'Lens Edu/Lenses/AI Control.md': { id: 'abc-123' },
    'Lens Edu/Learning Outcomes/Some LO.md': { id: 'def-456' },
    'Lens Edu/articles/carlsmith-ai-for-ai-safety.md': { id: 'ghi-789' },
  };

  it('resolves wikilink to UUID', () => {
    const uuid = resolveWikilinkToUuid(
      '[[../Lenses/AI Control]]',
      'Lens Edu/modules/feedback-loops.md',
      metadata
    );
    expect(uuid).toBe('abc-123');
  });

  it('resolves transclusion to UUID', () => {
    const uuid = resolveWikilinkToUuid(
      '![[../Learning Outcomes/Some LO]]',
      'Lens Edu/modules/feedback-loops.md',
      metadata
    );
    expect(uuid).toBe('def-456');
  });

  it('returns null for unresolvable link', () => {
    const uuid = resolveWikilinkToUuid(
      '[[../Lenses/Nonexistent]]',
      'Lens Edu/modules/feedback-loops.md',
      metadata
    );
    expect(uuid).toBeNull();
  });

  it('tries with .md extension', () => {
    const uuid = resolveWikilinkToUuid(
      '[[../articles/carlsmith-ai-for-ai-safety]]',
      'Lens Edu/Lenses/AI for AI safety.md',
      metadata
    );
    expect(uuid).toBe('ghi-789');
  });

  it('returns null for malformed wikilink', () => {
    const uuid = resolveWikilinkToUuid(
      'not a wikilink',
      'Lens Edu/modules/foo.md',
      metadata
    );
    expect(uuid).toBeNull();
  });
});
