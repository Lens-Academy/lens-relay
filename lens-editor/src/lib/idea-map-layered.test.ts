import { describe, expect, it } from 'vitest';
import type { MapEdge, MapSizes } from './idea-map-layout';
import { layoutLayered, type MapFlow } from './idea-map-layered';
import { crowdedBoxes, fixtureMap, linesOnTop, linesThroughBoxes, pathPoints, sideOf } from './idea-map-layouts.fixture';

const SIZES: MapSizes = { nodeWidth: 176, gapX: 40, gapY: 12, margin: 16 };
const W = SIZES.nodeWidth;

const requires = (from: string, to: string): MapEdge => ({ from, to, helpful: false });
const boxOf = (layout: ReturnType<typeof layoutLayered>, key: string) => layout.boxes.find((box) => box.key === key)!;
const lineOf = (layout: ReturnType<typeof layoutLayered>, from: string, to: string) => layout.lines.find((line) => line.from === from && line.to === to)!;
const ends = (d: string) => {
  const points = pathPoints(d);
  return { start: points[0], end: points[points.length - 1] };
};

describe('layoutLayered', () => {
  it('puts what comes first on the left and joins neighbours with a straight line', () => {
    const layout = layoutLayered(['c', 'a', 'b'], [requires('a', 'b'), requires('b', 'c')], () => 30, SIZES);
    const [a, b, c] = ['a', 'b', 'c'].map((key) => boxOf(layout, key));
    expect(a.x).toBe(SIZES.margin);
    expect(b.x).toBe(a.x + W + SIZES.gapX);
    expect(c.x).toBe(b.x + W + SIZES.gapX);
    expect([a.y, b.y, c.y]).toEqual([16, 16, 16]);
    expect(lineOf(layout, 'a', 'b').d).toBe(`M${a.x + W},31 L${b.x},31`);
    expect(layout.width).toBe(c.x + W + SIZES.margin);
    expect(layout.height).toBe(30 + 2 * SIZES.margin);
  });

  it('runs top to bottom when asked: what comes first is above', () => {
    const layout = layoutLayered(['a', 'b'], [requires('a', 'b')], (key) => (key === 'a' ? 30 : 58), SIZES, 'down');
    const [a, b] = ['a', 'b'].map((key) => boxOf(layout, key));
    expect(a.x).toBe(b.x);
    expect(b.y).toBe(a.y + 30 + SIZES.gapX);
    const { start, end } = ends(lineOf(layout, 'a', 'b').d);
    expect(sideOf(start, a, W)).toBe('bottom');
    expect(sideOf(end, b, W)).toBe('top');
  });

  it('takes a line that skips a column past the boxes of that column, not through them', () => {
    // a > b1..b3 > c, and a > c directly: the direct line has to pass the b column
    const edges = [...['b1', 'b2', 'b3'].flatMap((b) => [requires('a', b), requires(b, 'c')]), requires('a', 'c')];
    const layout = layoutLayered(['a', 'b1', 'b2', 'b3', 'c'], edges, () => 44, SIZES);
    expect(linesThroughBoxes(layout, W)).toEqual([]);
    const passing = pathPoints(lineOf(layout, 'a', 'c').d);
    const column = boxOf(layout, 'b1').x;
    // Level all the way across the column
    const inColumn = passing.filter(([x]) => x >= column && x <= column + W).map(([, y]) => y);
    expect(new Set(inColumn).size).toBeLessThanOrEqual(1);
  });

  it('spreads the line ends along a side of a box, in the order of where the lines go', () => {
    const targets = ['t1', 't2', 't3', 't4', 't5'];
    const layout = layoutLayered(['hub', ...targets], targets.map((to) => requires('hub', to)), (key) => (key === 'hub' ? 72 : 30), SIZES);
    const hub = boxOf(layout, 'hub');
    const leaving = targets
      .map((to) => ({ to, y: ends(lineOf(layout, 'hub', to).d).start[1], targetY: boxOf(layout, to).y }))
      .sort((p, q) => p.targetY - q.targetY);
    leaving.slice(1).forEach((end, i) => expect(end.y - leaving[i].y).toBeGreaterThanOrEqual(5));
    for (const end of leaving) {
      expect(end.y).toBeGreaterThan(hub.y);
      expect(end.y).toBeLessThan(hub.y + hub.height);
    }
    expect(linesOnTop(layout.lines)).toEqual([]);
  });

  it('draws a circle of requirements: the line that goes back leaves and arrives on the far sides', () => {
    const layout = layoutLayered(['a', 'b', 'c'], [requires('a', 'b'), requires('b', 'c'), requires('c', 'a')], () => 30, SIZES);
    expect(layout.lines).toHaveLength(3);
    expect(crowdedBoxes(layout.boxes, W, SIZES.gapY)).toEqual([]);
    const back = layout.lines.filter((line) => boxOf(layout, line.to).x < boxOf(layout, line.from).x);
    expect(back).toHaveLength(1);
    const { start, end } = ends(back[0].d);
    expect(sideOf(start, boxOf(layout, back[0].from), W)).toBe('left');
    expect(sideOf(end, boxOf(layout, back[0].to), W)).toBe('right');
    expect(linesThroughBoxes(layout, W)).toEqual([]);
  });

  it('draws an idea that requires itself as a small loop on its side', () => {
    const layout = layoutLayered(['a', 'b'], [requires('a', 'a'), requires('a', 'b')], () => 40, SIZES);
    const a = boxOf(layout, 'a');
    const { start, end } = ends(lineOf(layout, 'a', 'a').d);
    expect(sideOf(start, a, W)).toBe('right');
    expect(sideOf(end, a, W)).toBe('right');
  });

  it('keeps ideas without a link in a block below, and leaves out links to ideas that are not on the map', () => {
    const layout = layoutLayered(['a', 'b', 'alone', 'too'], [requires('a', 'b'), requires('gone', 'b'), requires('a', 'gone')], () => 30, SIZES);
    expect(layout.lines.map((line) => `${line.from}>${line.to}`)).toEqual(['a>b']);
    expect(boxOf(layout, 'alone').y).toBeGreaterThan(boxOf(layout, 'a').y + 30);
    expect(boxOf(layout, 'too').y).toBe(boxOf(layout, 'alone').y);
    expect(crowdedBoxes(layout.boxes, W, SIZES.gapY)).toEqual([]);
  });

  it('lays out parts that are not linked to each other one by one', () => {
    const layout = layoutLayered(['a', 'b', 'c', 'x', 'y'], [requires('a', 'b'), requires('b', 'c'), requires('x', 'y')], () => 30, SIZES);
    expect(crowdedBoxes(layout.boxes, W, SIZES.gapY)).toEqual([]);
    expect(boxOf(layout, 'y').x - boxOf(layout, 'x').x).toBe(W + SIZES.gapX);
  });

  it('has nothing to draw for an empty map', () => {
    expect(layoutLayered([], [], () => 30, SIZES)).toEqual({ boxes: [], lines: [], width: 0, height: 32 });
  });

  const maps: Array<[string, number, Parameters<typeof fixtureMap>[1]]> = [
    ['5 concepts', 5, {}],
    ['40 concepts', 40, {}],
    ['150 concepts', 150, {}],
    ['40 concepts with a circle of requirements', 40, { cycle: true }],
    ['20 concepts, half of them not linked', 20, { isolated: 10 }],
  ];
  const flows: MapFlow[] = ['right', 'down'];
  describe.each(maps)('%s', (_, count, options) => {
    const { keys, edges, heightOf } = fixtureMap(count, options);
    it.each(flows)('flow %s: no box on another, every line from border to border and through no box', (flow) => {
      const layout = layoutLayered(keys, edges, heightOf, SIZES, flow);
      expect(layout.boxes.map((box) => box.key).sort()).toEqual([...keys].sort());
      expect(crowdedBoxes(layout.boxes, W, SIZES.gapY)).toEqual([]);
      for (const box of layout.boxes) {
        expect(box.height).toBe(heightOf(box.key));
        expect(box.x).toBeGreaterThanOrEqual(SIZES.margin - 0.01);
        expect(box.y).toBeGreaterThanOrEqual(SIZES.margin - 0.01);
        expect(box.x + W).toBeLessThanOrEqual(layout.width - SIZES.margin + 0.01);
        expect(box.y + box.height).toBeLessThanOrEqual(layout.height - SIZES.margin + 0.01);
      }

      expect(layout.lines).toHaveLength(edges.length);
      const [out, into] = flow === 'right' ? ['right', 'left'] : ['bottom', 'top'];
      for (const line of layout.lines) {
        const from = boxOf(layout, line.from);
        const to = boxOf(layout, line.to);
        const { start, end } = ends(line.d);
        const forward = flow === 'right' ? to.x > from.x : to.y > from.y;
        // The side that faces the other box; a line that goes back (a circle) the other way round
        expect(sideOf(start, from, W)).toBe(forward ? out : into);
        expect(sideOf(end, to, W)).toBe(forward ? into : out);
        for (const [x, y] of pathPoints(line.d)) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(layout.width);
          expect(y).toBeLessThanOrEqual(layout.height);
        }
      }
      expect(linesThroughBoxes(layout, W)).toEqual([]);
      expect(linesOnTop(layout.lines)).toEqual([]);
    });

    it('is the same drawing every time', () => {
      expect(layoutLayered(keys, edges, heightOf, SIZES)).toEqual(layoutLayered([...keys], [...edges], heightOf, SIZES));
    });
  });

  it('lays out 150 concepts fast enough to do it again whenever a box changes height', () => {
    const { keys, edges, heightOf } = fixtureMap(150);
    layoutLayered(keys, edges, heightOf, SIZES);
    const start = performance.now();
    layoutLayered(keys, edges, heightOf, SIZES);
    expect(performance.now() - start).toBeLessThan(1500);
  });
});
