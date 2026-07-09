import { describe, test, expect } from 'vitest';
import { getPlatformUrl, getModulePlatformUrl, headingAnchor } from './platform-url';

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

  // Prevents: course documents showing no "Show on Lensacademy.org" link —
  // courses were missing from CONTENT_TYPE_MAP so getPlatformUrl returned null.
  test('returns course URL when frontmatter slug is provided', () => {
    expect(getPlatformUrl('/courses/AI Futurism.md', 'ai-futurism')).toBe(
      'https://staging.lensacademy.org/course/ai-futurism'
    );
  });

  // Prevents: linking to /course/<filename-slug>, which 404s — the platform
  // routes courses by frontmatter slug only.
  test('returns null for courses without frontmatter slug', () => {
    expect(getPlatformUrl('/courses/AI Futurism.md')).toBeNull();
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

describe('headingAnchor', () => {
  // Prevents: editor anchors diverging from the platform's generateHeadingId(),
  // which would make lens links scroll to nothing.
  test('matches platform generateHeadingId behavior', () => {
    expect(headingAnchor('Welcome')).toBe('welcome');
    expect(headingAnchor('AI Futures Model Dec 2025')).toBe('ai-futures-model-dec-2025');
    expect(headingAnchor("What's a Lens? & More")).toBe('whats-a-lens-more');
  });

  test('truncates to 50 characters', () => {
    expect(headingAnchor('a'.repeat(60))).toBe('a'.repeat(50));
  });
});

describe('getModulePlatformUrl', () => {
  test('builds course-scoped URL with lens anchor', () => {
    expect(
      getModulePlatformUrl('aif-welcome', { courseSlug: 'ai-futurism', lensTitle: 'Welcome' })
    ).toBe('https://staging.lensacademy.org/course/ai-futurism/module/aif-welcome#welcome');
  });

  // Prevents: regression to bare /module/... links from course mode, which
  // drop the platform's course sidebar and progress context.
  test('falls back to standalone module URL without courseSlug', () => {
    expect(getModulePlatformUrl('aif-welcome', { lensTitle: 'Welcome' })).toBe(
      'https://staging.lensacademy.org/module/aif-welcome#welcome'
    );
  });

  test('omits anchor without lensTitle', () => {
    expect(getModulePlatformUrl('aif-welcome', { courseSlug: 'ai-futurism' })).toBe(
      'https://staging.lensacademy.org/course/ai-futurism/module/aif-welcome'
    );
  });
});
