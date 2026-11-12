/**
 * The concept map as a layered drawing: what comes first on one side, what
 * needs it on the other, every line readable from box to box.
 *
 * dagre decides which column an idea stands in (so that links are short) and
 * the order inside a column (so that few lines cross); a link that spans
 * several columns gets a place of its own, a lane, in each column it passes.
 * The rest is done here:
 *  - how far apart the boxes and lanes of a column stand: as close together
 *    as their links pull them, never nearer than the gaps allow;
 *  - the lines: square with rounded corners. A line runs level out of its
 *    box, turns once in the free space between two columns, on a track that
 *    no other line uses beside it, and runs level into the next box or
 *    through its lane. So no line passes through or behind a box, and two
 *    lines only ever cross, never run on top of each other;
 *  - the ends of the lines on one side of a box are spread along it in the
 *    order of where the lines go;
 *  - the space between two columns is as wide as its tracks need.
 * Parts of the map that are not linked to each other are laid out one by one
 * and packed; ideas with no link at all stand in a block below.
 *
 * Pure: same ideas, links and heights, same drawing.
 */
import dagre from '@dagrejs/dagre';
import type { MapBox, MapEdge, MapLayout, MapLine, MapSizes } from './idea-map-layout';

/** Which way the map reads: foundations on the left, or at the top. */
export type MapFlow = 'right' | 'down';

/** Between two lanes of a column. */
const LANE_GAP = 8;
/** Between a lane and a box of its column. */
const LANE_BOX_GAP = 10;
/** Between two line ends on one side of a box, when there is room. */
const PORT_GAP = 9;
/** From a corner of a box to the nearest line end. */
const PORT_INSET = 7;
/** Between two tracks of the space between two columns. */
const TRACK_GAP = 7;
/** How many crossings a track more in the space between two columns is worth. */
const NEW_TRACK = 4;
/** Two level stretches of line nearer than this read as one. */
const CLOSE = 3;
/** What one line on top of another counts, in crossings: never worth it. */
const ON_TOP = 1000;
/** Between the ends of two turns that share a track. */
const TURN_GAP = 4;
/** From a column to the nearest track: room for an arrowhead and a corner. */
const TRACK_INSET = 14;
/** How round a corner of a line is. */
const CORNER = 5;
/** How far a line from an idea to itself stands out. */
const LOOP = 18;
/** How often the columns are gone through to pull linked boxes together. */
const SWEEPS = 24;

/** A drawing of some of the map, with its own top left corner at 0,0. */
export interface MapPart {
  boxes: MapBox[];
  lines: MapLine[];
  width: number;
  height: number;
}

const round = (value: number) => Math.round(value * 10) / 10;

/** A box or a lane in its column: `at` is its middle across the flow. */
interface Item {
  band: number;
  size: number;
  at: number;
  lane: boolean;
  links: Array<{ other: Item; weight: number }>;
}

/** A line: its two boxes, the lanes between them, and where its ends sit on the boxes. */
interface Route {
  edge: MapEdge;
  from: Item;
  to: Item;
  /** Box, lanes, box: one per column, in the order the line passes them. */
  stops: Item[];
  start: number;
  end: number;
  /** Per space between two stops: the track the line turns on. */
  tracks: number[];
}

/**
 * The places closest to `wanted` (by weight) that keep the order and stand at
 * least `gaps[i]` after the one before: pool adjacent violators.
 */
function settle(wanted: readonly number[], weights: readonly number[], gaps: readonly number[]): number[] {
  const offset: number[] = [0];
  for (let i = 1; i < wanted.length; i++) offset.push(offset[i - 1] + gaps[i - 1]);
  const pools: Array<{ weight: number; sum: number; count: number }> = [];
  wanted.forEach((value, i) => {
    let pool = { weight: weights[i], sum: weights[i] * (value - offset[i]), count: 1 };
    while (pools.length > 0 && pools[pools.length - 1].sum / pools[pools.length - 1].weight > pool.sum / pool.weight) {
      const before = pools.pop()!;
      pool = { weight: before.weight + pool.weight, sum: before.sum + pool.sum, count: before.count + pool.count };
    }
    pools.push(pool);
  });
  const placed: number[] = [];
  for (const pool of pools) {
    for (let n = 0; n < pool.count; n++) placed.push(pool.sum / pool.weight + offset[placed.length]);
  }
  return placed;
}

