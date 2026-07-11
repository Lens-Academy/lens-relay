import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync('src/index.css', 'utf8');

describe('editor hashtag styles', () => {
  it('renders live-preview hashtags as a light pill', () => {
    expect(stylesheet).toContain('.cm-hashtag');
    const rule = stylesheet.match(/\.cm-hashtag\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(rule).toMatch(/background(?:-color)?\s*:/);
    expect(rule).toMatch(/padding\s*:/);
    expect(rule).toMatch(/border-radius\s*:/);
  });
});
