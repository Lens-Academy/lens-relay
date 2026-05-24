import { describe, it, expect } from 'vitest';
import { scoreCandidates, verifyByProbe } from './position-finder';
import type { Candidate, ProbeRunner } from './position-finder';
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

  it('falls back to shorter before/after windows when full rendered context is not in source', () => {
    const src = '<div>Specific details like:\n     - file names\n     - full code snippets</div>';
    const result = scoreCandidates(src, fp({
      before: 'Specific details like:file ',
      after: 'namesfull code snippets',
      tag: 'li',
      ancestorPath: [{ tag: 'li', index: 0 }],
    }));

    expect(result.length).toBeGreaterThan(0);
    expect(src.slice(result[0].position, result[0].position + 'names'.length)).toBe('names');
  });

  it('finds rendered text context split by inline code tags', () => {
    const src = '<p>Use the <code>folder_config</code> value carefully.</p>';
    const result = scoreCandidates(src, fp({
      before: 'Use the folder_config',
      after: ' value carefully.',
      tag: 'p',
      ancestorPath: [{ tag: 'p', index: 0 }],
    }));

    expect(result.length).toBeGreaterThan(0);
    expect(result[0].position).toBe(src.indexOf(' value carefully.'));
  });

  it('finds rendered text context split by non-rendered markdown delimiters', () => {
    const src = '<div class="md">Root cause identified: `folder_config` Y.Map with **important** details.</div>';
    const result = scoreCandidates(src, fp({
      before: 'Y.Map with ',
      after: 'important details.',
      tag: 'p',
      ancestorPath: [{ tag: 'div', index: 0 }],
    }));

    expect(result.length).toBeGreaterThan(0);
    expect(result[0].position).toBe(src.indexOf('important'));
  });

  it('finds rendered text context decoded from HTML entities', () => {
    const src = '<div class="md">TestOb doesn&#x27;t show as backlink in README.</div>';
    const result = scoreCandidates(src, fp({
      before: 'TestOb doesn',
      after: "'t show as backlink",
      tag: 'p',
      ancestorPath: [{ tag: 'div', index: 0 }],
    }));

    expect(result.length).toBeGreaterThan(0);
    expect(result[0].position).toBe(src.indexOf('&#x27;'));
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

describe('verifyByProbe', () => {
  it('accepts the first candidate whose probe rect overlaps click point', async () => {
    const src = '<p>click here</p><p>click here</p>';
    const candidates: Candidate[] = [{ position: 9, score: 5 }, { position: 26, score: 5 }];
    const fpr = fp({
      before: 'click ',
      after: 'here',
      clickRect: { x: 100, y: 50, w: 10, h: 10 },
    });
    const runner: ProbeRunner = {
      async run(sourceWithProbe, token) {
        if (!sourceWithProbe.includes(`<!--lens-probe ${token}-->`)) return null;
        const probeIdx = sourceWithProbe.indexOf(`<!--lens-probe ${token}-->`);
        if (Math.abs(probeIdx - candidates[0].position) < 5) return { x: 95, y: 45, w: 20, h: 20 };
        return { x: 500, y: 500, w: 10, h: 10 };
      },
      dispose() {},
    };

    const result = await verifyByProbe(src, candidates, fpr, runner);

    expect(result.kind).toBe('placed');
    if (result.kind === 'placed') expect(result.position).toBe(9);
  });

  it('returns kind:"manual" when no candidate overlaps the click point', async () => {
    const src = '<p>click here</p>';
    const candidates: Candidate[] = [{ position: 9, score: 5 }];
    const runner: ProbeRunner = {
      async run() { return { x: 999, y: 999, w: 1, h: 1 }; },
      dispose() {},
    };

    const result = await verifyByProbe(src, candidates, fp({ clickRect: { x: 0, y: 0, w: 10, h: 10 } }), runner);

    expect(result).toEqual({ kind: 'manual', candidates });
  });

  it('returns kind:"manual" with no candidates', async () => {
    const runner: ProbeRunner = { async run() { return null; }, dispose() {} };

    const result = await verifyByProbe('', [], fp(), runner);

    expect(result).toEqual({ kind: 'manual', candidates: [] });
  });

  it('tries at most five candidates before returning manual', async () => {
    const src = '<p>click here</p>'.repeat(6);
    const candidates: Candidate[] = [
      { position: 9, score: 6 },
      { position: 26, score: 5 },
      { position: 43, score: 4 },
      { position: 60, score: 3 },
      { position: 77, score: 2 },
      { position: 94, score: 1 },
    ];
    const calls: number[] = [];
    const runner: ProbeRunner = {
      async run(sourceWithProbe, token) {
        calls.push(sourceWithProbe.indexOf(`<!--lens-probe ${token}-->`));
        return { x: 999, y: 999, w: 1, h: 1 };
      },
      dispose() {},
    };

    const result = await verifyByProbe(src, candidates, fp({ clickRect: { x: 0, y: 0, w: 10, h: 10 } }), runner);

    expect(result).toEqual({ kind: 'manual', candidates });
    expect(calls).toEqual([9, 26, 43, 60, 77]);
  });
});