/**
 * How bad it is that `left` turns on a track left of `right`'s, in the space
 * between two columns: one for each time the two lines cross, and a lot when
 * `right` would come in at the height at which `left` goes on, one line on
 * top of the other.
 */
function crossings(left: { from: number; to: number }, right: { from: number; to: number }): number {
  const inside = (value: number, line: { from: number; to: number }) => value > Math.min(line.from, line.to) && value < Math.max(line.from, line.to);
  return (inside(right.from, left) ? 1 : 0) + (inside(left.to, right) ? 1 : 0) + (Math.abs(right.from - left.to) < CLOSE ? ON_TOP : 0);
}

/** A line through `points` with its corners rounded. */
function cornered(points: ReadonlyArray<readonly [number, number]>): string {
  const path = [`M${round(points[0][0])},${round(points[0][1])}`];
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1];
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    const before = Math.hypot(x - px, y - py);
    const after = Math.hypot(nx - x, ny - y);
    const cut = Math.min(CORNER, before / 2, after / 2);
    path.push(
      `L${round(x + ((px - x) / before) * cut)},${round(y + ((py - y) / before) * cut)}`,
      `Q${round(x)},${round(y)} ${round(x + ((nx - x) / after) * cut)},${round(y + ((ny - y) / after) * cut)}`,
    );
  }
  const last = points[points.length - 1];
  path.push(`L${round(last[0])},${round(last[1])}`);
  return path.join(' ');
}

