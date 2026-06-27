import { describe, it, expect } from 'vitest';
import { validatePromotionPaths, validateRepoPath } from './path-validation.ts';
import type { PromotionFileChange } from './types.ts';

const changedFiles: PromotionFileChange[] = [
  { path: 'Courses/Intro.md', oldPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false },
  { path: 'Courses/New Name.md', oldPath: 'Courses/Old Name.md', status: 'renamed', additions: 2, deletions: 2, isBinary: false },
];

describe('promotion path validation', () => {
  it('accepts normalized repo-relative paths', () => {
    expect(validateRepoPath('Courses/./Intro.md')).toBe('Courses/Intro.md');
  });

  it('keeps normal file paths with spaces valid', () => {
    expect(validateRepoPath('Courses/New Name.md')).toBe('Courses/New Name.md');
  });

  it.each(['/etc/passwd', '../secret.md', 'Courses/../secret.md', 'Courses\\Intro.md', '', '.'])(
    'rejects unsafe path %s',
    pathValue => {
      expect(() => validateRepoPath(pathValue)).toThrow();
    },
  );

  it.each([
    '*.md',
    'Courses/*.md',
    'Courses/[abc].md',
    'Courses/?.md',
    ':(glob)**',
    './:!Courses/Intro.md',
    './:(literal)Courses/Intro.md',
    './:(glob)Courses/Intro.md',
  ])(
    'rejects Git pathspec metacharacters and magic in %s',
    pathValue => {
      expect(() => validateRepoPath(pathValue)).toThrow(/pathspec/);
    },
  );

  it.each(['Courses/Intro\0.md', 'Courses/Intro\n.md'])('rejects control characters in %s', pathValue => {
    expect(() => validateRepoPath(pathValue)).toThrow(/control/);
  });

  it('deduplicates selected paths after normalization', () => {
    expect(validatePromotionPaths(['./Courses/Intro.md', 'Courses/Intro.md'], changedFiles)).toEqual(['Courses/Intro.md']);
  });

  it('rejects empty path selections', () => {
    expect(() => validatePromotionPaths([], changedFiles)).toThrow(/At least one/);
  });

  it('rejects paths not present in the branch diff', () => {
    expect(() => validatePromotionPaths(['Courses/Unchanged.md'], changedFiles)).toThrow(/not changed/);
  });

  it('allows selecting either side of a rename row', () => {
    expect(validatePromotionPaths(['Courses/Old Name.md', 'Courses/New Name.md'], changedFiles)).toEqual([
      'Courses/Old Name.md',
      'Courses/New Name.md',
    ]);
  });

  it('rejects more than 100 paths', () => {
    const paths = Array.from({ length: 101 }, (_, index) => `Courses/${index}.md`);
    expect(() => validatePromotionPaths(paths, changedFiles)).toThrow(/At most 100/);
  });
});
