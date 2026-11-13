/**
 * The "organic" drawing: things that are linked stand near each other, with
 * no rows or columns. Used twice: for the concepts inside one group, and for
 * the groups themselves (as islands) on the page.
 *
 * `settle` moves rectangles step by step: each a little towards the ones it
 * is linked to and towards the middle, apart from the ones it would lie on.
 * It starts from the places it is given and uses no chance, so the same
 * input gives the same drawing. At the end no two rectangles are nearer
 * than the gap asked for.
 *
 * Pure.
 */
import type { MapBox, MapEdge, MapLine, MapSizes } from './idea-map-layout';
import { boxGrid, gridColumns, joinParts, type MapPart } from './idea-map-layered';

export interface Rect { x: number; y: number; width: number; height: number }
interface Size { width: number; height: number }
interface Point { x: number; y: number }
/** Between the rectangles `a` and `b` (places in the list), pulling with `weight`. */
export type Pull = readonly [a: number, b: number, weight: number];

/** A straight line from the border of one box to the border of another, along the line between their middles. */
export function straight(from: Rect, to: Rect): string {
  const [ax, ay, bx, by] = [from.x + from.width / 2, from.y + from.height / 2, to.x + to.width / 2, to.y + to.height / 2];
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return `M${ax},${ay} L${bx},${by}`;
  /** How far along the line the border of `box` is, from its middle. */
  const reach = (box: Rect) => Math.min(dx === 0 ? Infinity : box.width / 2 / Math.abs(dx), dy === 0 ? Infinity : box.height / 2 / Math.abs(dy));
  const round = (value: number) => Math.round(value * 10) / 10;
  const [s, e] = [reach(from), Math.max(reach(from), 1 - reach(to))];
  return `M${round(ax + dx * s)},${round(ay + dy * s)} L${round(ax + dx * e)},${round(ay + dy * e)}`;
}

/** Whether the straight line from `a` to `b` passes through `rect` grown by `pad`. */
export function crosses(a: Point, b: Point, rect: Rect, pad = 0): boolean {
  // Liang-Barsky: the part of the line inside the rectangle
  let [t0, t1] = [0, 1];
  const [dx, dy] = [b.x - a.x, b.y - a.y];
  const sides: Array<[number, number]> = [
    [-dx, a.x - (rect.x - pad)], [dx, rect.x + rect.width + pad - a.x],
    [-dy, a.y - (rect.y - pad)], [dy, rect.y + rect.height + pad - a.y],
  ];
  for (const [p, q] of sides) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return t1 - t0 > 1e-6;
}

export interface SettleOptions {
  /** The least room between two rectangles, sideways and up and down. */
  gapX: number;
  gapY: number;
  /** How often everything is moved. */
  rounds?: number;
  /** How much wider than tall the whole should come out (1: as it falls). */
  spread?: number;
  /** How much further two rectangles on each other may be pushed sideways than up or down (wide ones would else pile up into a tower). */
  sideways?: number;
  /** Links whose second end should stand to the right of the first (the order to read in). */
  flow?: boolean;
  /** Keep the rectangles off the straight lines between linked ones. */
  clear?: boolean;
}

/** Push apart every two rectangles (middles in `at`) that are nearer than the gaps; true when something moved. */
function apart(at: Point[], sizes: readonly Size[], gapX: number, gapY: number, sideways = 1): boolean {
  let moved = false;
  for (let i = 0; i < at.length; i++) {
    for (let j = i + 1; j < at.length; j++) {
      const dx = at[j].x - at[i].x;
      const dy = at[j].y - at[i].y;
      const overX = (sizes[i].width + sizes[j].width) / 2 + gapX - Math.abs(dx);
      const overY = (sizes[i].height + sizes[j].height) / 2 + gapY - Math.abs(dy);
      if (overX <= 1e-6 || overY <= 1e-6) continue;
      moved = true;
      // The shorter way out; the later one of two on the same spot goes right or down
      if (overX < overY * sideways) {
        const push = (overX / 2 + 0.01) * (dx < 0 ? -1 : 1);
        at[i].x -= push;
        at[j].x += push;
      } else {
        const push = (overY / 2 + 0.01) * (dy < 0 ? -1 : 1);
        at[i].y -= push;
        at[j].y += push;
      }
    }
  }
  return moved;
}

/** Move every rectangle that the straight line between two linked ones passes through a step off that line; true when one moved. */
function offLines(at: Point[], sizes: readonly Size[], pulls: readonly Pull[], step: number): boolean {
  let moved = false;
  for (const [a, b] of pulls) {
    const [dx, dy] = [at[b].x - at[a].x, at[b].y - at[a].y];
    const long = Math.hypot(dx, dy) || 1;
    for (let i = 0; i < at.length; i++) {
      if (i === a || i === b) continue;
      const rect = { x: at[i].x - sizes[i].width / 2, y: at[i].y - sizes[i].height / 2, ...sizes[i] };
      if (!crosses(at[a], at[b], rect, 6)) continue;
      // Square to the line, to the side the rectangle is on already; the two ends half as far the other way
      const side = (at[i].x - at[a].x) * -dy + (at[i].y - at[a].y) * dx >= 0 ? 1 : -1;
      const [px, py] = [(side * -dy) / long, (side * dx) / long];
      at[i].x += px * step;
      at[i].y += py * step;
      for (const end of [a, b]) {
        at[end].x -= (px * step) / 2;
        at[end].y -= (py * step) / 2;
      }
      moved = true;
    }
  }
  return moved;
}