/** One connected part of the map. */
function layeredPart(
  keys: readonly string[],
  edges: readonly MapEdge[],
  heightOf: (key: string) => number,
  sizes: MapSizes,
  flow: MapFlow,
): MapPart {
  const right = flow === 'right';
  const wide = sizes.nodeWidth;
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: right ? 'LR' : 'TB', ranksep: 60, nodesep: sizes.gapY, edgesep: LANE_GAP, ranker: 'network-simplex', acyclicer: 'greedy' });
  g.setDefaultEdgeLabel(() => ({}));
  for (const key of keys) g.setNode(key, { width: wide, height: heightOf(key) });
  // A line from an idea to itself is drawn here, not by dagre
  const between = edges.map((edge, index) => ({ edge, index })).filter(({ edge }) => edge.from !== edge.to);
  // "Requires" pulls harder than "helpful first": those lines come out shorter and straighter
  for (const { edge, index } of between) g.setEdge(edge.from, edge.to, { weight: edge.helpful ? 1 : 3 }, String(index));
  dagre.layout(g);

  // The columns (rows when the map runs down): the boxes that share a place along the flow
  const spot = keys.map((key) => {
    const node = g.node(key);
    return { key, along: round(right ? node.x : node.y), across: right ? node.y : node.x };
  });
  const centres = [...new Set(spot.map((box) => box.along))].sort((p, q) => p - q);
  /** How much of the flow a box takes: its width, or its height when the map runs down. */
  const deep = (key: string) => (right ? wide : heightOf(key));
  const bands = centres.map(() => ({ deep: 0, lo: 0, items: [] as Item[] }));
  const items = new Map<string, Item>();
  for (const { key, along, across } of spot) {
    const band = centres.indexOf(along);
    const item: Item = { band, size: right ? heightOf(key) : wide, at: across, lane: false, links: [] };
    items.set(key, item);
    bands[band].items.push(item);
    bands[band].deep = Math.max(bands[band].deep, deep(key));
  }
  const bandAt = (along: number) => centres.findIndex((centre, band) => Math.abs(along - centre) <= bands[band].deep / 2 + 0.5);

  const link = (p: Item, q: Item, weight: number) => {
    const pull = weight * (p.lane && q.lane ? 4 : p.lane || q.lane ? 2 : 1);
    p.links.push({ other: q, weight: pull });
    q.links.push({ other: p, weight: pull });
  };
  const routes: Route[] = between.map(({ edge, index }) => {
    const from = items.get(edge.from)!;
    const to = items.get(edge.to)!;
    const step = to.band >= from.band ? 1 : -1;
    const lanes = new Map<number, Item>();
    for (const point of g.edge({ v: edge.from, w: edge.to, name: String(index) })?.points ?? []) {
      const band = bandAt(right ? point.x : point.y);
      const passes = band >= 0 && (band - from.band) * step > 0 && (to.band - band) * step > 0;
      if (passes && !lanes.has(band)) lanes.set(band, { band, size: 0, at: right ? point.y : point.x, lane: true, links: [] });
    }
    const stops = [from];
    for (let band = from.band + step; band !== to.band && from.band !== to.band; band += step) {
      // dagre gives a lane in every column a line passes; should one be missing, the line goes straight on
      const lane = lanes.get(band) ?? { band, size: 0, at: stops[stops.length - 1].at, lane: true, links: [] };
      bands[band].items.push(lane);
      stops.push(lane);
    }
    stops.push(to);
    for (let i = 1; i < stops.length; i++) link(stops[i - 1], stops[i], edge.helpful ? 0.5 : 1);
    return { edge, from, to, stops, start: 0, end: 0, tracks: [] };
  });

  // Across the flow: the order is dagre's; each column in turn is set where
  // its links pull it, as close together as the gaps allow.
  const gapAfter = (p: Item, q: Item) => (p.size + q.size) / 2 + (p.lane && q.lane ? LANE_GAP : p.lane || q.lane ? LANE_BOX_GAP : sizes.gapY);
  for (const band of bands) {
    band.items.sort((p, q) => p.at - q.at || Number(p.lane) - Number(q.lane));
    const tight = settle(band.items.map((item) => item.at), band.items.map(() => 1), band.items.slice(1).map((item, i) => gapAfter(band.items[i], item)));
    band.items.forEach((item, i) => { item.at = tight[i]; });
  }
  const pull = (band: (typeof bands)[number]) => {
    const wanted = band.items.map((item) => {
      const weight = item.links.reduce((sum, other) => sum + other.weight, 0);
      return weight > 0 ? item.links.reduce((sum, other) => sum + other.weight * other.other.at, 0) / weight : item.at;
    });
    const weights = band.items.map((item) => item.links.reduce((sum, other) => sum + other.weight, 0) || 0.001);
    const placed = settle(wanted, weights, band.items.slice(1).map((item, i) => gapAfter(band.items[i], item)));
    band.items.forEach((item, i) => { item.at = placed[i]; });
  };
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    for (const band of bands) pull(band);
    for (let i = bands.length - 2; i >= 0; i--) pull(bands[i]);
  }

  // The ends of the lines on one side of a box, spread along it in the order
  // of where the lines go, so they do not cross right at the box.
  const sides = new Map<Item, { far: Array<{ route: Route; end: 'start' | 'end'; toward: number; tie: number }>; near: Array<{ route: Route; end: 'start' | 'end'; toward: number; tie: number }> }>();
  const sideOf = (item: Item, far: boolean) => {
    if (!sides.has(item)) sides.set(item, { far: [], near: [] });
    return sides.get(item)![far ? 'far' : 'near'];
  };
  for (const route of routes) {
    const { from, to, stops } = route;
    if (from.band === to.band) continue;
    const forward = to.band > from.band;
    sideOf(from, forward).push({ route, end: 'start', toward: stops[1].at, tie: to.at });
    sideOf(to, !forward).push({ route, end: 'end', toward: stops[stops.length - 2].at, tie: from.at });
  }
  for (const [item, both] of sides) {
    for (const ends of [both.far, both.near]) {
      ends.sort((p, q) => p.toward - q.toward || p.tie - q.tie);
      const room = Math.max(0, item.size - 2 * PORT_INSET);
      const step = ends.length > 1 ? Math.min(PORT_GAP, room / (ends.length - 1)) : 0;
      ends.forEach(({ route, end }, i) => { route[end] = item.at + (i - (ends.length - 1) / 2) * step; });
    }
  }

  // The space between two columns: every line that changes height there gets
  // a track to turn on. Two lines whose turns would touch get different
  // tracks, in the order that makes them cross least.
  const turns = bands.slice(1).map(() => [] as Array<{ route: Route; hop: number; from: number; to: number; track: number }>);
  for (const route of routes) {
    const { stops } = route;
    const heightAt = (i: number) => (i === 0 ? route.start : i === stops.length - 1 ? route.end : stops[i].at);
    for (let hop = 0; hop + 1 < stops.length; hop++) {
      route.tracks.push(0);
      const rising = stops[hop + 1].band > stops[hop].band;
      // Seen from the lower column to the higher one, whichever way the line goes
      const from = heightAt(rising ? hop : hop + 1);
      const to = heightAt(rising ? hop + 1 : hop);
      if (Math.abs(from - to) > 0.5) turns[Math.min(stops[hop].band, stops[hop + 1].band)].push({ route, hop, from, to, track: 0 });
    }
  }
  const trackCount = turns.map((list) => {
    // From the top down, each on the track where it crosses the lines beside
    // it least; a track more only when that saves crossings.
    list.sort((p, q) => Math.min(p.from, p.to) - Math.min(q.from, q.to) || Math.max(p.from, p.to) - Math.max(q.from, q.to));
    // But first of all no line on top of another: a line that comes in at
    // the height at which another goes on has to turn before that one does.
    const turnsFirst = (p: (typeof list)[number], q: (typeof list)[number]) => Math.abs(p.from - q.to) < CLOSE && Math.abs(q.from - p.to) >= CLOSE;
    const waits = list.map((turn) => list.filter((other) => other !== turn && turnsFirst(other, turn)).length);
    const todo = list.map((_, i) => i);
    const placed: typeof list = [];
    let count = 0;
    while (todo.length > 0) {
      // The next one from the top that waits for nobody (when they wait for each other in a circle: the next one)
      const next = Math.max(0, todo.findIndex((i) => waits[i] === 0));
      const turn = list[todo.splice(next, 1)[0]];
      list.forEach((other, i) => { if (other !== turn && turnsFirst(turn, other)) waits[i] -= 1; });
      const lo = Math.min(turn.from, turn.to) - TURN_GAP;
      const hi = Math.max(turn.from, turn.to) + TURN_GAP;
      const beside = placed.filter((other) => Math.min(other.from, other.to) < hi && Math.max(other.from, other.to) > lo);
      const least = Math.max(0, ...beside.filter((other) => turnsFirst(other, turn)).map((other) => other.track + 1));
      let best = Infinity;
      for (let track = least; track <= count; track++) {
        if (beside.some((other) => other.track === track)) continue;
        const cost = beside.reduce((sum, other) => sum + (other.track < track ? crossings(other, turn) : crossings(turn, other)), track === count ? NEW_TRACK : 0);
        if (cost < best) {
          best = cost;
          turn.track = track;
        }
      }
      turn.route.tracks[turn.hop] = turn.track;
      count = Math.max(count, turn.track + 1);
      placed.push(turn);
    }
    return count;
  });

  // Along the flow: column, space as wide as its tracks need, column
  const firstTrack: number[] = [];
  bands.forEach((band, i) => {
    if (i === 0) return;
    const before = bands[i - 1];
    const tracks = Math.max(0, trackCount[i - 1] - 1) * TRACK_GAP;
    const space = Math.max(sizes.gapX, tracks + 2 * TRACK_INSET);
    firstTrack.push(before.lo + before.deep + (space - tracks) / 2);
    band.lo = before.lo + before.deep + space;
  });
  const top = Math.min(...bands.flatMap((band) => band.items.map((item) => item.at - item.size / 2)));
  const bottom = Math.max(...bands.flatMap((band) => band.items.map((item) => item.at + item.size / 2)));
  const lastBand = bands[bands.length - 1];
  let length = lastBand.lo + lastBand.deep;

  /** A point `along` the flow and `across` it, as x, y. */
  const xy = (along: number, across: number): [number, number] => (right ? [along, across - top] : [across - top, along]);
  const edgesOf = (key: string) => {
    const band = bands[items.get(key)!.band];
    const near = band.lo + (band.deep - deep(key)) / 2;
    return { near, far: near + deep(key) };
  };
  const boxes: MapBox[] = keys.map((key) => {
    const item = items.get(key)!;
    const [x, y] = xy(edgesOf(key).near, item.at - item.size / 2);
    return { key, column: item.band, x, y, height: heightOf(key) };
  });

  const drawn = new Map<MapEdge, string>();
  for (const route of routes) {
    const { edge, from, to, stops, start, end, tracks } = route;
    if (from.band === to.band) {
      // Never from dagre (two linked ideas stand in different columns): round the far side
      const out = Math.max(edgesOf(edge.from).far, edgesOf(edge.to).far) + sizes.gapX / 2;
      length = Math.max(length, out);
      drawn.set(edge, `M${xy(edgesOf(edge.from).far, from.at).map(round)} C${xy(out, from.at).map(round)} ${xy(out, to.at).map(round)} ${xy(edgesOf(edge.to).far, to.at).map(round)}`);
      continue;
    }
    // Out of the side that faces the way the line goes, into the side it comes from
    const forward = to.band > from.band;
    const points = [xy(forward ? edgesOf(edge.from).far : edgesOf(edge.from).near, start)];
    let across = start;
    for (let hop = 0; hop + 1 < stops.length; hop++) {
      const next = hop + 2 === stops.length ? end : stops[hop + 1].at;
      if (Math.abs(next - across) > 0.5) {
        const space = Math.min(stops[hop].band, stops[hop + 1].band);
        const track = firstTrack[space] + tracks[hop] * TRACK_GAP;
        points.push(xy(track, across), xy(track, next));
      }
      across = next;
    }
    points.push(xy(forward ? edgesOf(edge.to).near : edgesOf(edge.to).far, end));
    drawn.set(edge, cornered(points));
  }
  const lines: MapLine[] = edges.map((edge) => {
    if (edge.from !== edge.to) return { ...edge, d: drawn.get(edge)! };
    const item = items.get(edge.from)!;
    const { far } = edgesOf(edge.from);
    length = Math.max(length, far + LOOP);
    const [a, b, c, d] = [[far, -6], [far + LOOP, -14], [far + LOOP, 14], [far, 6]].map(([along, off]) => xy(along, item.at + off).map(round));
    return { ...edge, d: `M${a} C${b} ${c} ${d}` };
  });

  return right ? { boxes, lines, width: length, height: bottom - top } : { boxes, lines, width: bottom - top, height: length };
}

