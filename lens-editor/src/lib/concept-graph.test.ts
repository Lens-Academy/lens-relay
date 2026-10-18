import { describe, expect, it } from 'vitest';
import type { FolderMetadata } from '../hooks/useFolderMetadata';
import {
  MAX_DEPTH,
  MAX_NODES,
  buildAncestors,
  buildDescendants,
  childrenOf,
  findCycle,
  isConceptPath,
  parseParents,
  resolveParents,
  type ParentsOf,
  type ResolvedParents,
} from './concept-graph';

/** A graph given as child → parents (ids). */
function graph(edges: Record<string, string[]>, unread: string[] = []): ParentsOf {
  return (id) => (unread.includes(id) ? undefined : { parents: edges[id] ?? [], unresolved: [] });
}

/** Backlinkers of each id: every node naming it as a parent, plus `extra`. */
function candidates(edges: Record<string, string[]>, extra: Record<string, string[]> = {}) {
  return (id: string) => [
    ...Object.entries(edges).filter(([, ps]) => ps.includes(id)).map(([c]) => c),
    ...(extra[id] ?? []),
  ];
}

describe('parseParents', () => {
  const fm = (body: string) => `---\n${body}\n---\n# Title\n`;

  it('reads a block list, quoted or not, keeping order', () => {
    expect(parseParents(fm("parent:\n  - \"[[A]]\"\n  - [[B|alias]]\n  - '[[../Concepts/C#x]]'")))
      .toEqual([
        { raw: '[[A]]', link: 'A' },
        { raw: '[[B|alias]]', link: 'B' },
        { raw: '[[../Concepts/C#x]]', link: '../Concepts/C' },
      ]);
  });

  it('reads a single value and a flow list', () => {
    expect(parseParents(fm('parent: "[[A]]"')).map((e) => e.link)).toEqual(['A']);
    expect(parseParents(fm('parent: [[A]]')).map((e) => e.link)).toEqual(['A']);
    expect(parseParents(fm('parent: ["[[A]]", "[[B]]"]')).map((e) => e.link)).toEqual(['A', 'B']);
  });

  it('stops at the next key, allows column-0 list items, and keeps non-links as raw', () => {
    const text = fm('title: x\nparent:\n- "[[A]]"\n- Effective altruism\nskill-tree: topic\ntags:\n  - "[[Not a parent]]"');
    expect(parseParents(text)).toEqual([
      { raw: '[[A]]', link: 'A' },
      { raw: 'Effective altruism', link: null },
    ]);
  });

  it('only reads frontmatter', () => {
    expect(parseParents('# Title\nparent: "[[A]]"\n')).toEqual([]);
    expect(parseParents('---\nparent: "[[A]]"\n')).toEqual([]); // never closed
    expect(parseParents('---\r\nparent:\r\n  - "[[A]]"\r\n---  \r\nx')).toEqual([{ raw: '[[A]]', link: 'A' }]);
  });
});

describe('resolveParents', () => {
  const metadata = {
    '/Lens Edu/Concepts/AI Control.md': { id: 'ctl', type: 'markdown', version: 0 },
    '/Lens Edu/Concepts/Monitoring.md': { id: 'mon', type: 'markdown', version: 0 },
    '/Lens Edu/articles/Monitoring.md': { id: 'art', type: 'markdown', version: 0 },
    '/Lens Edu/articles/Only an article.md': { id: 'art2', type: 'markdown', version: 0 },
  } as unknown as FolderMetadata;
  const path = '/Lens Edu/Concepts/Low-stakes control.md';

  it('resolves bare names and relative paths to concept files, case-insensitively, without repeats', () => {
    const text = '---\nparent:\n  - "[[ai control]]"\n  - "[[../Concepts/Monitoring]]"\n  - "[[AI Control]]"\n---\n';
    expect(resolveParents(text, path, metadata)).toEqual({ parents: ['ctl', 'mon'], unresolved: [] });
  });

  it('reports entries that are not links, do not resolve, or resolve outside Concepts/', () => {
    const text = '---\nparent:\n  - "[[Missing]]"\n  - Plain text\n  - "[[../articles/Only an article]]"\n---\n';
    expect(resolveParents(text, path, metadata)).toEqual({
      parents: [],
      unresolved: ['[[Missing]]', 'Plain text', '[[../articles/Only an article]]'],
    });
  });

  it('knows concept files', () => {
    expect(isConceptPath('/Lens Edu/Concepts/X.md')).toBe(true);
    expect(isConceptPath('/Lens Edu/articles/X.md')).toBe(false);
    expect(isConceptPath('/Lens Edu/Concepts/x.html')).toBe(false);
  });
});

