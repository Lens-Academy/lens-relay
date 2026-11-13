/**
 * The ways the concept map can be drawn, and `layoutFor`, which draws it the
 * chosen way. Pure: same map, heights and choice, same drawing.
 *
 *  - columns: layered, left to right (lib/idea-map-layered).
 *  - rows: the same, top to bottom.
 *  - groups: the concepts in groups, each group a small left-to-right map in
 *    a frame of its own; links from group to group stay quiet.
 *  - grid: the groups as frames of boxes side by side, no line until a
 *    concept is pointed at.
 *  - tree: every concept once, to the right of the one concept it builds on
 *    most directly (lib/idea-map-tree).
 *  - organic: the groups as islands, those with many links between them
 *    near each other, one arrow per pair of groups (lib/idea-map-organic).
 *  - focus: one concept, everything it builds on to its left and everything
 *    that builds on it to its right; the rest set aside.
 *
 * What makes a group is chosen too: the topic the author gave each concept
 * (frontmatter `topic`), clusters computed from the links, linked parts,
 * priority, written or not.
 *
 * Left out on purpose: rings around the middle by depth. Boxes that hold a
 * whole name do not fit on rings: tried on 183 concepts with every box given
 * the arc it needs, the map came out 4 800 px across and its 192 straight
 * Requires lines passed behind a box 377 times; and depth is what the
 * columns show already.
 */
import { PRIORITIES, type IdeaGraph, type IdeaNode } from './idea-map';
import type { MapBox, MapEdge, MapLayout, MapLine, MapSizes } from './idea-map-layout';
import { boxGrid, gridColumns, joinParts, layeredBlock, layoutLayered, linkedParts, packRows, withMargin, type MapPart } from './idea-map-layered';
import { LINK_KINDS, shownLinks, type LinkKinds } from './idea-map-links';
import { organicBlock, placeIslands, straight, type Pull, type Rect } from './idea-map-organic';
import { layoutTree } from './idea-map-tree';

export const MAP_LAYOUTS = [
  { key: 'groups', label: 'Groups', hint: 'Best start for a big map: each group is a small left-to-right map in a frame of its own' },
  { key: 'grid', label: 'Topic grid', hint: 'The most compact overview: what is in each group, links only for the concept you point at' },
  { key: 'tree', label: 'Tree', hint: 'Every concept once, next to the one concept it builds on most directly: read it like a table of contents' },
  { key: 'organic', label: 'Organic', hint: 'Which groups belong together: groups with many links between them stand near each other, one arrow per pair of groups' },
  { key: 'columns', label: 'Left to right', hint: 'The order to learn in: what comes first on the left, every link drawn. Good up to about 60 concepts' },
  { key: 'rows', label: 'Top to bottom', hint: 'The same with what comes first at the top' },
  { key: 'focus', label: 'Around one concept', hint: 'Only the selected concept, all it builds on (left) and all that builds on it (right)' },
] as const;
export type MapLayoutKind = (typeof MAP_LAYOUTS)[number]['key'];
/** The layouts that draw the concepts in groups: "Group by" is theirs. */
export const GROUPED_LAYOUTS: readonly MapLayoutKind[] = ['groups', 'grid', 'organic'];

export const MAP_GROUPINGS = [
  { key: 'topic', label: 'Topic (yours)', hint: 'The topic you gave each concept' },
  { key: 'cluster', label: 'Clusters (computed from the links)', hint: 'Sets of concepts with many links among them, found by the page; no one chose them' },
  { key: 'component', label: 'Linked part', hint: 'Concepts that are linked to each other at all' },
  { key: 'priority', label: 'Priority' },
  { key: 'state', label: 'Written or not' },
] as const;
export type GroupBy = (typeof MAP_GROUPINGS)[number]['key'];

export interface MapLayoutChoice {
  layout: MapLayoutKind;
  /** Used by the layouts that draw groups. */
  groupBy: GroupBy;
  /** Which kinds of link are drawn. */
  links: LinkKinds;
  /** Leave out the links a chain of Requires says already. */
  hideImplied: boolean;
}
/** What the browser keeps: only what was chosen by hand; the rest follows the map. */
export type StoredChoice = Partial<MapLayoutChoice>;

