/**
 * Made-up concept maps for the layout tests, and the checks every layout
 * has to pass (no box on another, no line through a box). The maps are the
 * same every time (a seeded generator) and shaped like a real course. Concepts belong to topics,
 * most links stay inside a topic, some reach back to an earlier one; names
 * run from one word to a whole sentence, so boxes differ in height.
 */
import { buildIdeaGraph, type IdeaFile, type IdeaGraph } from './idea-map';
import { wrappedLines, type MapBox, type MapEdge, type MapLayout, type MapLine } from './idea-map-layout';

const TERMS = [
  'Goodharting', 'Sharp left turn', 'Instrumental convergence', 'Corrigibility', 'Mesa-optimisation', 'Deceptive alignment',
  'Orthogonality thesis', 'Power-seeking', 'Reward hacking', 'Inner misalignment', 'Outer misalignment', 'Takeoff speeds',
  'Interpretability', 'Scalable oversight', 'Compute governance', 'Model evaluations', 'Situational awareness', 'Gradient hacking',
];
const SUBJECTS = [
  'Superintelligence alignment', 'Current AI', 'A system we cannot iterate on', 'Good looking model behaviour', 'The field',
  'A misaligned ASI', 'Local alignment work', 'An indefinite pause', 'Human evaluation', 'Training on behaviour',
  'A theory of change', 'The race between labs', 'Most alignment methods', 'An agent with any long-term goal',
];
const CLAIMS = [
  'is very hard (harder than it often seems!)', 'is grown, not built', 'gives us only one critical try',
  'is not proof that the system is safe', 'does not scale to ASI', 'would by default pursue goals nobody intended',
  'is not enough', 'needs extreme caution', 'has no scientific consensus behind it yet', 'will resist being switched off',
  'makes giving up a bad move', 'can be debated well', 'is currently not on track', 'depends on who you ask',
];

/** mulberry32: a small seeded random number generator. */
export function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FixtureOptions {
  /** Three concepts that require each other in a circle (default no). */
  cycle?: boolean;
  /** Concepts with no link at all (default about one in fifteen). */
  isolated?: number;
  seed?: number;
}

