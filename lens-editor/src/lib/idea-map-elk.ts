/**
 * The concept map laid out by ELK (Eclipse Layout Kernel, the `elkjs`
 * package): its "layered" algorithm, the kind of layout yEd calls
 * hierarchical. Columns from left to right like the page's own layered
 * drawing, but ELK orders the boxes of a column better: on the 183 concepts
 * it was tuned on it draws the same links with about half the crossings.
 *
 * ELK is big (1.5 MB) and takes up to a second on a big map, so it is not
 * part of the page: `loadElk` (lib/idea-map-elk-load, the one file that
 * imports the package) fetches it when this layout is first chosen, and the
 * layout is made off the drawing (a promise). `elkGraph` and `fromElk` are
 * pure.
 */
import type { ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { MapEdge, MapLayout, MapSizes } from './idea-map-layout';
import { cornered } from './idea-map-layered';

/** What does the layout: an ELK, or anything that answers like one. */
export interface ElkLike {
  layout(graph: ElkNode): Promise<ElkNode>;
}

/** With more links than this, the quicker way to place the boxes of a column. */
const MANY_LINKS = 220;

const OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '7',
  'elk.layered.spacing.edgeNodeBetweenLayers': '14',
  'elk.spacing.edgeEdge': '7',
  'elk.spacing.edgeNode': '10',
};

/** The map as ELK reads it. Links from a concept to itself, and to concepts that are not on the map, are left out. */
export function elkGraph(keys: readonly string[], edges: readonly MapEdge[], heightOf: (key: string) => number, sizes: MapSizes): ElkNode {
  const known = new Set(keys);
  const links = edges.flatMap((edge, i) => (edge.from !== edge.to && known.has(edge.from) && known.has(edge.to) ? [{ id: `link-${i}`, sources: [edge.from], targets: [edge.to] }] : []));
  return {
    id: 'map',
    layoutOptions: {
      ...OPTIONS,
      // Where the boxes of a column stand: the most compact way (network simplex) takes 0.2 s for 190 links
      // but 0.8 s and more for 320, so a map with many links gets the quicker one (a third taller)
      'elk.layered.nodePlacement.strategy': links.length > MANY_LINKS ? 'LINEAR_SEGMENTS' : 'NETWORK_SIMPLEX',
      'elk.layered.spacing.nodeNodeBetweenLayers': String(sizes.gapX + 20), 'elk.spacing.nodeNode': String(sizes.gapY),
    },
    children: keys.map((key) => ({ id: key, width: sizes.nodeWidth, height: heightOf(key) })),
    edges: links,
  };
}

/** What ELK answered, as a drawing: boxes where it put them, each link a square line through its bend points. */
export function fromElk(laid: ElkNode, edges: readonly MapEdge[], sizes: MapSizes): MapLayout {
  const { margin } = sizes;
  const route = new Map((laid.edges ?? []).map((edge) => [edge.id, edge.sections?.[0]]));
  return {
    boxes: (laid.children ?? []).map((box) => ({ key: box.id, column: 0, x: (box.x ?? 0) + margin, y: (box.y ?? 0) + margin, height: box.height ?? 0 })),
    lines: edges.flatMap((edge, i) => {
      const section = route.get(`link-${i}`);
      if (!section) return [];
      const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]
        .map((point) => [point.x + margin, point.y + margin] as const)
        // A bend on the spot of the one before is no bend
        .filter((point, at, all) => at === 0 || point[0] !== all[at - 1][0] || point[1] !== all[at - 1][1]);
      return [{ ...edge, d: cornered(points) }];
    }),
    width: (laid.width ?? 0) + 2 * margin,
    height: (laid.height ?? 0) + 2 * margin,
  };
}

/** The map laid out by `elk`. */
export async function layoutElk(elk: ElkLike, keys: readonly string[], edges: readonly MapEdge[], heightOf: (key: string) => number, sizes: MapSizes): Promise<MapLayout> {
  if (keys.length === 0) return { boxes: [], lines: [], width: 0, height: 2 * sizes.margin };
  return fromElk(await elk.layout(elkGraph(keys, edges, heightOf, sizes)), edges, sizes);
}
