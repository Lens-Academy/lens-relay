import { describe, it, expect } from 'vitest';
import { scoreCandidates } from './position-finder';
import type { Fingerprint } from './bridge/protocol';

const fp = (over: Partial<Fingerprint> = {}): Fingerprint => ({
  before: '', after: '', tag: 'p',
  ancestorPath: [], clickRect: { x: 0, y: 0, w: 0, h: 0 },
  ...over,
});

describe('scoreCandidates', () => {
  it('returns the position of a unique text match', () => {
    const src = '<p>Hello world</p>';
    const result = scoreCandidates(src, fp({ before: 'Hel', after: 'lo wo' }));
    expect(result.length).toBeGreaterThan(0);
    expect(src.slice(result[0].position, result[0].position + 5)).toContain('lo wo');
  });

  it('returns multiple candidates when text appears multiple times', () => {
    const src = '<p>click here</p><p>click here</p>';
    const result = scoreCandidates(src, fp({ before: 'click ', after: 'here' }));
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('returns empty when fingerprint text not found', () => {
    expect(scoreCandidates('<p>foo</p>', fp({ before: 'bar', after: 'baz' }))).toEqual([]);
  });

  it('ranks the candidate whose open-tag stack matches the fingerprint ancestors first', () => {
    const src = '<main><p>click here</p></main><aside><p>click here</p></aside>';
    const result = scoreCandidates(src, fp({
      before: 'click ', after: 'here', tag: 'p',
      ancestorPath: [{ tag: 'main', index: 0 }, { tag: 'p', index: 0 }],
    }));
    expect(result[0].score).toBeGreaterThan(result[1].score);
    const winner = result[0].position;
    const mainOpen = src.indexOf('<main>');
    const mainClose = src.indexOf('</main>');
    expect(winner).toBeGreaterThan(mainOpen);
    expect(winner).toBeLessThan(mainClose);
  });

  it('prefers an ordered ancestor suffix over unordered tag overlap', () => {
    const src = '<article><section>click here</section></article><section><article>click here</article></section>';
    const result = scoreCandidates(src, fp({
      before: 'click ', after: 'here', tag: 'article',
      ancestorPath: [{ tag: 'section', index: 0 }, { tag: 'article', index: 0 }],
    }));
    const winner = result[0].position;
    const secondArticleOpen = src.lastIndexOf('<article>');
    expect(winner).toBeGreaterThan(secondArticleOpen);
  });

  it('gives matched ancestor suffix length priority over extra non-suffix ordered matches', () => {
    const shortSuffix = '<alpha><beta><gamma><delta><epsilon><zeta><eta><omega><p>click here</p></omega></eta></zeta></epsilon></delta></gamma></beta></alpha>';
    const longSuffix = '<theta><eta><p>click here</p></eta></theta>';
    const src = shortSuffix + longSuffix;
    const result = scoreCandidates(src, fp({
      before: 'click ', after: 'here', tag: 'p',
      ancestorPath: [
        { tag: 'alpha', index: 0 },
        { tag: 'beta', index: 0 },
        { tag: 'gamma', index: 0 },
        { tag: 'delta', index: 0 },
        { tag: 'epsilon', index: 0 },
        { tag: 'zeta', index: 0 },
        { tag: 'eta', index: 0 },
        { tag: 'p', index: 0 },
      ],
    }));
    const winner = result[0].position;
    const longSuffixOpen = src.lastIndexOf('<theta>');
    expect(winner).toBeGreaterThan(longSuffixOpen);
  });

  it('prefers matching nth-of-type ancestor indices when ordered tags are equal', () => {
    const src = '<main><section><p>click here</p></section><section><p>click here</p></section></main>';
    const result = scoreCandidates(src, fp({
      before: 'click ', after: 'here', tag: 'p',
      ancestorPath: [{ tag: 'main', index: 0 }, { tag: 'section', index: 1 }, { tag: 'p', index: 0 }],
    }));
    const winner = result[0].position;
    const secondSectionOpen = src.lastIndexOf('<section>');
    expect(winner).toBeGreaterThan(secondSectionOpen);
  });
});