/** `count` concept files (plus, from 30 up, three that are named but not written). */
export function fixtureIdeas(count: number, { cycle = false, isolated = Math.round(count / 15), seed = 87 }: FixtureOptions = {}): IdeaFile[] {
  const rand = seeded(seed);
  const pick = <T,>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
  const names: string[] = [];
  const taken = new Set<string>();
  while (names.length < count) {
    let name = rand() < 0.3 ? pick(TERMS) : `${pick(SUBJECTS)} ${pick(CLAIMS)}`;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${name.replace(/ \(\d+\)$/, '')} (${n})`;
    taken.add(name.toLowerCase());
    names.push(name);
  }

  const linked = count - Math.min(isolated, Math.max(0, count - 2));
  // A topic is about twelve concepts on four levels; later topics start on later levels
  const topics = Math.max(1, Math.round(linked / 12));
  const depth = Math.max(3, Math.min(10, Math.round(linked / 14) + 2));
  const topicOf = Array.from({ length: linked }, (_, i) => Math.min(topics - 1, Math.floor((i * topics) / linked)));
  const firstOf = Array.from({ length: topics }, (_, topic) => topicOf.indexOf(topic));
  const sizeOf = Array.from({ length: topics }, (_, topic) => topicOf.filter((t) => t === topic).length);
  const levelOf = topicOf.map((topic, i) => {
    const start = Math.round((topic / Math.max(1, topics - 1)) * Math.max(0, depth - 4));
    return start + Math.floor(((i - firstOf[topic]) * Math.min(4, depth)) / sizeOf[topic]);
  });
  const requires: number[][] = names.map(() => []);
  const helpful: number[][] = names.map(() => []);
  const gaps: string[][] = names.map(() => []);
  for (let i = 1; i < linked; i++) {
    const before = levelOf.flatMap((level, j) => (level < levelOf[i] ? [j] : []));
    const own = before.filter((j) => topicOf[j] === topicOf[i]);
    const near = own.filter((j) => levelOf[j] === levelOf[i] - 1);
    const other = before.filter((j) => topicOf[j] !== topicOf[i]);
    const wanted = rand() < 0.5 ? 1 : rand() < 0.75 ? 2 : 3;
    for (let n = 0; n < wanted; n++) {
      // Mostly the level before in the own topic, now and then further back or another topic
      const from = own.length > 0 && (other.length === 0 || rand() < 0.88) ? (near.length > 0 && rand() < 0.8 ? near : own) : other;
      if (from.length === 0) break;
      const target = pick(from);
      if (!requires[i].includes(target)) requires[i].push(target);
    }
    if (rand() < 0.15 && before.length > 0) {
      const target = pick(before);
      if (!requires[i].includes(target)) helpful[i].push(target);
    }
  }
  if (count >= 30) {
    ['Basic probability', 'What a neural network is', 'Expected utility'].forEach((gap, g) => {
      gaps[Math.floor(linked / 3) + g * 5].push(gap);
      gaps[Math.floor(linked / 2) + g * 3].push(gap);
    });
  }
  if (cycle && linked >= 3) {
    const [a, b, c] = [linked - 3, linked - 2, linked - 1];
    requires[a].push(c);
    if (!requires[b].includes(a)) requires[b].push(a);
    if (!requires[c].includes(b)) requires[c].push(b);
  }

  return names.map((name, i) => ({
    name,
    docId: `fixture-${i}`,
    text: [
      '---',
      `id: 00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      `priority: ${rand() < 0.3 ? 'high' : rand() < 0.6 ? 'medium' : 'low'}`,
      '---',
      `Explain: ${name}.`,
      '',
      '## Requires',
      ...requires[i].map((r) => `- [[${names[r]}]]`),
      ...gaps[i].map((gap) => `- [[${gap}]]`),
      '',
      '## Helpful first',
      ...helpful[i].map((r) => `- [[${names[r]}]]`),
      '',
    ].join('\n'),
  }));
}

/** The made-up map of `count` concepts as the drawing gets it: keys, links, and a height per box (one to four lines of name). */
export function fixtureMap(count: number, options: FixtureOptions = {}): { graph: IdeaGraph; keys: string[]; edges: MapEdge[]; heightOf: (key: string) => number } {
  const graph = buildIdeaGraph(fixtureIdeas(count, options));
  const edges = graph.nodes.flatMap((node) => [
    ...node.requires.map((from) => ({ from, to: node.key, helpful: false })),
    ...node.helpful.map((from) => ({ from, to: node.key, helpful: true })),
  ]);
  const heightOf = (key: string) => 10 + 14 * wrappedLines(graph.byKey.get(key)?.name ?? key, 26);
  return { graph, keys: graph.nodes.map((node) => node.key), edges, heightOf };
}

type Point = readonly [number, number];

/**
 * The points an SVG path (M, L, Q and C with absolute numbers) goes through:
 * its corners, and a curve as `steps` short stretches.
 */
export function pathPoints(d: string, steps = 8): Point[] {
  const points: Point[] = [];
  for (const [, command, rest] of d.matchAll(/([MLQC])([^MLQC]*)/g)) {
    const numbers = rest.trim().split(/[\s,]+/).map(Number);
    const given: Point[] = [];
    for (let i = 0; i + 1 < numbers.length; i += 2) given.push([numbers[i], numbers[i + 1]]);
    if (command === 'M' || command === 'L') {
      points.push(...given);
      continue;
    }
    const control = [points[points.length - 1], ...given];
    for (let step = 1; step <= steps; step++) {
      // De Casteljau: the point a share `t` along the curve
      let level = control;
      while (level.length > 1) level = level.slice(1).map((p, i) => [level[i][0] + (p[0] - level[i][0]) * (step / steps), level[i][1] + (p[1] - level[i][1]) * (step / steps)] as const);
      points.push(level[0]);
    }
  }
  return points;
}

