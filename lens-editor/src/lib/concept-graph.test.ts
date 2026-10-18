import { describe, expect, it } from 'vitest';
import type { FolderMetadata } from '../hooks/useFolderMetadata';
import {
  MAX_ANCESTORS,
  MAX_CHILDREN_DRAWN,
  MAX_DEPTH,
  MORE_NODE,
  buildAncestors,
  childrenOf,
  countBelow,
  findCycle,
  graphData,
  isConceptPath,
  mainPath,
  parseParents,
  resolveParents,
  sameParents,
  walkBelow,
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

const links = (text: string) => parseParents(text).map((e) => e.link);
const names = (id: string) => id;

// The inputs are the relay's (concept_graph.rs, concept_graph_rules_v1_N), so the two agree.
describe('parseParents', () => {
  it('concept graph rules v1 #1: a block list, until the next key', () => {
    expect(links('---\nparent-concepts:\n  - "[[A]]"\n  - "[[B]]"\ntags:\n  - "[[C]]"\n---\n')).toEqual(['A', 'B']);
  });

  it('concept graph rules v1 #2: a single value', () => {
    expect(links('---\nparent-concepts: "[[A]]"\n---\n')).toEqual(['A']);
  });

  it('concept graph rules v1 #3: a flow list', () => {
    expect(links('---\nparent-concepts: ["[[A]]", \'[[B]]\']\n---\n')).toEqual(['A', 'B']);
  });

  it('concept graph rules v1 #4: quoted and unquoted links, alias and heading dropped', () => {
    expect(links('---\nparent-concepts:\n- [[A|alias]]\n- \'[[B#h]]\'\n- "[[../Concepts/C]]"\n---\n'))
      .toEqual(['A', 'B', '../Concepts/C']);
    expect(links('---\nparent-concepts: [[A]]\n---\n')).toEqual(['A']);
  });

  it('concept graph rules v1 #5: trailing comments', () => {
    expect(links('---\nparent-concepts:\n  - "[[A]]" # main\n  - [[B]]  # second\n  - "[[C #x]]"\n---\n'))
      .toEqual(['A', 'B', 'C']);
    expect(links('---\nparent-concepts: "[[A]]" # only one\n---\n')).toEqual(['A']);
  });

  it('concept graph rules v1 #6: frontmatter only, first key only, non-links kept raw', () => {
    expect(parseParents('---\nparent-concepts:\n  - Plain text\n  - ""\nparent-concepts: "[[Z]]"\n---\nparent-concepts: "[[Y]]"\n'))
      .toEqual([{ raw: 'Plain text', link: null }]);
    expect(parseParents('# T\nparent-concepts: "[[A]]"\n')).toEqual([]);
    expect(parseParents('---\nparent-concepts: "[[A]]"\n')).toEqual([]);
    expect(parseParents('---\nparent: "[[A]]"\n---\n')).toEqual([]);
    expect(links('---\r\nparent-concepts:\r\n  - "[[A]]"\r\n---  \r\nx')).toEqual(['A']);
  });

  it('concept graph rules v1 #7: resolution like the link indexer, kept when a concept file', () => {
    const metadata = {
      '/Lens Edu/Concepts/AI Control.md': { id: 'control', type: 'markdown', version: 0 },
      '/Lens Edu/Concepts/Monitoring.md': { id: 'mon', type: 'markdown', version: 0 },
      '/Lens Edu/articles/X.md': { id: 'art', type: 'markdown', version: 0 },
    } as unknown as FolderMetadata;
    const text = '---\nparent-concepts:\n  - "[[ai control]]"\n  - "[[Lens Edu/Concepts/Monitoring]]"\n  - "[[AI Control]]"\n  - "[[../articles/X]]"\n  - "[[Missing]]"\n---\n';
    expect(resolveParents(text, '/Lens Edu/Concepts/Low-stakes control.md', metadata)).toEqual({
      parents: ['control', 'mon'],
      unresolved: ['[[../articles/X]]', '[[Missing]]'],
    });
  });

  it('knows concept files and equal parent lists', () => {
    expect(isConceptPath('/Lens Edu/Concepts/X.md')).toBe(true);
    expect(isConceptPath('/Lens Edu/articles/X.md')).toBe(false);
    expect(sameParents({ parents: ['a'], unresolved: [] }, { parents: ['a'], unresolved: [] })).toBe(true);
    expect(sameParents({ parents: ['a'], unresolved: [] }, { parents: ['a'], unresolved: ['x'] })).toBe(false);
  });
});

describe('buildAncestors and mainPath', () => {
  it('multiple parents and a shortcut edge: every ancestor, main path by first parents', () => {
    const g = graph({ tm: ['low', 'mon', 'protocols'], low: ['protocols'], protocols: ['control'] });
    const a = buildAncestors('tm', g);
    expect(new Set(a.nodes)).toEqual(new Set(['low', 'mon', 'protocols', 'control']));
    expect(a.main).toEqual(['control', 'protocols', 'low']);
    expect(mainPath('mon', g)).toEqual([]);
    expect(a.cycle).toBeNull();
  });

  it('a cycle is reported and never hangs', () => {
    const a = buildAncestors('A', graph({ A: ['B'], B: ['C'], C: ['A'] }));
    expect(a.main).toEqual(['C', 'B']);
    expect(a.cycle).toEqual(['A', 'B', 'C', 'A']);
    expect(buildAncestors('A', graph({ A: ['A', 'B'] })).cycle).toEqual(['A', 'A']);
    expect(buildAncestors('X', graph({ X: ['A'], A: ['B'], B: ['A'] })).cycle).toEqual(['A', 'B', 'A']);
  });

  it('files not read yet are pending', () => {
    expect(buildAncestors('A', graph({ A: ['B'] }, ['B'])).pending).toEqual(['B']);
  });

  it('caps depth and files', () => {
    const chain: Record<string, string[]> = {};
    for (let i = 0; i < 30; i++) chain[`n${i}`] = [`n${i + 1}`];
    const deep = buildAncestors('n0', graph(chain));
    expect(deep.cut).toBe(true);
    expect(deep.nodes).toHaveLength(MAX_DEPTH);

    const wide = buildAncestors('A', graph({ A: Array.from({ length: MAX_ANCESTORS + 10 }, (_, i) => `p${i}`) }));
    expect(wide.cut).toBe(true);
    expect(wide.nodes.length).toBeLessThanOrEqual(MAX_ANCESTORS);
  });
});

describe('findCycle', () => {
  it('none in a DAG with shared ancestors', () => {
    const next = (id: string) => ({ A: ['B', 'C'], B: ['D'], C: ['D'] } as Record<string, string[]>)[id] ?? [];
    expect(findCycle(['A', 'B', 'C', 'D'], next)).toBeNull();
  });
});

describe('children and the walk below', () => {
  it('children are backlinkers whose parents include the file', () => {
    const parents: Record<string, ResolvedParents> = {
      child: { parents: ['me'], unresolved: [] },
      second: { parents: ['other', 'me'], unresolved: [] },
      mentions: { parents: ['other'], unresolved: [] }, // links to me in its text only
    };
    expect(childrenOf('me', ['child', 'mentions', 'second', 'unread', 'me'], (id) => parents[id]))
      .toEqual({ ids: ['child', 'second'], pending: ['unread'] });
  });

  it('walks below once per concept, sorted, and counts distinct concepts', () => {
    const edges = { b: ['a'], c: ['a'], d: ['b', 'c'], e: ['d'] };
    const below = walkBelow('a', candidates(edges, { a: ['mention'] }), graph(edges), names);
    expect(below.kids.get('a')).toEqual(['b', 'c']);
    expect(below).toMatchObject({ cut: false, cycle: false, pending: [] });
    expect(countBelow('a', below.kids, 'a')).toEqual({ count: 4, cut: false });
    expect(countBelow('b', below.kids, 'a')).toEqual({ count: 2, cut: false });
    expect(countBelow('e', below.kids, 'a')).toEqual({ count: 0, cut: false });
  });

  it('a cycle back to the opened file is flagged, not followed; depth is capped', () => {
    const loop = { b: ['a'], a: ['b'] };
    expect(walkBelow('a', candidates(loop), graph(loop), names).cycle).toBe(true);

    const chain: Record<string, string[]> = {};
    for (let i = 1; i <= 30; i++) chain[`n${i}`] = [`n${i - 1}`];
    const below = walkBelow('n0', candidates(chain), graph(chain), names);
    expect(below.cut).toBe(true);
    expect(countBelow('n1', below.kids, 'n0').cut).toBe(true);
  });
});

describe('graphData', () => {
  it('draws every ancestor with all parent edges (shortcuts too), the file, and its children', () => {
    const edges = { tm: ['low', 'mon', 'protocols'], low: ['protocols'], protocols: ['control'], col: ['tm'], deep: ['col'] };
    const parentsOf = graph(edges);
    const ancestors = buildAncestors('tm', parentsOf);
    const below = walkBelow('tm', candidates(edges), parentsOf, names);
    const { nodes, edges: drawn } = graphData('tm', ancestors, parentsOf, below);
    expect(nodes.find((n) => n.id === 'tm')?.kind).toBe('self');
    expect(nodes.filter((n) => n.kind === 'ancestor').map((n) => n.id).sort()).toEqual(['control', 'low', 'mon', 'protocols']);
    expect(nodes.find((n) => n.id === 'col')).toMatchObject({ kind: 'child', count: 1 });
    expect(drawn).toEqual(expect.arrayContaining([
      { from: 'low', to: 'tm' }, { from: 'mon', to: 'tm' }, { from: 'protocols', to: 'tm' }, // shortcut
      { from: 'protocols', to: 'low' }, { from: 'control', to: 'protocols' }, { from: 'tm', to: 'col' },
    ]));
    expect(drawn).toHaveLength(6);
  });

  it('draws at most MAX_CHILDREN_DRAWN children, then a "more" node', () => {
    const edges: Record<string, string[]> = {};
    for (let i = 0; i < MAX_CHILDREN_DRAWN + 3; i++) edges[`k${String(i).padStart(2, '0')}`] = ['me'];
    const parentsOf = graph(edges);
    const { nodes } = graphData('me', buildAncestors('me', parentsOf), parentsOf, walkBelow('me', candidates(edges), parentsOf, names));
    expect(nodes.filter((n) => n.kind === 'child')).toHaveLength(MAX_CHILDREN_DRAWN);
    expect(nodes.find((n) => n.id === MORE_NODE)).toMatchObject({ kind: 'more', more: 3 });
  });
});
