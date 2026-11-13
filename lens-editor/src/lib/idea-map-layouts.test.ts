import { describe, expect, it } from 'vitest';
import { buildIdeaGraph, type IdeaFile } from './idea-map';
import type { MapEdge, MapSizes } from './idea-map-layout';
import { layoutLayered } from './idea-map-layered';
import { GROUPED_LAYOUTS, MAP_GROUPINGS, MAP_LAYOUTS, NO_TOPIC, communities, hasTopics, ideaGroups, layoutFor, parseChoice, resolveChoice, topicsOf, type DrawnMap, type GroupBy, type MapFrame, type MapLayoutChoice, type MapLayoutKind } from './idea-map-layouts';
import { treeParents } from './idea-map-tree';
import { crowdedBoxes, fixtureMap, linesOnTop, linesThroughBoxes, pathPoints, sideOf } from './idea-map-layouts.fixture';
import { shownLinks } from './idea-map-links';

const SIZES: MapSizes = { nodeWidth: 176, gapX: 40, gapY: 12, margin: 16 };
const W = SIZES.nodeWidth;

/** A map from lines like "b: a, ~c" (b requires a, c is helpful first). */
function mapOf(lines: readonly string[], more: Record<string, string> = {}) {
  const files: IdeaFile[] = lines.map((line, i) => {
    const [name, needs = ''] = line.split(':').map((part) => part.trim());
    const links = needs.split(',').map((part) => part.trim()).filter(Boolean);
    const list = (helpful: boolean) => links.filter((link) => link.startsWith('~') === helpful).map((link) => `- [[${link.replace('~', '')}]]`).join('\n');
    return {
      name,
      docId: `doc-${i}`,
      text: `---\nid: 00000000-0000-4000-8000-${String(i).padStart(12, '0')}\n${more[name] ?? ''}---\n## Learning Outcome:\nSomething about ${name}.\n\n## Requires:\n${list(false)}\n\n## Helpful first:\n${list(true)}\n`,
    };
  });
  const graph = buildIdeaGraph(files);
  const edges: MapEdge[] = graph.nodes.flatMap((node) => [
    ...node.requires.map((from) => ({ from, to: node.key, helpful: false })),
    ...node.helpful.map((from) => ({ from, to: node.key, helpful: true })),
  ]);
  return { graph, edges, heightOf: () => 36, sizes: SIZES };
}

/** A choice with every part said. */
const drawnAs = (layout: MapLayoutKind, groupBy: GroupBy = 'cluster', more: Partial<MapLayoutChoice> = {}): MapLayoutChoice => ({ layout, groupBy, links: 'all', hideImplied: false, ...more });

const inFrame = (frame: MapFrame, box: { x: number; y: number; height: number }) => (
  box.x >= frame.x && box.y >= frame.y && box.x + W <= frame.x + frame.width && box.y + box.height <= frame.y + frame.height
);
const framesApart = (frames: readonly MapFrame[]) => frames.every((p, i) => frames.slice(i + 1).every((q) => (
  p.x + p.width <= q.x || q.x + q.width <= p.x || p.y + p.height <= q.y || q.y + q.height <= p.y
)));
const ends = (d: string) => {
  const points = pathPoints(d);
  return { start: points[0], end: points[points.length - 1] };
};

describe('parseChoice', () => {
  it('reads back what was stored', () => {
    expect(parseChoice(JSON.stringify({ layout: 'groups', groupBy: 'priority', links: 'requires', hideImplied: true }))).toEqual({ layout: 'groups', groupBy: 'priority', links: 'requires', hideImplied: true });
  });

  it.each([null, '', 'groups', '{"layout":"spiral","groupBy":7,"links":"some","hideImplied":"yes"}', '[]', 'null'])('knows nothing of %j', (raw) => {
    expect(parseChoice(raw)).toEqual({});
  });

  it('keeps the half it knows', () => {
    expect(parseChoice('{"layout":"rows","groupBy":"colour"}')).toEqual({ layout: 'rows' });
  });
});