/**
 * The middles of the rectangles `sizes`, started at `start`, after they have
 * settled: linked ones near each other, all of them as close to the middle
 * as the gaps allow.
 */
export function settle(sizes: readonly Size[], pulls: readonly Pull[], start: readonly Point[], { gapX, gapY, rounds = 300, spread = 1, sideways = 1, flow = false, clear = false }: SettleOptions): Point[] {
  const at = start.map((point) => ({ ...point }));
  const count = at.length;
  if (count < 2) return at;
  const weightOf = new Array<number>(count).fill(0);
  for (const [a, b, weight] of pulls) {
    weightOf[a] += weight;
    weightOf[b] += weight;
  }
  const reachX = sizes.reduce((sum, size) => sum + size.width, 0) / count + gapX;
  const reachY = sizes.reduce((sum, size) => sum + size.height, 0) / count + gapY;
  for (let round = 0; round < rounds; round++) {
    const heat = 1 - round / rounds;
    const move = at.map(() => ({ x: 0, y: 0 }));
    // Towards what it is linked to
    for (const [a, b, weight] of pulls) {
      const dx = at[b].x - at[a].x - (flow ? reachX * 0.9 : 0);
      const dy = at[b].y - at[a].y;
      move[a].x += (weight * dx) / (weightOf[a] + 1);
      move[a].y += (weight * dy) / (weightOf[a] + 1);
      move[b].x -= (weight * dx) / (weightOf[b] + 1);
      move[b].y -= (weight * dy) / (weightOf[b] + 1);
    }
    // Away from everything near (in box sizes, so wide boxes keep more room sideways)
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        const dx = (at[j].x - at[i].x) / reachX;
        const dy = (at[j].y - at[i].y) / reachY;
        const far = Math.max(dx * dx + dy * dy, 0.01);
        if (far > 16) continue;
        const push = 0.4 / far;
        move[i].x -= dx * push * reachX * 0.1;
        move[i].y -= dy * push * reachY * 0.1;
        move[j].x += dx * push * reachX * 0.1;
        move[j].y += dy * push * reachY * 0.1;
      }
    }
    // Towards the middle; more so up and down when the whole should come out wide
    const midX = at.reduce((sum, point) => sum + point.x, 0) / count;
    const midY = at.reduce((sum, point) => sum + point.y, 0) / count;
    at.forEach((point, i) => {
      point.x += heat * 0.5 * move[i].x + heat * 0.07 * (midX - point.x);
      point.y += heat * 0.5 * move[i].y + heat * 0.07 * spread * (midY - point.y);
    });
    // Off the lines between others: a line behind a box reads as a link to that box
    if (clear && round > rounds / 3) offLines(at, sizes, pulls, 6);
    for (let pass = 0; pass < 2; pass++) if (!apart(at, sizes, gapX, gapY, sideways)) break;
  }
  // Until nothing lies on anything: pushing apart, and when that goes round in circles, everything a little outwards
  for (let tries = 0; tries < 200; tries++) {
    let clear = false;
    for (let pass = 0; pass < 60 && !clear; pass++) clear = !apart(at, sizes, gapX, gapY, sideways);
    if (clear) break;
    const midX = at.reduce((sum, point) => sum + point.x, 0) / count;
    const midY = at.reduce((sum, point) => sum + point.y, 0) / count;
    for (const point of at) {
      point.x = midX + (point.x - midX) * 1.08;
      point.y = midY + (point.y - midY) * 1.08;
    }
  }
  return at;
}

/** Places on an oval, in the order given: where `settle` starts from. */
export function onOval(count: number, radiusX: number, radiusY: number): Point[] {
  return Array.from({ length: count }, (_, i) => {
    const angle = (2 * Math.PI * i) / Math.max(count, 1) - Math.PI;
    return { x: Math.round(radiusX * Math.cos(angle) * 10) / 10, y: Math.round(radiusY * Math.sin(angle) * 10) / 10 };
  });
}

/** Between two boxes of a group drawn organically. */
const BOX_GAP_X = 28;
const BOX_GAP_Y = 18;
/** How often a box that a line passes behind is moved out of its way. */
const CLEARINGS = 40;
/** Between two boxes of the rows of concepts with no link inside the group. */
const LOOSE_GAP = 16;

/**
 * Some concepts and the links among them, drawn organically, with the top
 * left corner at 0,0: straight lines from box to box, what comes first
 * rather to the left. A box that a line would pass behind is moved aside
 * where there is room. The concepts with no link to another of them have no
 * place that means anything: they stand in rows below.
 */