/** What was stored (JSON), as far as it is known; nothing for anything else. */
export function parseChoice(raw: string | null): StoredChoice {
  try {
    const stored = JSON.parse(raw ?? 'null') as Record<string, unknown> | null;
    if (!stored || typeof stored !== 'object') return {};
    const layout = MAP_LAYOUTS.find((known) => known.key === stored.layout)?.key;
    const groupBy = MAP_GROUPINGS.find((known) => known.key === stored.groupBy)?.key;
    const links = LINK_KINDS.find((known) => known.key === stored.links)?.key;
    return {
      ...(layout ? { layout } : {}),
      ...(groupBy ? { groupBy } : {}),
      ...(links ? { links } : {}),
      ...(typeof stored.hideImplied === 'boolean' ? { hideImplied: stored.hideImplied } : {}),
    };
  } catch {
    return {};
  }
}

/** Whether any concept of the map was given a topic. */
export const hasTopics = (graph: IdeaGraph) => graph.nodes.some((node) => node.idea?.topic);

/** A map with more concepts than this opens in groups: with every link drawn it is a thicket. */
const MANY_CONCEPTS = 60;

/**
 * How the map is drawn: what was chosen, and for what was not, what suits
 * this map. Groups are the author's topics as soon as one concept has a
 * topic (and never when none has); a big map opens in groups.
 */
export function resolveChoice(stored: StoredChoice, graph: IdeaGraph): MapLayoutChoice {
  const topics = hasTopics(graph);
  const groupBy = stored.groupBy ?? (topics ? 'topic' : 'cluster');
  return {
    layout: stored.layout ?? (graph.nodes.length > MANY_CONCEPTS ? 'groups' : 'columns'),
    groupBy: groupBy === 'topic' && !topics ? 'cluster' : groupBy,
    links: stored.links ?? 'all',
    hideImplied: stored.hideImplied ?? false,
  };
}

/** A labelled outline behind some of the boxes. */
export interface MapFrame {
  key: string;
  label: string;
  /** How many concepts are in it. */
  count: number;
  /** A second line under the label. */
  note?: string;
  /** Which of the colours for topics it has (a number from 0 up); none: grey. */
  tone?: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DrawnLine extends MapLine {
  /** From a concept to one in another frame: drawn only while one of its ends is pointed at or selected. */
  quiet?: boolean;
}

/** All the links from the concepts of one frame to those of another, as one arrow. */
export interface MapBundle {
  /** Keys of the two frames. */
  from: string;
  to: string;
  /** How many links it stands for. */
  count: number;
  d: string;
  /** Where its number is written. */
  x: number;
  y: number;
}

export interface DrawnMap extends MapLayout {
  lines: DrawnLine[];
  frames: MapFrame[];
  bundles?: MapBundle[];
}

/** Inside a frame, around its boxes. */
export const FRAME_PAD = 20;
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
  /** Which of the colours for topics the group has; the same in every layout. */
  tone?: number;
}

/** The key of the group of concepts with no topic. */
export const NO_TOPIC = 'no-topic';

/** The topics the author gave, by name, each with the colour it keeps in every drawing. */
export function topicsOf(graph: IdeaGraph): Array<{ key: string; label: string; tone: number }> {
  const labels = new Map<string, string>();
  for (const node of graph.nodes) {
    const topic = node.idea?.topic ?? '';
    if (topic && !labels.has(topic.toLowerCase())) labels.set(topic.toLowerCase(), topic);
  }
  return [...labels].sort((p, q) => p[1].localeCompare(q[1])).map(([key, label], tone) => ({ key: `topic:${key}`, label, tone }));
}

/** The key of the topic group a concept is in. */
export const topicKey = (node: IdeaNode) => (node.idea?.topic ? `topic:${node.idea.topic.toLowerCase()}` : NO_TOPIC);

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
 * The concepts in groups, biggest first. By `topic` a group is a topic the
 * author gave (the concepts without one come last, as "No topic"). By
 * `cluster` and `component` a group is named after the concept in it that
 * most others require, and the concepts with no link at all form a group of
 * their own.
 */