/** `part` moved by dx, dy. */
export function movePart(part: MapPart, dx: number, dy: number): MapPart {
  if (dx === 0 && dy === 0) return part;
  const pair = /(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?),(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)/g;
  return {
    ...part,
    boxes: part.boxes.map((box) => ({ ...box, x: box.x + dx, y: box.y + dy })),
    lines: part.lines.map((line) => ({ ...line, d: line.d.replace(pair, (_, x: string, y: string) => `${round(Number(x) + dx)},${round(Number(y) + dy)}`) })),
  };
}

/**
 * Boxes with no line between them, in rows of `perRow`, each row as tall as
 * its tallest box.
 */
export function boxGrid(keys: readonly string[], heightOf: (key: string) => number, sizes: MapSizes, perRow: number, gap = sizes.gapY): MapPart {
  const boxes: MapBox[] = [];
  let y = 0;
  let tall = 0;
  keys.forEach((key, i) => {
    const column = i % perRow;
    if (column === 0 && i > 0) {
      y += tall + gap;
      tall = 0;
    }
    const height = heightOf(key);
    tall = Math.max(tall, height);
    boxes.push({ key, column, x: column * (sizes.nodeWidth + gap), y, height });
  });
  const columns = Math.min(perRow, keys.length);
  return { boxes, lines: [], width: columns === 0 ? 0 : columns * (sizes.nodeWidth + gap) - gap, height: keys.length === 0 ? 0 : y + tall };
}

