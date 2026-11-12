/**
 * The ways the concept map can be drawn, and `layoutFor`, which draws it the
 * chosen way. Pure: same map, heights and choice, same drawing.
 *
 *  - columns: layered, left to right (lib/idea-map-layered). The default.
 *  - rows: the same, top to bottom.
 *  - groups: the concepts in groups, each group a small left-to-right map in
 *    a frame of its own; links from group to group stay quiet.
 *  - focus: one concept, everything it builds on to its left and everything
 *    that builds on it to its right; the rest set aside.
 *
 * Left out on purpose, because boxes that hold a whole sentence do not suit
 * them: a force-directed ("organic") drawing (tried: 128 concepts took four
 * times the area, and half of the straight lines passed behind boxes) and
 * rings around one concept by distance (the third ring of that map holds 36
 * boxes, which side by side need a ring 2 000 px across).
 */
import { PRIORITIES, type IdeaGraph, type IdeaNode } from './idea-map';
import type { MapBox, MapEdge, MapLayout, MapLine, MapSizes } from './idea-map-layout';
import { boxGrid, joinParts, layeredBlock, layoutLayered, linkedParts, packRows, withMargin } from './idea-map-layered';

export const MAP_LAYOUTS = [
  { key: 'columns', label: 'Left to right', hint: 'What comes first on the left, in columns' },
  { key: 'rows', label: 'Top to bottom', hint: 'What comes first at the top, in rows' },
  { key: 'groups', label: 'Groups', hint: 'Concepts that belong together in a frame of their own' },
  { key: 'focus', label: 'Around one concept', hint: 'The selected concept, what it builds on and what builds on it' },
] as const;
export type MapLayoutKind = (typeof MAP_LAYOUTS)[number]['key'];

export const MAP_GROUPINGS = [
  { key: 'cluster', label: 'Topic (from the links)' },
  { key: 'component', label: 'Linked part' },
  { key: 'priority', label: 'Priority' },
  { key: 'state', label: 'Written or not' },
] as const;
export type GroupBy = (typeof MAP_GROUPINGS)[number]['key'];

export interface MapLayoutChoice {
  layout: MapLayoutKind;
  /** Used by the groups layout only. */
  groupBy: GroupBy;
}
export const DEFAULT_CHOICE: MapLayoutChoice = { layout: 'columns', groupBy: 'cluster' };

/** The choice as it was stored (JSON), or the default for anything else. */
export function parseChoice(raw: string | null): MapLayoutChoice {
  try {
    const stored = JSON.parse(raw ?? 'null') as Partial<MapLayoutChoice> | null;
    return {
      layout: MAP_LAYOUTS.find((layout) => layout.key === stored?.layout)?.key ?? DEFAULT_CHOICE.layout,
      groupBy: MAP_GROUPINGS.find((grouping) => grouping.key === stored?.groupBy)?.key ?? DEFAULT_CHOICE.groupBy,
    };
  } catch {
    return DEFAULT_CHOICE;
  }
}

