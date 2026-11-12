import { describe, expect, it } from 'vitest';
import { buildIdeaGraph, type IdeaFile } from './idea-map';
import type { MapEdge, MapSizes } from './idea-map-layout';
import { layoutLayered } from './idea-map-layered';
import { DEFAULT_CHOICE, MAP_GROUPINGS, MAP_LAYOUTS, communities, ideaGroups, layoutFor, parseChoice, type DrawnMap, type MapFrame, type MapLayoutChoice } from './idea-map-layouts';
import { crowdedBoxes, fixtureMap, linesOnTop, linesThroughBoxes, pathPoints, sideOf } from './idea-map-layouts.fixture';

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
    expect(parseChoice(JSON.stringify({ layout: 'groups', groupBy: 'priority' }))).toEqual({ layout: 'groups', groupBy: 'priority' });
  });

  it.each([null, '', 'groups', '{"layout":"spiral","groupBy":7}', '[]', 'null'])('falls back to left to right for %j', (raw) => {
    expect(parseChoice(raw)).toEqual(DEFAULT_CHOICE);
  });

  it('keeps the half it knows', () => {
    expect(parseChoice('{"layout":"rows","groupBy":"colour"}')).toEqual({ layout: 'rows', groupBy: 'cluster' });
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
    expect(layoutFor({ layout: 'columns', groupBy: 'cluster' }, { graph, edges, heightOf, sizes: SIZES })).toEqual({ ...layoutLayered(keys, edges, heightOf, SIZES), frames: [] });
    expect(layoutFor({ layout: 'rows', groupBy: 'cluster' }, { graph, edges, heightOf, sizes: SIZES })).toEqual({ ...layoutLayered(keys, edges, heightOf, SIZES, 'down'), frames: [] });
  });

  it('has nothing to draw for an empty map, whatever the layout', () => {
    const empty = mapOf([]);
    for (const layout of MAP_LAYOUTS) {
      expect(layoutFor({ layout: layout.key, groupBy: 'cluster' }, empty)).toEqual({ boxes: [], lines: [], frames: [], width: 0, height: 32 });
    }
  });

  describe('groups', () => {
    const map = mapOf([
      'a1', 'a2: a1', 'a3: a2', 'a4: a2, a3',
      'b1', 'b2: b1', 'b3: b2', 'b4: b2, b3, a4, ~a3',
      'alone',
    ]);
    const drawn = layoutFor({ layout: 'groups', groupBy: 'cluster' }, map);
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
      expect(layoutFor({ layout: 'groups', groupBy: 'cluster' }, later).frames.map((f) => [f.count, f.note])).toEqual([[3, undefined], [4, 'Builds on: a1']]);
    });

    it('two groups that need each other: the one that needs less comes first', () => {
      const both = mapOf(['a1: b3', 'a2: a1', 'a3: a1, a2', 'b1', 'b2: b1, a3', 'b3: b1, b2, a3']);
      expect(layoutFor({ layout: 'groups', groupBy: 'cluster' }, both).frames.map((f) => f.note)).toEqual([undefined, 'Builds on: a1']);
    });

    it('breaks the frames into rows when they are many', () => {
      const { graph, edges, heightOf } = fixtureMap(150);
      const frames = layoutFor({ layout: 'groups', groupBy: 'cluster' }, { graph, edges, heightOf, sizes: SIZES }).frames;
      expect(new Set(frames.map((f) => f.y)).size).toBeGreaterThan(1);
      expect(new Set(frames.map((f) => f.y)).size).toBeLessThan(frames.length);
    });

    it('by priority the groups stay in the order of priority', () => {
      const { graph, edges, heightOf } = fixtureMap(40);
      const frames = layoutFor({ layout: 'groups', groupBy: 'priority' }, { graph, edges, heightOf, sizes: SIZES }).frames;
      expect(frames.map((f) => f.label)).toEqual(['High priority', 'Medium priority', 'Low priority', 'Not written yet']);
      expect(frames.every((f) => f.note === undefined)).toBe(true);
    });
  });

  describe('around one concept', () => {
    // a > b > c > d, with e beside b under a, and x > y apart from them
    const map = mapOf(['a', 'b: a', 'c: b', 'd: c', 'e: a', 'x', 'y: x']);
    const around = (focus: string | null) => layoutFor({ layout: 'focus', groupBy: 'cluster' }, { ...map, focus });
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
      expect(layoutFor({ layout: 'focus', groupBy: 'cluster' }, { ...chain, focus: 'b' }).frames).toEqual([]);
    });
  });

  const maps: Array<[string, number, Parameters<typeof fixtureMap>[1]]> = [
    ['5 concepts', 5, {}],
    ['40 concepts', 40, {}],
    ['150 concepts', 150, {}],
    ['40 concepts with a circle of requirements', 40, { cycle: true }],
    ['20 concepts, half of them not linked', 20, { isolated: 10 }],
  ];
  const choices: MapLayoutChoice[] = MAP_LAYOUTS.flatMap((layout) => (
    layout.key === 'groups' ? MAP_GROUPINGS.map((grouping) => ({ layout: layout.key, groupBy: grouping.key })) : [{ layout: layout.key, groupBy: DEFAULT_CHOICE.groupBy }]
  ));
  describe.each(maps)('%s', (_, count, options) => {
    const { graph, keys, edges, heightOf } = fixtureMap(count, options);
    it.each(choices)('$layout $groupBy: no box on another, no line through a box, frames apart', (choice) => {
      const drawn = layoutFor(choice, { graph, edges, heightOf, sizes: SIZES });
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
      if (choice.layout === 'groups') {
        expect(drawn.frames.reduce((sum, frame) => sum + frame.count, 0)).toBe(keys.length);
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
      // Those always drawn pass behind no box and do not run on top of each other
      const loud = drawn.lines.filter((line) => !line.quiet);
      expect(linesThroughBoxes({ boxes: drawn.boxes, lines: loud }, W)).toEqual([]);
      expect(linesOnTop(loud)).toEqual([]);
      for (const line of links) {
        const { start, end } = ends(line.d);
        expect(sideOf(start, drawn.boxes.find((box) => box.key === line.from)!, W)).not.toBeNull();
        expect(sideOf(end, drawn.boxes.find((box) => box.key === line.to)!, W)).not.toBeNull();
      }
    });

    it.each(choices)('$layout $groupBy: the same drawing every time', (choice) => {
      expect(layoutFor(choice, { graph, edges: [...edges], heightOf, sizes: SIZES })).toEqual(layoutFor(choice, { graph, edges, heightOf, sizes: SIZES }));
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