describe('buildAncestors', () => {
  it('top-level concept: no paths', () => {
    const a = buildAncestors('top', graph({}));
    expect(a).toMatchObject({ main: [], others: [], nodes: [], cycle: null, cut: false, pending: [] });
  });

  it('multiple parents: the main path follows first parents, the others are listed', () => {
    // Trusted monitoring ⊂ Low-stakes control ⊂ Control protocols ⊂ AI Control
    //                    ⊂ Monitoring and interpretability (second parent, top-level)
    const a = buildAncestors('tm', graph({
      tm: ['low', 'mon'],
      low: ['protocols'],
      protocols: ['control'],
    }));
    expect(a.main).toEqual(['control', 'protocols', 'low']);
    expect(a.others).toEqual([['mon']]);
    expect(new Set(a.nodes)).toEqual(new Set(['low', 'mon', 'protocols', 'control']));
    expect(a.cycle).toBeNull();
  });

  it('shortcut edges are a second path, not an error', () => {
    // A ⊂ B ⊂ D, and A ⊂ D directly
    const a = buildAncestors('A', graph({ A: ['B', 'D'], B: ['D'] }));
    expect(a.main).toEqual(['D', 'B']);
    expect(a.others).toEqual([['D']]);
    expect(a.cycle).toBeNull();
    expect(a.nodes.sort()).toEqual(['B', 'D']);
  });

  it('a cycle is reported and never hangs; the main path stops at the repeat', () => {
    const a = buildAncestors('A', graph({ A: ['B'], B: ['C'], C: ['A'] }));
    expect(a.main).toEqual(['C', 'B']);
    expect(a.cycle).toEqual(['A', 'B', 'C', 'A']);
  });

  it('a self-parent is a cycle', () => {
    const a = buildAncestors('A', graph({ A: ['A', 'B'] }));
    expect(a.main).toEqual([]); // the first parent is itself
    expect(a.cycle).toEqual(['A', 'A']);
    expect(a.others).toEqual([['B']]);
  });

  it('a cycle above the opened file is reported too', () => {
    const a = buildAncestors('X', graph({ X: ['A'], A: ['B'], B: ['A'] }));
    expect(a.cycle).toEqual(['A', 'B', 'A']);
    expect(a.main).toEqual(['B', 'A']);
  });

  it('files not read yet are pending', () => {
    const a = buildAncestors('A', graph({ A: ['B'], B: ['C'] }, ['B']));
    expect(a.pending).toEqual(['B']);
    expect(a.main).toEqual(['B']);
  });

  it('caps depth', () => {
    const edges: Record<string, string[]> = {};
    for (let i = 0; i < 30; i++) edges[`n${i}`] = [`n${i + 1}`];
    const a = buildAncestors('n0', graph(edges));
    expect(a.cut).toBe(true);
    expect(a.main).toHaveLength(MAX_DEPTH);
    expect(a.nodes).toHaveLength(MAX_DEPTH);
  });

  it('caps the number of files', () => {
    const wide = Array.from({ length: MAX_NODES + 50 }, (_, i) => `p${i}`);
    const a = buildAncestors('A', graph({ A: wide }));
    expect(a.cut).toBe(true);
    expect(a.nodes.length).toBeLessThanOrEqual(MAX_NODES);
    expect(a.pathsCut).toBe(true);
  });
});

describe('findCycle', () => {
  it('none in a DAG with shared ancestors', () => {
    expect(findCycle(['A', 'B', 'C', 'D'], (id) => ({ A: ['B', 'C'], B: ['D'], C: ['D'] } as Record<string, string[]>)[id] ?? []))
      .toBeNull();
  });
});

describe('childrenOf', () => {
  it('keeps only backlinkers whose parent: resolves to the file', () => {
    const parents: Record<string, ResolvedParents> = {
      child: { parents: ['me'], unresolved: [] },
      second: { parents: ['other', 'me'], unresolved: [] },
      mentions: { parents: ['other'], unresolved: [] }, // links to me in its text only
    };
    const out = childrenOf('me', ['child', 'mentions', 'second', 'unread', 'me'], (id) => parents[id]);
    expect(out).toEqual({ ids: ['child', 'second'], pending: ['unread'] });
  });
});

describe('buildDescendants', () => {
  const names = (id: string) => id;

  it('builds a tree, shows a shared child once expanded and once as a repeat, counts distinct', () => {
    const edges = { b: ['a'], c: ['a'], d: ['b', 'c'], e: ['d'] };
    const out = buildDescendants('a', candidates(edges, { a: ['mention'] }), graph(edges), names);
    expect(out.count).toBe(4);
    expect(out.tree).toEqual([
      { id: 'b', children: [{ id: 'd', children: [{ id: 'e', children: [] }] }] },
      { id: 'c', children: [{ id: 'd', children: [], repeat: true }] },
    ]);
    expect(out).toMatchObject({ cut: false, cycle: false, pending: [] });
  });

  it('a cycle back to the opened file is flagged, not followed', () => {
    const edges = { b: ['a'], a: ['b'] };
    const out = buildDescendants('a', candidates(edges), graph(edges), names);
    expect(out.cycle).toBe(true);
    expect(out.count).toBe(1);
  });

  it('caps depth and reports unread files', () => {
    const edges: Record<string, string[]> = {};
    for (let i = 1; i <= 30; i++) edges[`n${i}`] = [`n${i - 1}`];
    const out = buildDescendants('n0', candidates(edges), graph(edges), names);
    expect(out.cut).toBe(true);
    expect(out.count).toBe(MAX_DEPTH);

    const pending = buildDescendants('n0', candidates(edges), graph(edges, ['n3']), names);
    expect(pending.pending).toEqual(['n3']);
    expect(pending.count).toBe(2);
  });
});