export function ideaGroups(graph: IdeaGraph, edges: readonly MapEdge[], groupBy: GroupBy): IdeaGroup[] {
  const nodes = graph.nodes;
  if (groupBy === 'topic') {
    // As the author wrote them (whatever the case); a concept with none, and one not written yet, in a group of their own
    return [
      ...topicsOf(graph).map((topic) => ({ ...topic, members: nodes.filter((node) => topicKey(node) === topic.key).map((node) => node.key) })),
      { key: NO_TOPIC, label: 'No topic', members: nodes.filter((node) => topicKey(node) === NO_TOPIC).map((node) => node.key) },
    ].filter((group) => group.members.length > 0).sort((p, q) => Number(p.key === NO_TOPIC) - Number(q.key === NO_TOPIC) || q.members.length - p.members.length || p.label.localeCompare(q.label));
  }
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

/** Between two frames: wide enough that two topics never read as one. */
const FRAME_GAP = 56;
/** A frame is at least this wide inside, for its label. */
const FRAME_MIN = 260;

interface Framed {
  groups: Array<IdeaGroup & { before: string[] }>;
  /** Per concept: the place of its group in `groups`. */
  index: Map<string, number>;
  /** The links from a concept of one group to a concept of another. */
  across: MapEdge[];
}

/** The groups in the order to read them in, and the links between them. */
function framed(graph: IdeaGraph, edges: readonly MapEdge[], groupBy: GroupBy): Framed {
  const found = ideaGroups(graph, edges, groupBy);
  const at = new Map(found.flatMap((group, i) => group.members.map((key) => [key, i] as const)));
  const across = edges.filter((edge) => at.has(edge.from) && at.has(edge.to) && at.get(edge.from) !== at.get(edge.to));
  const topics = groupBy === 'cluster' || groupBy === 'topic';
  const { order, before } = groupOrder(found.length, topics ? across.map((edge) => ({ from: at.get(edge.from)!, to: at.get(edge.to)!, helpful: edge.helpful })) : []);
  // What has no topic, or no link, is read last
  const last = (i: number) => Number(found[i].key === NO_TOPIC || found[i].key === 'not-linked');
  const groups = [...order].sort((p, q) => last(p) - last(q)).map((i) => ({ ...found[i], before: before[i].map((other) => found[other].label) }));
  return { groups, index: new Map(groups.flatMap((group, i) => group.members.map((key) => [key, i] as const))), across };
}

/** The frame around the drawing `part` of a group. */
const frameSize = (part: MapPart) => ({ width: Math.max(part.width, FRAME_MIN) + 2 * FRAME_PAD, height: part.height + FRAME_HEAD + FRAME_PAD });

/** Frames in rows, like words on a page: rows as long as makes the whole fit a screen best. */
function frameRows(rects: ReadonlyArray<{ width: number; height: number }>) {
  const area = rects.reduce((sum, rect) => sum + (rect.width + FRAME_GAP) * (rect.height + FRAME_GAP), 0);
  const widest = Math.max(0, ...rects.map((rect) => rect.width));
  const fits = (packed: { width: number; height: number }) => Math.min(16 / packed.width, 10 / packed.height);
  return [1, 1.3, 1.6, 2, 2.5, 3.2]
    .map((ratio) => packRows(rects, Math.max(widest, Math.sqrt(ratio * area)), FRAME_GAP, FRAME_GAP))
    .reduce((best, packed) => (fits(packed) > fits(best) + 1e-9 ? packed : best));
}

/** The groups' drawings in their frames at `at`, as one map; the links between groups quiet. */
function framedMap(
  { groups, across }: Framed,
  inner: readonly MapPart[],
  placed: { at: ReadonlyArray<{ x: number; y: number }>; width: number; height: number },
  sizes: MapSizes,
  more: Partial<Pick<DrawnMap, 'bundles'>> = {},
): DrawnMap {
  const rects = inner.map(frameSize);
  const joined = joinParts(inner, placed.at.map((at, i) => ({ x: at.x + FRAME_PAD + (rects[i].width - 2 * FRAME_PAD - inner[i].width) / 2, y: at.y + FRAME_HEAD })));
  const boxAt = new Map(joined.boxes.map((box) => [box.key, box]));
  const lines: DrawnLine[] = [
    ...joined.lines,
    ...across.map((edge) => ({ ...edge, quiet: true, d: straight(rectOf(boxAt.get(edge.from)!, sizes), rectOf(boxAt.get(edge.to)!, sizes)) })),
  ];
  return {
    ...withMargin({ boxes: joined.boxes, lines, width: placed.width, height: placed.height }, sizes.margin),
    frames: groups.map((group, i) => ({
      key: group.key,
      label: group.label,
      count: group.members.length,
      ...(group.tone !== undefined ? { tone: group.tone } : {}),
      ...(group.before.length > 0 ? { note: `Builds on: ${group.before.join(', ')}` } : {}),
      x: placed.at[i].x + sizes.margin,
      y: placed.at[i].y + sizes.margin,
      ...rects[i],
    })),
    ...more,
  };
}

/**
 * Each group a small left-to-right map in a frame of its own. The frames
 * stand in rows, like words on a page; by topic they are in the order to
 * read them in, and each says which groups it builds on. A link between two
 * concepts of different groups is quiet: its line is drawn only while one of
 * its ends is pointed at or selected.
 */
function layoutGroups(graph: IdeaGraph, edges: readonly MapEdge[], heightOf: (key: string) => number, sizes: MapSizes, groupBy: GroupBy): DrawnMap {
  const parts = framed(graph, edges, groupBy);
  const inner = parts.groups.map((group) => layeredBlock(group.members, edges, heightOf, sizes));
  return framedMap(parts, inner, frameRows(inner.map(frameSize)), sizes);
}

/** Between two boxes of the grid: room for the eye, and for a line to pass. */
const GRID_GAP = 16;

/**
 * Each group a frame that holds its concepts side by side, what comes first
 * at the top left, with no line at all: every link is quiet. The most
 * compact drawing, for seeing what is in each group.
 */
function layoutGrid(graph: IdeaGraph, edges: readonly MapEdge[], heightOf: (key: string) => number, sizes: MapSizes, groupBy: GroupBy): DrawnMap {
  const parts = framed(graph, edges, groupBy);
  const inner = parts.groups.map((group) => {
    const members = group.members.map((key) => graph.byKey.get(key)!).sort((p, q) => p.step - q.step || byName(p, q)).map((node) => node.key);
    const mean = members.reduce((sum, key) => sum + heightOf(key), 0) / Math.max(1, members.length);
    return boxGrid(members, heightOf, sizes, gridColumns(members.length, mean, sizes, GRID_GAP), GRID_GAP);
  });
  const drawn = framedMap(parts, inner, frameRows(inner.map(frameSize)), sizes);
  const boxAt = new Map(drawn.boxes.map((box) => [box.key, box]));
  const inside = edges.filter((edge) => boxAt.has(edge.from) && boxAt.has(edge.to) && edge.from !== edge.to && parts.index.get(edge.from) === parts.index.get(edge.to));
  return { ...drawn, lines: [...drawn.lines, ...inside.map((edge) => ({ ...edge, quiet: true, d: straight(rectOf(boxAt.get(edge.from)!, sizes), rectOf(boxAt.get(edge.to)!, sizes)) }))] };
}

/** The most concepts a group is drawn organically with. */
const ORGANIC_MOST = 30;
/** An arrow between two islands is drawn from this many links up. */
const BUNDLE_LEAST = 6;
/** Between two islands: room for the arrows between them. */
const ISLAND_GAP = 110;

/**
 * Each group an island with its concepts drawn organically; islands with
 * many links between them stand near each other. All the links from one
 * island to another are one arrow with their number on it, from the island
 * that comes first to the one that builds on it; the links themselves are
 * quiet.
 */
function layoutOrganic(graph: IdeaGraph, edges: readonly MapEdge[], heightOf: (key: string) => number, sizes: MapSizes, groupBy: GroupBy): DrawnMap {
  const parts = framed(graph, edges, groupBy);
  // Straight lines among many boxes pass behind boxes: a big group is drawn in columns, like in "Groups"
  const inner = parts.groups.map((group) => (group.members.length > ORGANIC_MOST ? layeredBlock : organicBlock)(group.members, edges, heightOf, sizes));
  const rects = inner.map(frameSize);
  // Per pair of islands: how many links, and how many of them from the first to the second
  const between = new Map<string, { a: number; b: number; count: number; forward: number }>();
  for (const edge of parts.across) {
    const [from, to] = [parts.index.get(edge.from)!, parts.index.get(edge.to)!];
    const [a, b] = from < to ? [from, to] : [to, from];
    const pair = between.get(`${a} ${b}`) ?? { a, b, count: 0, forward: 0 };
    pair.count += 1;
    pair.forward += from === a ? 1 : 0;
    between.set(`${a} ${b}`, pair);
  }
  const pulls: Pull[] = [...between.values()].map((pair) => [pair.a, pair.b, pair.count]);
  const placed = placeIslands(rects, pulls, ISLAND_GAP);
  const drawn = framedMap(parts, inner, placed, sizes);
  const frameRect = (i: number): Rect => drawn.frames[i];
  // Nearly every pair of groups has some link: an arrow for each would be a thicket. Drawn are the pairs with
  // several links, and for each island its strongest tie, so none stands unexplained.
  const strongest = rects.map((_, i) => Math.max(0, ...[...between.values()].filter((pair) => pair.a === i || pair.b === i).map((pair) => pair.count)));
  const told = [...between.values()].filter((pair) => pair.count >= BUNDLE_LEAST || pair.count === strongest[pair.a] || pair.count === strongest[pair.b]);
  const bundles: MapBundle[] = told.map((pair) => {
    const [from, to] = pair.forward * 2 >= pair.count ? [pair.a, pair.b] : [pair.b, pair.a];
    const d = straight(frameRect(from), frameRect(to));
    const [x1, y1, x2, y2] = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    return { from: drawn.frames[from].key, to: drawn.frames[to].key, count: pair.count, d, x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
  });
  return { ...drawn, bundles };
}

/**
 * The map as trees (lib/idea-map-tree); the links that are not part of a
 * tree are quiet.
 */
function layoutTrees(graph: IdeaGraph, edges: readonly MapEdge[], heightOf: (key: string) => number, sizes: MapSizes): DrawnMap {
  const { parents, ...part } = layoutTree(graph, edges, heightOf, sizes);
  const boxAt = new Map(part.boxes.map((box) => [box.key, box]));
  const rest = edges.filter((edge) => boxAt.has(edge.from) && boxAt.has(edge.to) && edge.from !== edge.to
    && !(parents.get(edge.to)?.parent === edge.from && parents.get(edge.to)?.helpful === edge.helpful));
  const lines: DrawnLine[] = [
    ...part.lines,
    ...rest.map((edge) => ({ ...edge, quiet: true, d: straight(rectOf(boxAt.get(edge.from)!, sizes), rectOf(boxAt.get(edge.to)!, sizes)) })),
  ];
  return { ...withMargin({ ...part, lines }, sizes.margin), frames: [] };
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

/** The map drawn the chosen way, with the links that were chosen. */
export function layoutFor(choice: MapLayoutChoice, { graph, edges: all, heightOf, sizes, focus = null }: LayoutInput): DrawnMap {
  const keys = graph.nodes.map((node) => node.key);
  if (keys.length === 0) return { boxes: [], lines: [], frames: [], width: 0, height: 2 * sizes.margin };
  const edges = shownLinks(all, choice);
  switch (choice.layout) {
    case 'rows': return { ...layoutLayered(keys, edges, heightOf, sizes, 'down'), frames: [] };
    case 'groups': return layoutGroups(graph, edges, heightOf, sizes, choice.groupBy);
    case 'grid': return layoutGrid(graph, edges, heightOf, sizes, choice.groupBy);
    case 'organic': return layoutOrganic(graph, edges, heightOf, sizes, choice.groupBy);
    case 'tree': return layoutTrees(graph, edges, heightOf, sizes);
    case 'focus': return layoutFocus(graph, edges, heightOf, sizes, focus);
    default: return { ...layoutLayered(keys, edges, heightOf, sizes), frames: [] };
  }
}
