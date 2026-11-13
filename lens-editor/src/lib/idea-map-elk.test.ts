import { describe, expect, it } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk.bundled.js';
import { elkGraph, fromElk, layoutElk, type ElkLike } from './idea-map-elk';
import type { MapEdge, MapSizes } from './idea-map-layout';
import { crowdedBoxes, fixtureMap, linesThroughBoxes, pathPoints } from './idea-map-layouts.fixture';

const SIZES: MapSizes = { nodeWidth: 176, gapX: 40, gapY: 12, margin: 16 };
const edges: MapEdge[] = [
  { from: 'a', to: 'b', helpful: false },
  { from: 'a', to: 'a', helpful: false },
  { from: 'a', to: 'gone', helpful: true },
  { from: 'b', to: 'c', helpful: true },
];

describe('elkGraph', () => {
  it('gives ELK every box with its size, and the links between boxes of the map', () => {
    const graph = elkGraph(['a', 'b', 'c'], edges, (key) => (key === 'b' ? 50 : 36), SIZES);
    expect(graph.children).toEqual([{ id: 'a', width: 176, height: 36 }, { id: 'b', width: 176, height: 50 }, { id: 'c', width: 176, height: 36 }]);
    expect(graph.edges).toEqual([{ id: 'link-0', sources: ['a'], targets: ['b'] }, { id: 'link-3', sources: ['b'], targets: ['c'] }]);
    expect(graph.layoutOptions).toMatchObject({ 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.edgeRouting': 'ORTHOGONAL', 'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX' });
  });

  it('places the boxes the quicker way when the links are many', () => {
    const many: MapEdge[] = Array.from({ length: 230 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}`, helpful: false }));
    const keys = Array.from({ length: 231 }, (_, i) => `n${i}`);
    expect(elkGraph(keys, many, () => 36, SIZES).layoutOptions!['elk.layered.nodePlacement.strategy']).toBe('LINEAR_SEGMENTS');
  });
});

describe('fromElk', () => {
  const laid: ElkNode = {
    id: 'map', width: 500, height: 120,
    children: [{ id: 'a', x: 0, y: 10, width: 176, height: 36 }, { id: 'b', x: 250, y: 60, width: 176, height: 50 }],
    edges: [{ id: 'link-0', sources: ['a'], targets: ['b'], sections: [{ startPoint: { x: 176, y: 28 }, bendPoints: [{ x: 210, y: 28 }, { x: 210, y: 28 }, { x: 210, y: 85 }], endPoint: { x: 250, y: 85 } }] }],
  };

  it('puts the boxes where ELK did, inside the margin, and draws each link through its bends', () => {
    const drawn = fromElk(laid, edges, SIZES);
    expect(drawn.boxes).toEqual([{ key: 'a', column: 0, x: 16, y: 26, height: 36 }, { key: 'b', column: 0, x: 266, y: 76, height: 50 }]);
    expect({ width: drawn.width, height: drawn.height }).toEqual({ width: 532, height: 152 });
    // Only the link ELK routed; a bend given twice is one bend (no NaN from a stretch of no length)
    expect(drawn.lines).toHaveLength(1);
    expect(drawn.lines[0]).toMatchObject({ from: 'a', to: 'b', helpful: false });
    expect(drawn.lines[0].d).not.toContain('NaN');
    const points = pathPoints(drawn.lines[0].d);
    expect(points[0]).toEqual([192, 44]);
    expect(points[points.length - 1]).toEqual([266, 101]);
  });
});

describe('layoutElk', () => {
  /** Answers like ELK would for boxes in one column, with straight links: enough to check what is asked and what is made of the answer. */
  const column: ElkLike = {
    layout: async (graph) => {
      let y = 0;
      const children = (graph.children ?? []).map((box) => {
        const placed = { ...box, x: 0, y };
        y += (box.height ?? 0) + 12;
        return placed;
      });
      return { ...graph, children, width: 176, height: y - 12, edges: (graph.edges ?? []).map((edge) => ({ ...edge, sections: [{ startPoint: { x: 176, y: 5 }, endPoint: { x: 200, y: 5 } }] })) };
    },
  };

  it('has nothing to draw for an empty map and asks ELK nothing', async () => {
    const never: ElkLike = { layout: () => Promise.reject(new Error('asked')) };
    expect(await layoutElk(never, [], [], () => 36, SIZES)).toEqual({ boxes: [], lines: [], width: 0, height: 32 });
  });

  it('draws every concept once, none on another, the same way every time', async () => {
    const { keys, edges: all, heightOf } = fixtureMap(40);
    const drawn = await layoutElk(column, keys, all, heightOf, SIZES);
    expect(drawn.boxes.map((box) => box.key).sort()).toEqual([...keys].sort());
    expect(crowdedBoxes(drawn.boxes, 176, SIZES.gapY)).toEqual([]);
    expect(drawn.lines).toHaveLength(all.filter((edge) => edge.from !== edge.to).length);
    expect(await layoutElk(column, keys, [...all], heightOf, SIZES)).toEqual(drawn);
  });
});

// ELK itself is a package (`elkjs`) that may not be installed where the tests run: with it, the real layout is checked too
const packageName = 'elkjs/lib/elk.bundled.js';
const elkjs: (new () => ElkLike) | null = await import(/* @vite-ignore */ packageName).then((found) => found.default, () => null);

describe.skipIf(!elkjs)('ELK itself', () => {
  it.each([40, 150])('lays out %i concepts with no box on another and no line through a box, the same way every time', async (count) => {
    const { keys, edges: all, heightOf } = fixtureMap(count);
    const drawn = await layoutElk(new elkjs!(), keys, all, heightOf, SIZES);
    expect(drawn.boxes.map((box) => box.key).sort()).toEqual([...keys].sort());
    expect(crowdedBoxes(drawn.boxes, 176, SIZES.gapY - 0.01)).toEqual([]);
    expect(linesThroughBoxes(drawn, 176)).toEqual([]);
    expect(await layoutElk(new elkjs!(), keys, all, heightOf, SIZES)).toEqual(drawn);
  });
});
