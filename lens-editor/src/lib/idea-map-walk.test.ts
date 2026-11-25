import { describe, expect, it } from 'vitest';
import { buildIdeaGraph, type IdeaGraph } from './idea-map';
import {
  foundationsWalk,
  goalPath,
  goalWalk,
  groupLinks,
  mostRequired,
  parseSeen,
  proposeNext,
  readingOrder,
  seenId,
  topicWalk,
  walkEdges,
  walkPrerequisites,
  type WalkGroup,
} from './idea-map-walk';

interface Spec { topic?: string; requires?: string[]; helpful?: string[]; id?: string }

/** A graph from names: what each requires, what is helpful first, its topic. */
function graphOf(specs: Record<string, Spec>): IdeaGraph {
  const list = (title: string, names: string[] = []) => (names.length > 0 ? `\n## ${title}\n${names.map((name) => `- [[${name}]]`).join('\n')}\n` : '');
  return buildIdeaGraph(Object.entries(specs).map(([name, spec]) => ({
    name,
    docId: name,
    text: `---\n${spec.id ? `id: ${spec.id}\n` : ''}priority: medium\n${spec.topic ? `topic: ${spec.topic}\n` : ''}---\nOutcome of ${name}.\n${list('Requires', spec.requires)}${list('Helpful first', spec.helpful)}`,
  })));
}

/** The topics of a graph as groups, in the order given. */
function groupsOf(graph: IdeaGraph, order: string[]): WalkGroup[] {
  return order.map((label, tone) => ({
    key: `topic:${label.toLowerCase()}`,
    label,
    tone,
    members: graph.nodes.filter((node) => (node.idea?.topic ?? '') === label).map((node) => node.key),
  }));
}

const keys = (steps: ReadonlyArray<{ key: string }>) => steps.map((step) => step.key);

/** Every link kept by the walk: its first end is shown before its second. */
function violations(graph: IdeaGraph, order: string[], helpfulToo = false): string[] {
  const at = new Map(order.map((key, index) => [key, index]));
  return walkEdges(graph)
    .filter((edge) => (helpfulToo || !edge.helpful) && at.get(edge.from)! > at.get(edge.to)!)
    .map((edge) => `${edge.from} > ${edge.to}`);
}

// Two topics; "b3" needs something of the later topic, "c1" needs nothing
const TWO = {
  a1: { topic: 'Basics' },
  a2: { topic: 'Basics', requires: ['a1'] },
  a3: { topic: 'Basics', requires: ['a2'], helpful: ['a4'] },
  a4: { topic: 'Basics' },
  b1: { topic: 'Build', requires: ['a2'] },
  b2: { topic: 'Build', requires: ['b1'] },
  b3: { topic: 'Build', requires: ['b1', 'c2'] },
  c1: { topic: 'Core' },
  c2: { topic: 'Core', requires: ['c1'] },
  c3: { topic: 'Core', requires: ['c2', 'b3'] },
};

/** A made-up graph of `count` concepts in five topics, links only to earlier ones: the same every time. */
function bigGraph(count: number): IdeaGraph {
  let state = 7;
  const random = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const specs: Record<string, Spec> = {};
  for (let i = 0; i < count; i++) {
    const earlier = (most: number) => [...new Set(Array.from({ length: Math.floor(random() * most) }, () => `n${Math.floor(random() * i)}`))].filter(() => i > 0);
    specs[`n${i}`] = { topic: `T${Math.floor(random() * 5)}`, requires: earlier(3), helpful: earlier(2) };
  }
  return graphOf(specs);
}