export function organicBlock(keys: readonly string[], edges: readonly MapEdge[], heightOf: (key: string) => number, sizes: MapSizes): MapPart {
  const known = new Set(keys);
  const inside = edges.filter((edge) => known.has(edge.from) && known.has(edge.to) && edge.from !== edge.to);
  const tied = new Set(inside.flatMap((edge) => [edge.from, edge.to]));
  const linked = keys.filter((key) => tied.has(key));
  const loose = keys.filter((key) => !tied.has(key));
  const index = new Map(linked.map((key, i) => [key, i]));
  const rects = linked.map((key) => ({ width: sizes.nodeWidth, height: heightOf(key) }));
  const pulls: Pull[] = inside.map((edge) => [index.get(edge.from)!, index.get(edge.to)!, edge.helpful ? 0.5 : 1]);
  const radius = Math.sqrt(linked.length);
  const at = settle(rects, pulls, onOval(linked.length, radius * 110, radius * 45), { gapX: BOX_GAP_X, gapY: BOX_GAP_Y, spread: 1.5, flow: true, clear: true });

  const rectAt = (i: number): Rect => ({ x: at[i].x - rects[i].width / 2, y: at[i].y - rects[i].height / 2, ...rects[i] });
  // What is still behind a line: off it, as long as that helps
  for (let clearing = 0; clearing < CLEARINGS; clearing++) {
    if (!offLines(at, rects, pulls, 10)) break;
    for (let pass = 0; pass < 80; pass++) if (!apart(at, rects, BOX_GAP_X, BOX_GAP_Y)) break;
  }
  for (let pass = 0; pass < 400; pass++) if (!apart(at, rects, BOX_GAP_X, BOX_GAP_Y)) break;

  const left = linked.length === 0 ? 0 : Math.min(...linked.map((_, i) => rectAt(i).x));
  const top = linked.length === 0 ? 0 : Math.min(...linked.map((_, i) => rectAt(i).y));
  const round = (value: number) => Math.round(value * 10) / 10;
  const boxes: MapBox[] = linked.map((key, i) => ({ key, column: 0, x: round(rectAt(i).x - left), y: round(rectAt(i).y - top), height: rects[i].height }));
  const boxRect = (i: number): Rect => ({ x: boxes[i].x, y: boxes[i].y, ...rects[i] });
  const lines: MapLine[] = inside.map((edge) => ({ ...edge, d: straight(boxRect(index.get(edge.from)!), boxRect(index.get(edge.to)!)) }));
  const drawn: MapPart = {
    boxes,
    lines,
    width: linked.length === 0 ? 0 : Math.max(...boxes.map((box) => box.x)) + sizes.nodeWidth,
    height: linked.length === 0 ? 0 : Math.max(...boxes.map((box) => box.y + box.height)),
  };
  if (loose.length === 0) return drawn;
  const mean = loose.reduce((sum, key) => sum + heightOf(key), 0) / loose.length;
  const perRow = linked.length > 0
    ? Math.max(2, Math.floor((drawn.width + LOOSE_GAP) / (sizes.nodeWidth + LOOSE_GAP)))
    : gridColumns(loose.length, mean, sizes, LOOSE_GAP);
  const grid = boxGrid(loose, heightOf, sizes, Math.min(perRow, loose.length), LOOSE_GAP);
  return joinParts([drawn, grid], [{ x: 0, y: 0 }, { x: 0, y: linked.length > 0 ? drawn.height + 2 * BOX_GAP_Y + 8 : 0 }]);
}

/**
 * Where the islands (rectangles of the sizes given, in the order to read
 * them in) go: those with many links between them near each other, none
 * nearer to another than `gap`. Top left corners, and the size of the whole.
 */
export function placeIslands(sizes: readonly Size[], pulls: readonly Pull[], gap: number): { at: Point[]; width: number; height: number } {
  if (sizes.length === 0) return { at: [], width: 0, height: 0 };
  const area = sizes.reduce((sum, size) => sum + (size.width + gap) * (size.height + gap), 0);
  const side = Math.sqrt(area);
  const place = (sideways: number) => {
    const mids = settle(sizes, pulls, onOval(sizes.length, side * 0.8, side * 0.5), { gapX: gap, gapY: gap, rounds: 400, spread: 1.6, sideways });
    const left = Math.min(...mids.map((mid, i) => mid.x - sizes[i].width / 2));
    const top = Math.min(...mids.map((mid, i) => mid.y - sizes[i].height / 2));
    const at = mids.map((mid, i) => ({ x: Math.round(mid.x - sizes[i].width / 2 - left), y: Math.round(mid.y - sizes[i].height / 2 - top) }));
    return {
      at,
      width: Math.max(...at.map((point, i) => point.x + sizes[i].width)),
      height: Math.max(...at.map((point, i) => point.y + sizes[i].height)),
    };
  };
  // Wide islands pushed apart the short way pile up into a tower, pushed sideways only into a ribbon: the
  // mix that fits a screen best
  const fits = (placed: { width: number; height: number }) => Math.min(16 / placed.width, 10 / placed.height);
  return [1, 1.2, 1.4, 1.7, 2, 2.5].map(place).reduce((best, next) => (fits(next) > fits(best) + 1e-9 ? next : best));
}
