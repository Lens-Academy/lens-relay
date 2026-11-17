import { describe, expect, it } from 'vitest';
import { buildIdeaGraph } from '../../src/lib/idea-map';
import { fakeIdeas } from './fake-ideas';

const graphOf = (files: Array<{ name: string; text: string }>) =>
  buildIdeaGraph(files.map((f) => ({ ...f, docId: f.name })));

describe('fakeIdeas', () => {
  it('makes about 150 ideas with about 250 requirement links, the same every time', () => {
    const files = fakeIdeas();
    expect(fakeIdeas()).toEqual(files);
    const graph = graphOf(files);
    const written = graph.nodes.filter((n) => n.written);
    expect(written).toHaveLength(150);
    const links = written.reduce((sum, n) => sum + n.requires.length, 0);
    expect(links).toBeGreaterThanOrEqual(230);
    expect(links).toBeLessThanOrEqual(270);
    expect(graph.cycles).toEqual([]);
    expect(graph.steps.length).toBeGreaterThanOrEqual(6);
  });

  it('gives every idea a name nobody would take for a real one, and its own id', () => {
    const files = fakeIdeas();
    expect(files.every((f) => /\(fake \d{3}\)$/.test(f.name))).toBe(true);
    expect(new Set(files.map((f) => f.name.toLowerCase())).size).toBe(files.length);
    const graph = graphOf(files);
    expect(graph.nodes.flatMap((n) => n.problems).filter((p) => p.kind === 'duplicate-id' || p.kind === 'no-id')).toEqual([]);
  });

  it('has something of everything the map must show', () => {
    const graph = graphOf(fakeIdeas());
    const kinds = new Set(graph.nodes.flatMap((n) => n.problems.map((p) => p.kind)));
    for (const kind of ['placeholder', 'not-written', 'no-questions', 'no-lens', 'no-outcome']) {
      expect(kinds, kind).toContain(kind);
    }
    expect(new Set(graph.nodes.map((n) => n.idea?.priority))).toEqual(new Set(['high', 'medium', 'low', undefined]));
    expect(graph.nodes.some((n) => n.helpful.length > 0)).toBe(true);
  });

  it('adds a cycle of requirements when asked', () => {
    const graph = graphOf(fakeIdeas({ count: 12, cycle: true }));
    expect(graph.nodes.filter((n) => n.written)).toHaveLength(12);
    expect(graph.cycles).toHaveLength(1);
    expect(graph.cycles[0]).toHaveLength(3);
  });

  it('makes a set of any size: no gap outside the set, no link to nothing', () => {
    for (let count = 1; count <= 60; count++) {
      const files = fakeIdeas({ count, cycle: true });
      expect(files, String(count)).toHaveLength(count);
      expect(files.some((f) => f.text.includes('undefined')), String(count)).toBe(false);
    }
    // From 30 on some requirements are not written yet
    expect(graphOf(fakeIdeas({ count: 40 })).nodes.some((n) => !n.written)).toBe(true);
  });
});