describe('foundationsWalk', () => {
  it('shows every concept once, each after what it requires and what is helpful first', () => {
    const graph = bigGraph(120);
    const groups = readingOrder(graph, groupsOf(graph, ['T0', 'T1', 'T2', 'T3', 'T4']));
    const order = keys(foundationsWalk(graph, groups));
    expect(order).toHaveLength(120);
    expect(new Set(order).size).toBe(120);
    expect(violations(graph, order, true)).toEqual([]);
  });

  it('gives the same order every time, whatever order the files came in', () => {
    const graph = graphOf(TWO);
    const again = graphOf(Object.fromEntries(Object.entries(TWO).reverse()));
    const order = keys(foundationsWalk(graph, groupsOf(graph, ['Basics', 'Build', 'Core'])));
    expect(keys(foundationsWalk(graph, groupsOf(graph, ['Basics', 'Build', 'Core'])))).toEqual(order);
    expect(keys(foundationsWalk(again, groupsOf(again, ['Basics', 'Build', 'Core'])))).toEqual(order);
  });

  it('finishes one topic before the next, follows a chain, and pulls in what a concept needs from a later topic', () => {
    const graph = graphOf(TWO);
    const steps = foundationsWalk(graph, groupsOf(graph, ['Basics', 'Build', 'Core']));
    // a1 → a2 is followed before the other foundation a4; a3 waits for a4 (helpful first)
    expect(keys(steps)).toEqual(['a1', 'a2', 'a4', 'a3', 'b1', 'b2', 'c1', 'c2', 'b3', 'c3']);
    // c1 and c2 come early, for b3, and say so
    expect(steps.filter((step) => step.pulledFor)).toEqual([{ key: 'c1', pulledFor: 'c2' }, { key: 'c2', pulledFor: 'b3' }]);
  });

  it('keeps topics together when nothing needs a later topic', () => {
    const graph = graphOf({
      a1: { topic: 'A' }, a2: { topic: 'A', requires: ['a1'] }, a3: { topic: 'A' },
      b1: { topic: 'B', requires: ['a1'] }, b2: { topic: 'B', requires: ['b1', 'a3'] },
    });
    const steps = foundationsWalk(graph, groupsOf(graph, ['A', 'B']));
    expect(keys(steps)).toEqual(['a1', 'a2', 'a3', 'b1', 'b2']);
    expect(steps.some((step) => step.pulledFor)).toBe(false);
  });

  it('survives a circle of requirements: every concept still appears once', () => {
    const graph = graphOf({
      a: { topic: 'T', requires: ['c'] },
      b: { topic: 'T', requires: ['a'] },
      c: { topic: 'T', requires: ['b'] },
      d: { topic: 'T', requires: ['c'] },
      e: { topic: 'U', requires: ['e'] },
    });
    expect(graph.cycles.length).toBeGreaterThan(0);
    const order = keys(foundationsWalk(graph, groupsOf(graph, ['T', 'U'])));
    expect([...order].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    // Only the link that closes the circle is not kept
    expect(violations(graph, order)).toHaveLength(1);
    expect(order.indexOf('d')).toBeGreaterThan(order.indexOf('c'));
  });

  it('leaves out a Helpful first link that would put a concept before what it is required for', () => {
    // a is helpful before b, but a requires b
    const graph = graphOf({ a: { topic: 'T', requires: ['b'] }, b: { topic: 'T', helpful: ['a'] } });
    expect(walkPrerequisites(graph).get('b')).toEqual([]);
    expect(keys(foundationsWalk(graph, groupsOf(graph, ['T'])))).toEqual(['b', 'a']);
  });

  it('shows the concepts of no group at the end, and one not written yet too', () => {
    const graph = graphOf({ a: { topic: 'T', requires: ['ghost'] }, loose: {} });
    const steps = foundationsWalk(graph, groupsOf(graph, ['T']));
    expect(keys(steps)).toEqual(['ghost', 'a', 'loose']);
    expect(steps[0]).toEqual({ key: 'ghost', pulledFor: 'a' });
  });

  it('does not overflow on a long chain', () => {
    const specs: Record<string, Spec> = {};
    for (let i = 0; i < 400; i++) specs[`n${i}`] = { topic: i % 2 ? 'Odd' : 'Even', requires: i > 0 ? [`n${i - 1}`] : [] };
    const graph = graphOf(specs);
    // The worst order: the last concept is asked for first
    const order = keys(foundationsWalk(graph, groupsOf(graph, ['Odd', 'Even']).map((group) => ({ ...group, members: [...group.members].reverse() }))));
    expect(order).toHaveLength(400);
    expect(violations(graph, order)).toEqual([]);
  });
});

describe('topicWalk', () => {
  it('orders one topic by the same rule; what it needs from other topics is no step', () => {
    const graph = graphOf(TWO);
    const [basics, build, core] = groupsOf(graph, ['Basics', 'Build', 'Core']);
    expect(keys(topicWalk(graph, basics))).toEqual(['a1', 'a2', 'a4', 'a3']);
    // c2, of another topic, is not waited for: b3 (which more builds on) comes before b2
    expect(topicWalk(graph, build)).toEqual([{ key: 'b1' }, { key: 'b3' }, { key: 'b2' }]);
    expect(keys(topicWalk(graph, core))).toEqual(['c1', 'c2', 'c3']);
  });
});

describe('readingOrder', () => {
  it('puts a topic after the topics it builds on, whatever order they came in', () => {
    const graph = graphOf(TWO);
    const labels = (order: string[]) => readingOrder(graph, groupsOf(graph, order)).map((group) => group.label);
    // Build needs Basics (1 link) and one concept of Core; Core needs Build once: Build → Core weighs the same both ways
    expect(labels(['Core', 'Build', 'Basics'])[0]).toBe('Basics');
    expect(labels(['Core', 'Build', 'Basics'])).toEqual(labels(['Basics', 'Build', 'Core']));
  });

  it('orders a chain of topics', () => {
    const graph = graphOf({
      z: { topic: 'Last', requires: ['m'] },
      m: { topic: 'Middle', requires: ['f'] },
      f: { topic: 'First' },
    });
    expect(readingOrder(graph, groupsOf(graph, ['Last', 'Middle', 'First'])).map((group) => group.label)).toEqual(['First', 'Middle', 'Last']);
  });
});

describe('groupLinks', () => {
  it('counts the links of a pair of topics once, in the direction most go', () => {
    const graph = graphOf(TWO);
    const groups = groupsOf(graph, ['Basics', 'Build', 'Core']);
    expect(groupLinks(graph, groups)).toEqual([
      { from: 'topic:basics', to: 'topic:build', count: 1, back: 0 },
      { from: 'topic:build', to: 'topic:core', count: 1, back: 1 },
    ]);
  });
});

describe('goalWalk', () => {
  const graph = graphOf({
    goal: { requires: ['p1', 'p2'], helpful: ['h'] },
    p1: { requires: ['deep'] },
    p2: { requires: ['deep', 'other'] },
    deep: {},
    other: {},
    h: {},
    unrelated: { requires: ['goal'] },
  });

  it('is the goal, then what it requires depth first, each once', () => {
    const steps = goalWalk(graph, 'goal');
    expect(keys(steps)).toEqual(['goal', 'p1', 'deep', 'p2', 'other']);
    expect(steps[0].parent).toBeNull();
    expect(steps.find((step) => step.key === 'deep')!.parent).toBe('p1');
    expect(goalPath(steps, 'deep')).toEqual(['goal', 'p1', 'deep']);
    expect(goalPath(steps, 'other')).toEqual(['goal', 'p2', 'other']);
    expect(goalPath(steps, 'unrelated')).toEqual([]);
  });

  it('follows Helpful first only when asked, after the requirements', () => {
    const steps = goalWalk(graph, 'goal', { helpful: true });
    expect(keys(steps)).toEqual(['goal', 'p1', 'deep', 'p2', 'other', 'h']);
    expect(steps[5]).toEqual({ key: 'h', parent: 'goal', helpful: true });
  });

  it('ends in a circle, and is empty for a concept that is not there', () => {
    const circle = graphOf({ a: { requires: ['b'] }, b: { requires: ['a'] } });
    expect(keys(goalWalk(circle, 'a'))).toEqual(['a', 'b']);
    expect(goalWalk(circle, 'nothing')).toEqual([]);
  });
});

describe('proposeNext', () => {
  const graph = graphOf({
    root: {},
    mid: { requires: ['root'] },
    hub: { requires: ['root'] },
    leaf1: { requires: ['hub', 'mid'] },
    leaf2: { requires: ['hub'] },
    side: { helpful: ['mid'] },
    island: {},
  });

  it('proposes what the concept requires first', () => {
    expect(proposeNext(graph, 'mid', new Set(['mid']))).toEqual({ key: 'root', why: 'Not seen yet · "mid" requires it · needed for 2 others' });
  });

  it('then what builds on it: one whose requirements are all seen before one that waits for more', () => {
    // leaf2 only waits for hub; leaf1 also needs mid
    expect(proposeNext(graph, 'hub', new Set(['root', 'hub']))?.key).toBe('leaf2');
    expect(proposeNext(graph, 'hub', new Set(['root', 'hub', 'leaf2']))).toEqual({ key: 'leaf1', why: 'Not seen yet · builds on "hub"' });
  });

  it('then the Helpful first links, then the nearest concept not seen yet', () => {
    expect(proposeNext(graph, 'mid', new Set(['root', 'mid', 'leaf1']))?.key).toBe('side');
    const far = proposeNext(graph, 'leaf2', new Set(['root', 'hub', 'leaf2', 'leaf1']));
    expect(far).toEqual({ key: 'mid', why: 'The nearest concept not seen yet · 3 links from "leaf2" · needed for 1 other' });
  });

  it('goes to a concept nothing links here when that is all that is left, and nowhere when all are seen', () => {
    const all = new Set(graph.nodes.map((node) => node.key));
    const rest = new Set([...all].filter((key) => key !== 'island'));
    expect(proposeNext(graph, 'root', rest)).toEqual({ key: 'island', why: 'Not seen yet · not linked to "root"' });
    expect(proposeNext(graph, 'root', all)).toBeNull();
  });

  it('starts at a concept that requires nothing and most build on', () => {
    expect(proposeNext(graph, null, new Set())?.key).toBe('root');
  });
});

describe('what the overview and the store need', () => {
  it('names the concepts of a topic most others require', () => {
    const graph = graphOf(TWO);
    expect(mostRequired(graph, ['a1', 'a2', 'a3', 'a4'], 2).map((node) => node.key)).toEqual(['a2', 'a1']);
  });

  it('remembers a concept by the id of its file, else by its key', () => {
    const graph = graphOf({ 'With Id': { id: '00000000-0000-4000-8000-000000000001', requires: ['Ghost'] } });
    expect(seenId(graph.byKey.get('with id')!)).toBe('00000000-0000-4000-8000-000000000001');
    expect(seenId(graph.byKey.get('ghost')!)).toBe('ghost');
  });

  it('reads what the browser kept, whatever is in there', () => {
    expect(parseSeen('["a","b",3]')).toEqual(['a', 'b']);
    expect(parseSeen('{"a":1}')).toEqual([]);
    expect(parseSeen('not json')).toEqual([]);
    expect(parseSeen(null)).toEqual([]);
  });
});