/** Pairs of boxes that overlap or stand nearer than `gap` to each other. */
export function crowdedBoxes(boxes: readonly MapBox[], nodeWidth: number, gap = 0): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  boxes.forEach((p, i) => {
    for (const q of boxes.slice(i + 1)) {
      const apartX = Math.max(p.x, q.x) - Math.min(p.x, q.x) - nodeWidth;
      const apartY = p.y < q.y ? q.y - p.y - p.height : p.y - q.y - q.height;
      if (apartX < gap - 0.01 && apartY < gap - 0.01) pairs.push([p.key, q.key]);
    }
  });
  return pairs;
}

/** Lines that go through a box (nearer than `inset` inside it does not count: a line ends on a border). */
export function linesThroughBoxes(layout: Pick<MapLayout, 'boxes' | 'lines'>, nodeWidth: number, inset = 1): Array<{ line: string; box: string }> {
  const found: Array<{ line: string; box: string }> = [];
  for (const line of layout.lines) {
    const points = pathPoints(line.d);
    for (const box of layout.boxes) {
      const through = points.slice(1).some((to, i) => {
        const from = points[i];
        // Sampled every 2 px or so along the stretch
        const count = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / 2));
        for (let n = 0; n <= count; n++) {
          const x = from[0] + ((to[0] - from[0]) * n) / count;
          const y = from[1] + ((to[1] - from[1]) * n) / count;
          if (x > box.x + inset && x < box.x + nodeWidth - inset && y > box.y + inset && y < box.y + box.height - inset) return true;
        }
        return false;
      });
      if (through) found.push({ line: `${line.from} > ${line.to}`, box: box.key });
    }
  }
  return found;
}

/** Which side of `box` the point is on (within half a pixel), or null. */
export function sideOf(point: Point, box: MapBox, nodeWidth: number): 'left' | 'right' | 'top' | 'bottom' | null {
  const [x, y] = point;
  const withinY = y >= box.y - 0.5 && y <= box.y + box.height + 0.5;
  const withinX = x >= box.x - 0.5 && x <= box.x + nodeWidth + 0.5;
  if (withinY && Math.abs(x - box.x) <= 0.5) return 'left';
  if (withinY && Math.abs(x - box.x - nodeWidth) <= 0.5) return 'right';
  if (withinX && Math.abs(y - box.y) <= 0.5) return 'top';
  if (withinX && Math.abs(y - box.y - box.height) <= 0.5) return 'bottom';
  return null;
}

/**
 * Pairs of lines that run on top of each other: two straight stretches,
 * level or upright, less than `apart` from each other for more than `along`.
 */
export function linesOnTop(lines: readonly MapLine[], apart = 1, along = 6): Array<[string, string]> {
  const stretches = lines.flatMap((line, index) => {
    const points = pathPoints(line.d, 1);
    return points.slice(1).flatMap((to, i) => {
      const from = points[i];
      const level = Math.abs(from[1] - to[1]) < 0.01;
      const upright = Math.abs(from[0] - to[0]) < 0.01;
      if (level === upright) return [];
      const [at, lo, hi] = level ? [from[1], Math.min(from[0], to[0]), Math.max(from[0], to[0])] : [from[0], Math.min(from[1], to[1]), Math.max(from[1], to[1])];
      return [{ index, level, at, lo, hi }];
    });
  });
  const pairs = new Set<string>();
  stretches.forEach((p, i) => {
    for (const q of stretches.slice(i + 1)) {
      if (p.index === q.index || p.level !== q.level || Math.abs(p.at - q.at) >= apart) continue;
      if (Math.min(p.hi, q.hi) - Math.max(p.lo, q.lo) > along) pairs.add(`${Math.min(p.index, q.index)} ${Math.max(p.index, q.index)}`);
    }
  });
  const name = (index: string) => `${lines[Number(index)].from} > ${lines[Number(index)].to}`;
  return [...pairs].map((pair) => pair.split(' ').map(name) as [string, string]);
}