describe('resolveChoice', () => {
  const plain = mapOf(['a', 'b: a']);
  const withTopics = mapOf(['a', 'b: a'], { a: 'topic: Basics\n' });

  it('a small map with no topics: left to right, clusters, every link', () => {
    expect(resolveChoice({}, plain.graph)).toEqual({ layout: 'columns', groupBy: 'cluster', links: 'all', hideImplied: false });
  });

  it('groups are the author\'s topics as soon as one concept has a topic', () => {
    expect(hasTopics(plain.graph)).toBe(false);
    expect(hasTopics(withTopics.graph)).toBe(true);
    expect(resolveChoice({}, withTopics.graph).groupBy).toBe('topic');
    expect(resolveChoice({ groupBy: 'priority' }, withTopics.graph).groupBy).toBe('priority');
  });

  it('never groups by topic a map that has none, whatever was chosen for another map', () => {
    expect(resolveChoice({ groupBy: 'topic' }, plain.graph).groupBy).toBe('cluster');
  });

  it('a big map opens in groups; what was chosen stays', () => {
    const big = fixtureMap(80);
    expect(resolveChoice({}, big.graph).layout).toBe('groups');
    expect(resolveChoice({ layout: 'tree', links: 'requires', hideImplied: true }, big.graph)).toMatchObject({ layout: 'tree', links: 'requires', hideImplied: true });
  });
});

describe('communities', () => {
  it('finds two tight sets joined by one link', () => {
    const triangle = (a: number, b: number, c: number) => [[a, b, 1], [b, c, 1], [a, c, 1]] as Array<[number, number, number]>;
    const found = communities(6, [...triangle(0, 1, 2), ...triangle(3, 4, 5), [2, 3, 1]]);
    expect(new Set(found.slice(0, 3)).size).toBe(1);
    expect(new Set(found.slice(3)).size).toBe(1);
    expect(found[0]).not.toBe(found[3]);
  });

  it('leaves nodes with no link each on their own', () => {
    expect(new Set(communities(3, [])).size).toBe(3);
  });
});

