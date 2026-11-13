import { describe, expect, it } from 'vitest';
import type { MapEdge } from './idea-map-layout';
import { chainOf, impliedLinks, inChain, shownLinks } from './idea-map-links';

/** Links from words like "a>b" (b requires a) and "a~b" (a is helpful first for b). */
const links = (...words: string[]): MapEdge[] => words.map((word) => {
  const helpful = word.includes('~');
  const [from, to] = word.split(helpful ? '~' : '>');
  return { from, to, helpful };
});
const said = (edges: Iterable<MapEdge>) => [...edges].map((edge) => `${edge.from}${edge.helpful ? '~' : '>'}${edge.to}`).sort();

describe('impliedLinks', () => {
  it('with a > b > c, the link a > c says nothing new', () => {
    expect(said(impliedLinks(links('a>b', 'b>c', 'a>c')))).toEqual(['a>c']);
  });

  it('finds a long way round too, and leaves every link of the way itself', () => {
    expect(said(impliedLinks(links('a>b', 'b>c', 'c>d', 'a>d', 'b>d')))).toEqual(['a>d', 'b>d']);
  });

  it('leaves a diamond alone: both ways to d are needed', () => {
    expect(said(impliedLinks(links('a>b', 'a>c', 'b>d', 'c>d')))).toEqual([]);
  });

  it('a helpful-first link is implied by a chain of Requires, never the other way round', () => {
    expect(said(impliedLinks(links('a>b', 'b>c', 'a~c')))).toEqual(['a~c']);
    expect(said(impliedLinks(links('a~b', 'b~c', 'a>c')))).toEqual([]);
    expect(said(impliedLinks(links('a>b', 'a~b')))).toEqual(['a~b']);
  });

  it('takes nothing out of a circle of requirements, and is not fooled by one', () => {
    expect(said(impliedLinks(links('a>b', 'b>a', 'a>c', 'b>c')))).toEqual([]);
    // From a the only other way to c leads back through a itself
    expect(said(impliedLinks(links('a>b', 'b>a', 'a>c')))).toEqual([]);
    // A circle on the way does not hide the real second way
    expect(said(impliedLinks(links('a>b', 'b>x', 'x>b', 'b>c', 'a>c')))).toEqual(['a>c']);
  });

  it('what is left still leads from everything to everything it led to', () => {
    // A made-up map of 60 with links only to later ones, and many of them
    const edges: MapEdge[] = [];
    for (let to = 1; to < 60; to++) {
      for (const back of [1, 2, 3, 7, 11]) {
        if (to - back >= 0 && (to * back) % 3 !== 0) edges.push({ from: `n${to - back}`, to: `n${to}`, helpful: false });
      }
    }
    const implied = impliedLinks(edges);
    expect(implied.size).toBeGreaterThan(10);
    const left = edges.filter((edge) => !implied.has(edge));
    for (let n = 0; n < 60; n++) {
      expect([...chainOf(`n${n}`, left).after].sort()).toEqual([...chainOf(`n${n}`, edges).after].sort());
    }
    // And nothing more can go: the reduction is done
    expect(impliedLinks(left).size).toBe(0);
  });
});

describe('shownLinks', () => {
  const edges = links('a>b', 'b>c', 'a>c', 'a~d', 'c~d');

  it('every link, Requires only, without the implied ones, or both', () => {
    expect(said(shownLinks(edges, { links: 'all', hideImplied: false }))).toEqual(['a>b', 'a>c', 'a~d', 'b>c', 'c~d']);
    expect(said(shownLinks(edges, { links: 'requires', hideImplied: false }))).toEqual(['a>b', 'a>c', 'b>c']);
    expect(said(shownLinks(edges, { links: 'all', hideImplied: true }))).toEqual(['a>b', 'a~d', 'b>c', 'c~d']);
    expect(said(shownLinks(edges, { links: 'requires', hideImplied: true }))).toEqual(['a>b', 'b>c']);
  });

  it('keeps the links themselves, in their order', () => {
    const shown = shownLinks(edges, { links: 'all', hideImplied: true });
    expect(shown.every((edge) => edges.includes(edge))).toBe(true);
    expect(shown).toEqual(edges.filter((edge) => shown.includes(edge)));
  });
});

describe('chainOf', () => {
  const edges = links('a>b', 'b>c', 'x>c', 'c>d', 'c~e', 'p>q');

  it('everything a concept builds on, near and far, and everything that builds on it', () => {
    const chain = chainOf('c', edges);
    expect([...chain.before].sort()).toEqual(['a', 'b', 'x']);
    expect([...chain.after].sort()).toEqual(['d', 'e']);
    expect(chainOf('p', edges)).toEqual({ before: new Set(), after: new Set(['q']) });
    expect(chainOf('nobody', edges)).toEqual({ before: new Set(), after: new Set() });
  });

  it('a link is part of the chain when it is on a way to the concept or on a way on from it', () => {
    const chain = chainOf('c', edges);
    const on = edges.filter((edge) => inChain(edge, 'c', chain));
    expect(said(on)).toEqual(['a>b', 'b>c', 'c>d', 'c~e', 'x>c']);
    // b's chain: x leads to c too, but not by way of b
    expect(said(edges.filter((edge) => inChain(edge, 'b', chainOf('b', edges))))).toEqual(['a>b', 'b>c', 'c>d', 'c~e']);
  });

  it('ends in a circle of requirements', () => {
    const chain = chainOf('a', links('a>b', 'b>a', 'b>c'));
    expect([...chain.after].sort()).toEqual(['a', 'b', 'c']);
    expect([...chain.before].sort()).toEqual(['a', 'b']);
  });
});