/** A labelled outline behind some of the boxes. */
export interface MapFrame {
  key: string;
  label: string;
  /** How many concepts are in it. */
  count: number;
  /** A second line under the label. */
  note?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DrawnLine extends MapLine {
  /** From a concept to one in another frame: drawn only while one of its ends is pointed at or selected. */
  quiet?: boolean;
}

export interface DrawnMap extends MapLayout {
  lines: DrawnLine[];
  frames: MapFrame[];
}

/** Inside a frame, around its boxes. */
export const FRAME_PAD = 14;
/** At the top of a frame: room for its label and a note under it. */
export const FRAME_HEAD = 56;

const byName = (p: IdeaNode, q: IdeaNode) => p.name.localeCompare(q.name);
/** The concept most others require (the first by name among equals). */
function mostRequired(nodes: readonly IdeaNode[]): IdeaNode | undefined {
  return [...nodes].sort((p, q) => q.neededFor.length - p.neededFor.length || q.helpfulFor.length - p.helpfulFor.length || byName(p, q))[0];
}

/**
 * Which node belongs to which community, from the links alone (Louvain):
 * every node starts alone and moves to the neighbouring community that
 * raises modularity most, until none moves; the communities found are then
 * nodes of a smaller graph, and so on. Nodes are gone through in the order
 * given, so the result is the same every time.
 */
export function communities(count: number, links: ReadonlyArray<readonly [number, number, number]>): number[] {
  let member = Array.from({ length: count }, (_, i) => i);
  let size = count;
  let current: Array<readonly [number, number, number]> = links.filter(([a, b]) => a !== b);
  for (;;) {
    const beside: Array<Map<number, number>> = Array.from({ length: size }, () => new Map());
    const degree: number[] = new Array<number>(size).fill(0);
    let total = 0;
    for (const [a, b, weight] of current) {
      total += weight;
      degree[a] += weight;
      degree[b] += weight;
      if (a === b) continue;
      beside[a].set(b, (beside[a].get(b) ?? 0) + weight);
      beside[b].set(a, (beside[b].get(a) ?? 0) + weight);
    }
    if (total === 0) break;
    const community = Array.from({ length: size }, (_, i) => i);
    const communityDegree = [...degree];
    let moved = false;
    for (let pass = 0; pass < 20; pass++) {
      let changed = false;
      for (let node = 0; node < size; node++) {
        const own = community[node];
        const linksTo = new Map<number, number>();
        for (const [other, weight] of beside[node]) linksTo.set(community[other], (linksTo.get(community[other]) ?? 0) + weight);
        communityDegree[own] -= degree[node];
        const gain = (to: number) => (linksTo.get(to) ?? 0) - (communityDegree[to] * degree[node]) / (2 * total);
        let best = own;
        for (const to of linksTo.keys()) {
          if (gain(to) > gain(best) + 1e-9) best = to;
        }
        communityDegree[best] += degree[node];
        if (best !== own) {
          community[node] = best;
          changed = true;
          moved = true;
        }
      }
      if (!changed) break;
    }
    if (!moved) break;
    const renamed = new Map<number, number>();
    for (const c of community) if (!renamed.has(c)) renamed.set(c, renamed.size);
    member = member.map((node) => renamed.get(community[node])!);
    const merged = new Map<string, [number, number, number]>();
    for (const [a, b, weight] of current) {
      const [lo, hi] = [renamed.get(community[a])!, renamed.get(community[b])!].sort((p, q) => p - q);
      const link = merged.get(`${lo} ${hi}`) ?? [lo, hi, 0];
      link[2] += weight;
      merged.set(`${lo} ${hi}`, link);
    }
    current = [...merged.values()];
    size = renamed.size;
  }
  return member;
}

export interface IdeaGroup {
  key: string;
  label: string;
  members: string[];
}

/** The linked concepts in topics found from the links; a topic smaller than `least` joins the one it is linked to most. */
function clusters(nodes: readonly IdeaNode[], edges: readonly MapEdge[]): string[][] {
  const index = new Map(nodes.map((node, i) => [node.key, i]));
  const links = edges.flatMap((edge) => (index.has(edge.from) && index.has(edge.to) ? [[index.get(edge.from)!, index.get(edge.to)!, edge.helpful ? 0.5 : 1] as const] : []));
  const of = communities(nodes.length, links);
  const least = Math.max(3, Math.round(nodes.length / 25));
  for (;;) {
    const sizes = new Map<number, number>();
    for (const c of of) sizes.set(c, (sizes.get(c) ?? 0) + 1);
    // The smallest one that is too small and has a neighbour
    const small = [...sizes].filter(([, n]) => n < least).sort((p, q) => p[1] - q[1] || p[0] - q[0]);
    let joined = false;
    for (const [c] of small) {
      const pull = new Map<number, number>();
      for (const [a, b, weight] of links) {
        if ((of[a] === c) === (of[b] === c)) continue;
        const other = of[a] === c ? of[b] : of[a];
        pull.set(other, (pull.get(other) ?? 0) + weight);
      }
      const to = [...pull].sort((p, q) => q[1] - p[1] || sizes.get(q[0])! - sizes.get(p[0])! || p[0] - q[0])[0];
      if (!to) continue;
      of.forEach((own, i) => { if (own === c) of[i] = to[0]; });
      joined = true;
      break;
    }
    if (!joined) break;
  }
  const groups = new Map<number, string[]>();
  nodes.forEach((node, i) => groups.set(of[i], [...(groups.get(of[i]) ?? []), node.key]));
  return [...groups.values()];
}

/**
 * The concepts in groups, biggest first. By `cluster` and `component` a
 * group is named after the concept in it that most others require, and the
 * concepts with no link at all form a group of their own.
 */
export function ideaGroups(graph: IdeaGraph, edges: readonly MapEdge[], groupBy: GroupBy): IdeaGroup[] {
  const nodes = graph.nodes;
  if (groupBy === 'priority') {
    return [
      ...PRIORITIES.map((priority) => ({ key: priority, label: `${priority[0].toUpperCase()}${priority.slice(1)} priority`, members: nodes.filter((node) => node.idea?.priority === priority).map((node) => node.key) })),
      { key: 'none', label: 'Not written yet', members: nodes.filter((node) => !node.idea).map((node) => node.key) },
    ].filter((group) => group.members.length > 0);
  }
  if (groupBy === 'state') {
    return [
      { key: 'written', label: 'Written', members: nodes.filter((node) => node.written).map((node) => node.key) },
      { key: 'unwritten', label: 'Not written yet', members: nodes.filter((node) => !node.written).map((node) => node.key) },
    ].filter((group) => group.members.length > 0);
  }
  const known = new Set(nodes.map((node) => node.key));
  const inside = edges.filter((edge) => known.has(edge.from) && known.has(edge.to) && edge.from !== edge.to);
  const linked = new Set(inside.flatMap((edge) => [edge.from, edge.to]));
  const linkedNodes = nodes.filter((node) => linked.has(node.key));
  const parts = groupBy === 'component' ? linkedParts(linkedNodes.map((node) => node.key), inside) : clusters(linkedNodes, inside);
  const groups: IdeaGroup[] = parts
    .map((members) => {
      const named = mostRequired(members.map((key) => graph.byKey.get(key)!))!;
      return { key: named.key, label: named.name, members };
    })
    .sort((p, q) => q.members.length - p.members.length || p.label.localeCompare(q.label));
  const loose = nodes.filter((node) => !linked.has(node.key)).map((node) => node.key);
  if (loose.length > 0) groups.push({ key: 'not-linked', label: 'Not linked', members: loose });
  return groups;
}

interface Rect { x: number; y: number; width: number; height: number }

/** A straight line from the border of one box to the border of another, along the line between their middles. */
function straight(from: Rect, to: Rect): string {
  const [ax, ay, bx, by] = [from.x + from.width / 2, from.y + from.height / 2, to.x + to.width / 2, to.y + to.height / 2];
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return `M${ax},${ay} L${bx},${by}`;
  /** How far along the line the border of `box` is, from its middle. */
  const reach = (box: Rect) => Math.min(dx === 0 ? Infinity : box.width / 2 / Math.abs(dx), dy === 0 ? Infinity : box.height / 2 / Math.abs(dy));
  const round = (value: number) => Math.round(value * 10) / 10;
  const [s, e] = [reach(from), 1 - reach(to)];
  return `M${round(ax + dx * s)},${round(ay + dy * s)} L${round(ax + dx * e)},${round(ay + dy * e)}`;
}

const rectOf = (box: MapBox, sizes: MapSizes): Rect => ({ x: box.x, y: box.y, width: sizes.nodeWidth, height: box.height });

/**
 * The order to read the groups in: a group after the groups it builds on.
 * Of two groups, the one builds on the other that needs more from it than
 * the other way round ("requires" counts double). Returns the order and, for
 * each group, the groups it builds on. Groups with no link to another come
 * last.
 */
function groupOrder(count: number, across: ReadonlyArray<{ from: number; to: number; helpful: boolean }>): { order: number[]; before: number[][] } {
  const lead = new Map<string, number>();
  for (const { from, to, helpful } of across) {
    const pair = from < to ? `${from} ${to}` : `${to} ${from}`;
    lead.set(pair, (lead.get(pair) ?? 0) + (from < to ? 1 : -1) * (helpful ? 1 : 2));
  }
  const before: number[][] = Array.from({ length: count }, () => []);
  const tied = new Set<number>();
  for (const [pair, forward] of lead) {
    const [low, high] = pair.split(' ').map(Number);
    if (forward >= 0) before[high].push(low);
    else before[low].push(high);
    tied.add(low).add(high);
  }
  const order: number[] = [];
  const placed = new Set<number>();
  while (order.length < tied.size) {
    // The first that waits for nothing; in a circle of groups, the one that waits for least
    let next = -1;
    let least = Infinity;
    for (const group of [...tied].sort((p, q) => p - q)) {
      const waiting = placed.has(group) ? Infinity : before[group].filter((other) => !placed.has(other)).length;
      if (waiting < least) [next, least] = [group, waiting];
    }
    placed.add(next);
    order.push(next);
  }
  for (let group = 0; group < count; group++) if (!tied.has(group)) order.push(group);
  const place = new Map(order.map((group, i) => [group, i]));
  return { order, before: before.map((list) => list.sort((p, q) => place.get(p)! - place.get(q)!)) };
}

/** Between two frames. */
const FRAME_GAP = 28;
/** A frame is at least this wide inside, for its label. */
const FRAME_MIN = 260;

/**
 * Each group a small left-to-right map in a frame of its own. The frames
 * stand in rows, like words on a page; by topic they are in the order to
 * read them in, and each says which groups it builds on. A link between two
 * concepts of different groups is quiet: its line is drawn only while one of
 * its ends is pointed at or selected.
 */
function layoutGroups(graph: IdeaGraph, edges: readonly MapEdge[], heightOf: (key: string) => number, sizes: MapSizes, groupBy: GroupBy): DrawnMap {
  const found = ideaGroups(graph, edges, groupBy);
  const index = new Map(found.flatMap((group, i) => group.members.map((key) => [key, i] as const)));
  const across = edges.filter((edge) => index.has(edge.from) && index.has(edge.to) && index.get(edge.from) !== index.get(edge.to));
  const topics = groupBy === 'cluster';
  const { order, before } = groupOrder(found.length, topics ? across.map((edge) => ({ from: index.get(edge.from)!, to: index.get(edge.to)!, helpful: edge.helpful })) : []);
  const groups = order.map((i) => ({ ...found[i], before: before[i].map((other) => found[other].label) }));

  const inner = groups.map((group) => layeredBlock(group.members, edges, heightOf, sizes));
  const rects = inner.map((part) => ({ width: Math.max(part.width, FRAME_MIN) + 2 * FRAME_PAD, height: part.height + FRAME_HEAD + FRAME_PAD }));
  // Rows as long as makes the whole fit a screen best
  const area = rects.reduce((sum, rect) => sum + (rect.width + FRAME_GAP) * (rect.height + FRAME_GAP), 0);
  const widest = Math.max(0, ...rects.map((rect) => rect.width));
  const fits = (packed: { width: number; height: number }) => Math.min(16 / packed.width, 10 / packed.height);
  const rows = [1, 1.3, 1.6, 2, 2.5, 3.2]
    .map((ratio) => packRows(rects, Math.max(widest, Math.sqrt(ratio * area)), FRAME_GAP, FRAME_GAP))
    .reduce((best, packed) => (fits(packed) > fits(best) + 1e-9 ? packed : best));

  const joined = joinParts(inner, rows.at.map((at) => ({ x: at.x + FRAME_PAD, y: at.y + FRAME_HEAD })));
  const boxAt = new Map(joined.boxes.map((box) => [box.key, box]));
  const lines: DrawnLine[] = [
    ...joined.lines,
    ...across.map((edge) => ({ ...edge, quiet: true, d: straight(rectOf(boxAt.get(edge.from)!, sizes), rectOf(boxAt.get(edge.to)!, sizes)) })),
  ];
  return {
    ...withMargin({ boxes: joined.boxes, lines, width: rows.width, height: rows.height }, sizes.margin),
    frames: groups.map((group, i) => ({
      key: group.key,
      label: group.label,
      count: group.members.length,
      ...(group.before.length > 0 ? { note: `Builds on: ${group.before.join(', ')}` } : {}),
      x: rows.at[i].x + sizes.margin,
      y: rows.at[i].y + sizes.margin,
      ...rects[i],
    })),
  };
}

/**
 * One concept with all it builds on (left) and all that builds on it
 * (right), layered; every other concept in a frame below, without lines.
 * `focus` is the concept; without one it is the concept most others require.
 */
function layoutFocus(graph: IdeaGraph, edges: readonly MapEdge[], heightOf: (key: string) => number, sizes: MapSizes, focus: string | null): DrawnMap {
  const centre = (focus !== null && graph.byKey.get(focus)) || mostRequired(graph.nodes);
  if (!centre) return { boxes: [], lines: [], width: 0, height: 2 * sizes.margin, frames: [] };
  const near = new Set([centre.key]);
  const reach = (next: (node: IdeaNode) => readonly string[]) => {
    const todo = [centre];
    const seen = new Set([centre.key]);
    while (todo.length > 0) {
      for (const key of next(todo.pop()!)) {
        const node = graph.byKey.get(key);
        if (!node || seen.has(key)) continue;
        seen.add(key);
        near.add(key);
        todo.push(node);
      }
    }
  };
  reach((node) => [...node.requires, ...node.helpful]);
  reach((node) => [...node.neededFor, ...node.helpfulFor]);
  const keys = graph.nodes.map((node) => node.key);
  const main = layeredBlock(keys.filter((key) => near.has(key)), edges, heightOf, sizes);
  const rest = keys.filter((key) => !near.has(key));
  if (rest.length === 0) return { ...withMargin(main, sizes.margin), frames: [] };
  const perRow = Math.max(3, Math.floor((main.width - 2 * FRAME_PAD + sizes.gapY) / (sizes.nodeWidth + sizes.gapY)));
  const grid = boxGrid(rest, heightOf, sizes, Math.min(perRow, rest.length));
  const top = main.height + sizes.gapX;
  const joined = joinParts([main, grid], [{ x: 0, y: 0 }, { x: FRAME_PAD, y: top + FRAME_HEAD }]);
  const frame = { key: 'rest', label: `Not on the way to or from “${centre.name}”`, note: 'Their links are not drawn here', count: rest.length, x: sizes.margin, y: top + sizes.margin, width: grid.width + 2 * FRAME_PAD, height: grid.height + FRAME_HEAD + FRAME_PAD };
  return { ...withMargin({ ...joined, width: Math.max(main.width, frame.width), height: top + frame.height }, sizes.margin), frames: [frame] };
}

export interface LayoutInput {
  graph: IdeaGraph;
  edges: readonly MapEdge[];
  heightOf: (key: string) => number;
  sizes: MapSizes;
  /** Key of the concept the focus layout is drawn around (the selected one), or null. */
  focus?: string | null;
}

/** The map drawn the chosen way. */
export function layoutFor(choice: MapLayoutChoice, { graph, edges, heightOf, sizes, focus = null }: LayoutInput): DrawnMap {
  const keys = graph.nodes.map((node) => node.key);
  if (keys.length === 0) return { boxes: [], lines: [], frames: [], width: 0, height: 2 * sizes.margin };
  switch (choice.layout) {
    case 'rows': return { ...layoutLayered(keys, edges, heightOf, sizes, 'down'), frames: [] };
    case 'groups': return layoutGroups(graph, edges, heightOf, sizes, choice.groupBy);
    case 'focus': return layoutFocus(graph, edges, heightOf, sizes, focus);
    default: return { ...layoutLayered(keys, edges, heightOf, sizes), frames: [] };
  }
}