describe('ideaGroups', () => {
  // Two chains of four with one link between them, and one concept with no link
  const { graph, edges } = mapOf([
    'a1', 'a2: a1', 'a3: a2', 'a4: a2, a3',
    'b1', 'b2: b1', 'b3: b2', 'b4: b2, b3, ~a4',
    'alone',
  ], { a1: 'priority: high\n', b1: 'priority: low\n' });

  it('by topic: sets that are linked among themselves, named after the concept most others require', () => {
    const groups = ideaGroups(graph, edges, 'cluster');
    expect(groups.map((group) => [group.label, [...group.members].sort()])).toEqual([
      ['a2', ['a1', 'a2', 'a3', 'a4']],
      ['b2', ['b1', 'b2', 'b3', 'b4']],
      ['Not linked', ['alone']],
    ]);
  });

  it('by the author\'s topics: as written whatever the case, biggest first, those without one last', () => {
    const map = mapOf(['a1', 'a2: a1', 'b1: a2', 'b2: b1', 'b3: b1', 'loose', 'c: missing'], {
      a1: 'topic: Basics\n', a2: 'topic: basics\n', b1: 'topic: "Risk: the argument"\n', b2: 'topic: "Risk: the argument"\n', b3: 'topic: "Risk: the argument"\n',
    });
    const groups = ideaGroups(map.graph, map.edges, 'topic');
    expect(groups.map((group) => [group.label, [...group.members].sort()])).toEqual([
      ['Risk: the argument', ['b1', 'b2', 'b3']],
      ['Basics', ['a1', 'a2']],
      ['No topic', ['c', 'loose', 'missing']],
    ]);
    expect(groups[2].key).toBe(NO_TOPIC);
    // A topic keeps its colour whatever its place: by name
    expect(topicsOf(map.graph).map((topic) => [topic.label, topic.tone])).toEqual([['Basics', 0], ['Risk: the argument', 1]]);
    expect(groups.map((group) => group.tone)).toEqual([1, 0, undefined]);
  });

  it('by linked part: everything that hangs together is one group', () => {
    expect(ideaGroups(graph, edges, 'component').map((group) => group.members.length)).toEqual([8, 1]);
  });

  it('by priority, and by written or not', () => {
    expect(ideaGroups(graph, edges, 'priority').map((group) => [group.label, group.members.length])).toEqual([['High priority', 1], ['Medium priority', 7], ['Low priority', 1]]);
    expect(ideaGroups(graph, edges, 'state').map((group) => [group.label, group.members.length])).toEqual([['Written', 9]]);
    const withMissing = mapOf(['b: a']);
    expect(ideaGroups(withMissing.graph, withMissing.edges, 'state').map((group) => group.label)).toEqual(['Written', 'Not written yet']);
    expect(ideaGroups(withMissing.graph, withMissing.edges, 'priority').map((group) => group.label)).toEqual(['Medium priority', 'Not written yet']);
  });

  it('a topic too small to stand alone joins the one it is linked to most', () => {
    // A tight set of four, and a pair that hangs on it by one link
    const map = mapOf(['a1', 'a2: a1', 'a3: a1, a2', 'a4: a1, a2, a3', 'p1: a4', 'p2: p1']);
    expect(ideaGroups(map.graph, map.edges, 'cluster').map((group) => group.members.length)).toEqual([6]);
  });

  it.each([40, 150])('puts every one of %i concepts in exactly one group, the same way every time', (count) => {
    const map = fixtureMap(count);
    for (const grouping of MAP_GROUPINGS) {
      const groups = ideaGroups(map.graph, map.edges, grouping.key);
      expect(groups.flatMap((group) => group.members).sort()).toEqual([...map.keys].sort());
      expect(new Set(groups.map((group) => group.key)).size).toBe(groups.length);
      expect(ideaGroups(map.graph, [...map.edges], grouping.key)).toEqual(groups);
    }
    const topics = ideaGroups(map.graph, map.edges, 'cluster');
    const linked = new Set(map.edges.flatMap((edge) => [edge.from, edge.to]));
    expect(topics.find((group) => group.key === 'not-linked')?.members.sort()).toEqual(map.keys.filter((key) => !linked.has(key)).sort());
    // More than one topic, none of them tiny
    expect(topics.length).toBeGreaterThan(3);
    for (const group of topics) if (group.key !== 'not-linked') expect(group.members.length).toBeGreaterThanOrEqual(3);
  });
});