/** How many boxes to a row for a block of `count` loose boxes that is about half again as wide as tall. */
export function gridColumns(count: number, meanHeight: number, sizes: MapSizes, gap = sizes.gapY): number {
  if (count <= 1) return Math.max(1, count);
  const ideal = Math.sqrt((1.5 * count * (meanHeight + gap)) / (sizes.nodeWidth + gap));
  return Math.max(1, Math.min(count, Math.round(ideal)));
}

/**
 * Where to put rectangles of different sizes: in rows from the top, each row
 * filled from the left up to `limit` wide, in the order given.
 */
export function packRows<T extends { width: number; height: number }>(items: readonly T[], limit: number, gapX: number, gapY: number): { at: Array<{ x: number; y: number }>; width: number; height: number } {
  const at: Array<{ x: number; y: number }> = [];
  let x = 0;
  let y = 0;
  let tall = 0;
  let width = 0;
  for (const item of items) {
    if (x > 0 && x + item.width > limit) {
      y += tall + gapY;
      x = 0;
      tall = 0;
    }
    at.push({ x, y });
    width = Math.max(width, x + item.width);
    tall = Math.max(tall, item.height);
    x += item.width + gapX;
  }
  return { at, width, height: items.length === 0 ? 0 : y + tall };
}

/** The parts of the map with no link between them, biggest first; an idea with no link is a part of one. */
export function linkedParts(keys: readonly string[], edges: readonly MapEdge[]): string[][] {
  const root = new Map(keys.map((key) => [key, key]));
  const find = (key: string): string => {
    let top = key;
    while (root.get(top) !== top) top = root.get(top)!;
    for (let at = key; at !== top;) {
      const next = root.get(at)!;
      root.set(at, top);
      at = next;
    }
    return top;
  };
  for (const edge of edges) {
    if (root.has(edge.from) && root.has(edge.to)) root.set(find(edge.from), find(edge.to));
  }
  const parts = new Map<string, string[]>();
  for (const key of keys) {
    const top = find(key);
    if (!parts.has(top)) parts.set(top, []);
    parts.get(top)!.push(key);
  }
  // Stable: parts of one size keep the order of their first ideas
  return [...parts.values()].sort((p, q) => q.length - p.length);
}

