import { describe, test, expect } from 'vitest';
import { getPlatformUrl } from './platform-url';

describe('getPlatformUrl', () => {
  test('returns article URL for files in /articles/', () => {
    expect(getPlatformUrl('/articles/My Article.md')).toBe(
      'https://staging.lensacademy.org/article/my-article'
    );
  });

  test('returns lens URL for files in /Lenses/', () => {
    expect(getPlatformUrl('/Lenses/Four Background Claims.md')).toBe(
      'https://staging.lensacademy.org/lens/four-background-claims'
    );
  });

  test('returns module URL when frontmatter slug is provided', () => {
    expect(getPlatformUrl('/modules/Intro to Physics.md', 'intro-to-physics')).toBe(
      'https://staging.lensacademy.org/module/intro-to-physics'
    );
  });

  test('returns null for modules without frontmatter slug', () => {
    expect(getPlatformUrl('/modules/Intro to Physics.md')).toBeNull();
  });

  test('articles ignore frontmatter slug and use filename', () => {
    expect(getPlatformUrl('/articles/My Article.md', 'ignored-slug')).toBe(
      'https://staging.lensacademy.org/article/my-article'
    );
  });

  test('lenses ignore frontmatter slug and use filename', () => {
    expect(getPlatformUrl('/Lenses/Some Lens.md', 'ignored-slug')).toBe(
      'https://staging.lensacademy.org/lens/some-lens'
    );
  });

  test('returns null for files not in a known content folder', () => {
    expect(getPlatformUrl('/notes/random.md')).toBeNull();
  });

  test('returns null for root-level files', () => {
    expect(getPlatformUrl('/readme.md')).toBeNull();
  });

  test('handles nested paths within content folders', () => {
    expect(getPlatformUrl('/articles/subfolder/Deep Article.md')).toBe(
      'https://staging.lensacademy.org/article/deep-article'
    );
  });

  test('strips special characters from slug', () => {
    expect(getPlatformUrl("/Lenses/What's a Lens?.md")).toBe(
      'https://staging.lensacademy.org/lens/whats-a-lens'
    );
  });

  test('collapses multiple spaces/hyphens into single hyphen', () => {
    expect(getPlatformUrl('/Lenses/Some  --  Lens.md')).toBe(
      'https://staging.lensacademy.org/lens/some-lens'
    );
  });

  test('is case-sensitive for folder names (lowercase lenses does not match)', () => {
    expect(getPlatformUrl('/lenses/something.md')).toBeNull();
  });
});