describe('layoutFor', () => {
  it('left to right and top to bottom are the layered drawing', () => {
    const { graph, keys, edges, heightOf } = fixtureMap(40);
    expect(layoutFor(drawnAs('columns'), { graph, edges, heightOf, sizes: SIZES })).toEqual({ ...layoutLayered(keys, edges, heightOf, SIZES), frames: [] });
    expect(layoutFor(drawnAs('rows'), { graph, edges, heightOf, sizes: SIZES })).toEqual({ ...layoutLayered(keys, edges, heightOf, SIZES, 'down'), frames: [] });
    // ELK's layout is made elsewhere, as a promise: until it is there, the page's own
    expect(layoutFor(drawnAs('elk'), { graph, edges, heightOf, sizes: SIZES })).toEqual(layoutFor(drawnAs('columns'), { graph, edges, heightOf, sizes: SIZES }));
  });

  it('has nothing to draw for an empty map, whatever the layout', () => {
    const empty = mapOf([]);
    for (const layout of MAP_LAYOUTS) {
      expect(layoutFor(drawnAs(layout.key), empty)).toEqual({ boxes: [], lines: [], frames: [], width: 0, height: 32 });
    }
  });

  describe('groups', () => {
    const map = mapOf([
      'a1', 'a2: a1', 'a3: a2', 'a4: a2, a3',
      'b1', 'b2: b1', 'b3: b2', 'b4: b2, b3, a4, ~a3',
      'alone',
    ]);
    const drawn = layoutFor(drawnAs('groups', 'cluster'), map);
    const frame = (label: string) => drawn.frames.find((f) => f.label === label)!;

    it('draws a frame around each group, with its name and how many are in it', () => {
      expect(drawn.frames.map((f) => [f.label, f.count])).toEqual([['a2', 4], ['b2', 4], ['Not linked', 1]]);
      for (const box of drawn.boxes) {
        const home = box.key.startsWith('a') && box.key !== 'alone' ? 'a2' : box.key === 'alone' ? 'Not linked' : 'b2';
        expect(drawn.frames.filter((f) => inFrame(f, box)).map((f) => f.label)).toEqual([home]);
      }
      expect(framesApart(drawn.frames)).toBe(true);
    });

    it('puts the group that comes first before the one that builds on it, which says so', () => {
      // Two wide frames: one above the other fits a screen better than side by side
      expect(frame('a2').x).toBe(frame('b2').x);
      expect(frame('a2').y + frame('a2').height).toBeLessThan(frame('b2').y);
      expect(drawn.frames.map((f) => f.note)).toEqual([undefined, 'Builds on: a2', undefined]);
    });

    it('keeps a link from group to group quiet, from box border to box border', () => {
      const quiet = drawn.lines.filter((line) => line.quiet);
      expect(quiet.map((line) => `${line.from}>${line.to}${line.helpful ? ' helpful' : ''}`).sort()).toEqual(['a3>b4 helpful', 'a4>b4']);
      for (const line of quiet) {
        const { start, end } = ends(line.d);
        expect(sideOf(start, drawn.boxes.find((box) => box.key === line.from)!, W)).not.toBeNull();
        expect(sideOf(end, drawn.boxes.find((box) => box.key === line.to)!, W)).not.toBeNull();
      }
      expect(drawn.lines.filter((line) => !line.quiet)).toHaveLength(map.edges.length - 2);
    });

    it('reads in the order the links ask for, not biggest first', () => {
      // The bigger group (b) needs the smaller one (a)
      const later = mapOf(['a1', 'a2: a1', 'a3: a1, a2', 'b1: a3', 'b2: b1', 'b3: b1, b2', 'b4: b1, b2, b3']);
      expect(layoutFor(drawnAs('groups', 'cluster'), later).frames.map((f) => [f.count, f.note])).toEqual([[3, undefined], [4, 'Builds on: a1']]);
    });

    it('two groups that need each other: the one that needs less comes first', () => {
      const both = mapOf(['a1: b3', 'a2: a1', 'a3: a1, a2', 'b1', 'b2: b1, a3', 'b3: b1, b2, a3']);
      expect(layoutFor(drawnAs('groups', 'cluster'), both).frames.map((f) => f.note)).toEqual([undefined, 'Builds on: a1']);
    });

    it('breaks the frames into rows when they are many', () => {
      const { graph, edges, heightOf } = fixtureMap(150);
      const frames = layoutFor(drawnAs('groups', 'cluster'), { graph, edges, heightOf, sizes: SIZES }).frames;
      expect(new Set(frames.map((f) => f.y)).size).toBeGreaterThan(1);
      expect(new Set(frames.map((f) => f.y)).size).toBeLessThan(frames.length);
    });

    it('by priority the groups stay in the order of priority', () => {
      const { graph, edges, heightOf } = fixtureMap(40);
      const frames = layoutFor(drawnAs('groups', 'priority'), { graph, edges, heightOf, sizes: SIZES }).frames;
      expect(frames.map((f) => f.label)).toEqual(['High priority', 'Medium priority', 'Low priority', 'Not written yet']);
      expect(frames.every((f) => f.note === undefined)).toBe(true);
    });
  });

  describe('around one concept', () => {
    // a > b > c > d, with e beside b under a, and x > y apart from them
    const map = mapOf(['a', 'b: a', 'c: b', 'd: c', 'e: a', 'x', 'y: x']);
    const around = (focus: string | null) => layoutFor(drawnAs('focus', 'cluster'), { ...map, focus });
    const outside = (drawn: DrawnMap) => drawn.boxes.filter((box) => drawn.frames.some((f) => inFrame(f, box))).map((box) => box.key).sort();

    it('draws what the concept builds on and what builds on it, and sets the rest aside', () => {
      const drawn = around('b');
      expect(outside(drawn)).toEqual(['e', 'x', 'y']);
      expect(drawn.lines.map((line) => `${line.from}>${line.to}`).sort()).toEqual(['a>b', 'b>c', 'c>d']);
      expect(drawn.frames).toHaveLength(1);
      expect(drawn.frames[0].count).toBe(3);
      expect(drawn.frames[0].label).toBe('Not on the way to or from “b”');
      const x = (key: string) => drawn.boxes.find((box) => box.key === key)!.x;
      expect(x('a')).toBeLessThan(x('b'));
      expect(x('b')).toBeLessThan(x('c'));
    });

    it('is drawn around the concept most others require when none is given or it is gone', () => {
      expect(outside(around(null))).toEqual(['x', 'y']);
      expect(around('gone')).toEqual(around(null));
      expect(around(null).frames[0].label).toContain('“a”');
    });

    it('has no frame when everything is on the way', () => {
      const chain = mapOf(['a', 'b: a', 'c: b']);
      expect(layoutFor(drawnAs('focus', 'cluster'), { ...chain, focus: 'b' }).frames).toEqual([]);
    });
  });

  const maps: Array<[string, number, Parameters<typeof fixtureMap>[1]]> = [
    ['5 concepts', 5, {}],
    ['40 concepts', 40, {}],
    ['150 concepts', 150, {}],
    ['40 concepts with a circle of requirements', 40, { cycle: true }],
    ['20 concepts, half of them not linked', 20, { isolated: 10 }],
  ];
  const choices: MapLayoutChoice[] = [
    ...MAP_LAYOUTS.flatMap((layout) => (
      GROUPED_LAYOUTS.includes(layout.key) ? MAP_GROUPINGS.map((grouping) => drawnAs(layout.key, grouping.key)) : [drawnAs(layout.key)]
    )),
    drawnAs('groups', 'topic', { links: 'requires' }),
    drawnAs('tree', 'topic', { links: 'requires', hideImplied: true }),
  ];
  describe.each(maps)('%s', (_, count, options) => {
    const { graph, keys, edges: all, heightOf } = fixtureMap(count, options);
    it.each(choices)('$layout $groupBy $links: no box on another, no line through a box, frames apart', (choice) => {
      const drawn = layoutFor(choice, { graph, edges: all, heightOf, sizes: SIZES });
      const edges = shownLinks(all, choice);
      expect(drawn.boxes.map((box) => box.key).sort()).toEqual([...keys].sort());
      expect(crowdedBoxes(drawn.boxes, W, SIZES.gapY)).toEqual([]);
      for (const box of drawn.boxes) {
        expect(box.height).toBe(heightOf(box.key));
        expect(box.x).toBeGreaterThanOrEqual(SIZES.margin - 0.01);
        expect(box.y).toBeGreaterThanOrEqual(SIZES.margin - 0.01);
        expect(box.x + W).toBeLessThanOrEqual(drawn.width - SIZES.margin + 0.01);
        expect(box.y + box.height).toBeLessThanOrEqual(drawn.height - SIZES.margin + 0.01);
      }

      // Frames: inside the map, apart from each other, each around its own boxes only
      expect(framesApart(drawn.frames)).toBe(true);
      for (const frame of drawn.frames) {
        expect(frame.x).toBeGreaterThanOrEqual(SIZES.margin - 0.01);
        expect(frame.y).toBeGreaterThanOrEqual(SIZES.margin - 0.01);
        expect(frame.x + frame.width).toBeLessThanOrEqual(drawn.width - SIZES.margin + 0.01);
        expect(frame.y + frame.height).toBeLessThanOrEqual(drawn.height - SIZES.margin + 0.01);
        expect(drawn.boxes.filter((box) => inFrame(frame, box))).toHaveLength(frame.count);
      }
      if (GROUPED_LAYOUTS.includes(choice.layout)) {
        expect(drawn.frames.reduce((sum, frame) => sum + frame.count, 0)).toBe(keys.length);
      }
      // An arrow from group to group: between two frames of the map, for at least one link
      for (const bundle of drawn.bundles ?? []) {
        expect(drawn.frames.map((frame) => frame.key)).toEqual(expect.arrayContaining([bundle.from, bundle.to]));
        expect(bundle.count).toBeGreaterThan(0);
      }

      // Lines: one for every link between two concepts (around one concept: those on the way only)
      const links = drawn.lines;
      if (choice.layout === 'focus') expect(links.length).toBeLessThanOrEqual(edges.length);
      else expect(links.map((line) => `${line.from}>${line.to}>${line.helpful}`).sort()).toEqual(edges.map((edge) => `${edge.from}>${edge.to}>${edge.helpful}`).sort());
      for (const line of drawn.lines) {
        for (const [x, y] of pathPoints(line.d)) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(drawn.width);
          expect(y).toBeLessThanOrEqual(drawn.height);
        }
      }
      // Those always drawn pass behind no box and do not run on top of each other. (The organic drawing
      // moves boxes off its straight lines where there is room, and promises no more than that.)
      const loud = drawn.lines.filter((line) => !line.quiet);
      if (choice.layout === 'grid') expect(loud).toEqual([]);
      if (choice.layout === 'organic') expect(linesThroughBoxes({ boxes: drawn.boxes, lines: loud }, W).length).toBeLessThanOrEqual(loud.length / 10);
      else {
        expect(linesThroughBoxes({ boxes: drawn.boxes, lines: loud }, W)).toEqual([]);
        // The lines of a tree share the stem that leaves their concept
        if (choice.layout !== 'tree') expect(linesOnTop(loud)).toEqual([]);
      }
      for (const line of links) {
        const { start, end } = ends(line.d);
        expect(sideOf(start, drawn.boxes.find((box) => box.key === line.from)!, W)).not.toBeNull();
        expect(sideOf(end, drawn.boxes.find((box) => box.key === line.to)!, W)).not.toBeNull();
      }
    });

    it.each(choices)('$layout $groupBy $links: the same drawing every time', (choice) => {
      expect(layoutFor(choice, { graph, edges: [...all], heightOf, sizes: SIZES })).toEqual(layoutFor(choice, { graph, edges: all, heightOf, sizes: SIZES }));
    });
  });

  describe('tree', () => {
    it('hangs each concept under the one it builds on most directly, once', () => {
      // d requires a (step 1) and c (step 3): it hangs under c; e has only a "helpful first"
      const map = mapOf(['a', 'b: a', 'c: b', 'd: a, c', 'e: ~b', 'alone']);
      const parents = treeParents(map.graph, map.edges);
      expect([...parents].map(([key, parent]) => `${key}<${parent.parent}${parent.helpful ? ' helpful' : ''}`).sort()).toEqual(['b<a', 'c<b', 'd<c', 'e<b helpful']);
      const drawn = layoutFor(drawnAs('tree'), map);
      const x = (key: string) => drawn.boxes.find((box) => box.key === key)!.x;
      expect([x('a'), x('b'), x('c'), x('d')]).toEqual([...[x('a'), x('b'), x('c'), x('d')]].sort((p, q) => p - q));
      expect(new Set([x('a'), x('b'), x('c'), x('d')]).size).toBe(4);
      expect(x('e')).toBe(x('c'));
      // The link that is not part of the tree is there, quiet
      expect(drawn.lines.filter((line) => line.quiet).map((line) => `${line.from}>${line.to}`)).toEqual(['a>d']);
      expect(drawn.lines.filter((line) => !line.quiet)).toHaveLength(4);
    });

    it('of two it requires at the same step, takes the one of its own topic', () => {
      const map = mapOf(['a', 'b', 'c: a, b'], { a: 'topic: One\n', b: 'topic: Two\n', c: 'topic: Two\n' });
      expect(treeParents(map.graph, map.edges).get('c')).toEqual({ parent: 'b', helpful: false });
    });

    it('makes no circle of a circle of requirements', () => {
      const { graph, edges } = fixtureMap(40, { cycle: true });
      const parents = treeParents(graph, edges);
      for (const key of parents.keys()) {
        const seen = new Set<string>();
        for (let at: string | undefined = key; at !== undefined; at = parents.get(at)?.parent) {
          expect(seen.has(at)).toBe(false);
          seen.add(at);
        }
      }
    });
  });

  describe('grid and organic', () => {
    const map = mapOf(['a1', 'a2: a1', 'a3: a2', 'b1: a3', 'b2: b1', 'b3: b1, a1', 'alone'], {
      a1: 'topic: First\n', a2: 'topic: First\n', a3: 'topic: First\n', b1: 'topic: Second\n', b2: 'topic: Second\n', b3: 'topic: Second\n',
    });

    it('grid: a frame per topic in the order to read them, every link quiet', () => {
      const drawn = layoutFor(drawnAs('grid', 'topic'), map);
      expect(drawn.frames.map((frame) => [frame.label, frame.count, frame.tone])).toEqual([['First', 3, 0], ['Second', 3, 1], ['No topic', 1, undefined]]);
      expect(drawn.lines).toHaveLength(map.edges.length);
      expect(drawn.lines.every((line) => line.quiet)).toBe(true);
    });

    it('organic: one arrow for all the links from one group to another, from the one that comes first', () => {
      // Seven links from First to Second
      const tied = mapOf(['a1', 'a2: a1', 'a3: a2', 'b1: a1, a2, a3', 'b2: b1, a1, a2', 'b3: b1, a1, a3'], {
        a1: 'topic: First\n', a2: 'topic: First\n', a3: 'topic: First\n', b1: 'topic: Second\n', b2: 'topic: Second\n', b3: 'topic: Second\n',
      });
      const drawn = layoutFor(drawnAs('organic', 'topic'), tied);
      expect(drawn.bundles).toEqual([expect.objectContaining({ from: 'topic:first', to: 'topic:second', count: 7 })]);
      expect(drawn.lines.filter((line) => line.quiet)).toHaveLength(7);
      expect(framesApart(drawn.frames)).toBe(true);
    });

    it('organic: a group with no link to another has no arrow', () => {
      expect(layoutFor(drawnAs('organic', 'topic'), mapOf(['a', 'b'], { a: 'topic: One\n', b: 'topic: Two\n' })).bundles).toEqual([]);
    });
  });

  describe('the links that are drawn', () => {
    const map = mapOf(['a', 'b: a', 'c: b, a, ~a']);
    const lines = (more: Partial<MapLayoutChoice>) => layoutFor(drawnAs('columns', 'cluster', more), map).lines.map((line) => `${line.from}>${line.to}${line.helpful ? ' helpful' : ''}`).sort();

    it('all of them, or Requires only, or without those a chain says already', () => {
      expect(lines({})).toEqual(['a>b', 'a>c', 'b>c']);
      const both = mapOf(['a', 'b: a', 'c: b, a', 'd: ~a']);
      const of = (more: Partial<MapLayoutChoice>) => layoutFor(drawnAs('columns', 'cluster', more), both).lines.map((line) => `${line.from}>${line.to}${line.helpful ? ' helpful' : ''}`).sort();
      expect(of({})).toEqual(['a>b', 'a>c', 'a>d helpful', 'b>c']);
      expect(of({ links: 'requires' })).toEqual(['a>b', 'a>c', 'b>c']);
      expect(of({ hideImplied: true })).toEqual(['a>b', 'a>d helpful', 'b>c']);
      expect(of({ links: 'requires', hideImplied: true })).toEqual(['a>b', 'b>c']);
    });
  });

  it('draws 150 concepts in any layout fast enough to do it again whenever a box changes height', () => {
    const { graph, edges, heightOf } = fixtureMap(150);
    for (const choice of choices) {
      layoutFor(choice, { graph, edges, heightOf, sizes: SIZES });
      const start = performance.now();
      layoutFor(choice, { graph, edges, heightOf, sizes: SIZES });
      expect(performance.now() - start).toBeLessThan(1500);
    }
  });
});