/** `part` inside a margin, as a whole map. */
export function withMargin(part: MapPart, margin: number): MapLayout {
  const moved = movePart(part, margin, margin);
  return { boxes: moved.boxes, lines: moved.lines, width: part.width + 2 * margin, height: part.height + 2 * margin };
}

/** Several parts as one, each moved to its place. */
export function joinParts(parts: readonly MapPart[], at: ReadonlyArray<{ x: number; y: number }>): MapPart {
  const moved = parts.map((part, i) => movePart(part, at[i].x, at[i].y));
  return {
    boxes: moved.flatMap((part) => part.boxes),
    lines: moved.flatMap((part) => part.lines),
    width: Math.max(0, ...moved.map((part, i) => at[i].x + part.width)),
    height: Math.max(0, ...moved.map((part, i) => at[i].y + part.height)),
  };
}

/**
 * Some ideas and the links among them as a layered drawing with its corner
 * at 0,0: linked parts side by side and below each other, loose ideas in a
 * block at the end.
 */
export function layeredBlock(
  keys: readonly string[],
  edges: readonly MapEdge[],
  heightOf: (key: string) => number,
  sizes: MapSizes,
  flow: MapFlow = 'right',
): MapPart {
  const known = new Set(keys);
  const inside = edges.filter((edge) => known.has(edge.from) && known.has(edge.to));
  const linked = new Set(inside.flatMap((edge) => [edge.from, edge.to]));
  const loose = keys.filter((key) => !linked.has(key));
  const drawings = linkedParts(keys.filter((key) => linked.has(key)), inside).map((part) => {
    const members = new Set(part);
    return layeredPart(part, inside.filter((edge) => members.has(edge.from)), heightOf, sizes, flow);
  });

  // Small parts share a row under the biggest one
  const partGap = sizes.gapX;
  const widest = Math.max(0, ...drawings.map((part) => part.width));
  const limit = Math.max(widest, 3 * sizes.nodeWidth + 2 * sizes.gapX);
  const packed = packRows(drawings, limit, partGap, partGap);
  const parts = [...drawings];
  const at = [...packed.at];
  if (loose.length > 0) {
    const mean = loose.reduce((sum, key) => sum + heightOf(key), 0) / loose.length;
    const across = drawings.length > 0
      ? Math.max(1, Math.floor((Math.max(packed.width, limit) + sizes.gapY) / (sizes.nodeWidth + sizes.gapY)))
      : gridColumns(loose.length, mean, sizes);
    parts.push(boxGrid(loose, heightOf, sizes, across));
    at.push({ x: 0, y: drawings.length > 0 ? packed.height + partGap : 0 });
  }
  return joinParts(parts, at);
}

/**
 * The whole map, layered: left to right (`flow` right, the default) or top
 * to bottom. Links to ideas that are not on the map are left out.
 */
export function layoutLayered(
  keys: readonly string[],
  edges: readonly MapEdge[],
  heightOf: (key: string) => number,
  sizes: MapSizes,
  flow: MapFlow = 'right',
): MapLayout {
  if (keys.length === 0) return { boxes: [], lines: [], width: 0, height: 2 * sizes.margin };
  return withMargin(layeredBlock(keys, edges, heightOf, sizes, flow), sizes.margin);
}
