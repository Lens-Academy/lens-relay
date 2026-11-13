/**
 * Which links of the concept map are drawn, and what a concept's chain is.
 * Pure.
 *
 *  - A link is "implied" when a chain of Requires says it already: with
 *    A → B → C, the link A → C adds nothing. Hiding those is the transitive
 *    reduction of Requires; a Helpful-first link is implied the same way.
 *  - The chain of a concept is everything it needs (and what those need, and
 *    so on) and everything that needs it.
 */
import type { MapEdge } from './idea-map-layout';

export const LINK_KINDS = [
  { key: 'all', label: 'Requires + Helpful first' },
  { key: 'requires', label: 'Requires only' },
] as const;
export type LinkKinds = (typeof LINK_KINDS)[number]['key'];

/** The concepts each concept leads to, by Requires links alone. */
function requiredBy(edges: readonly MapEdge[]): Map<string, string[]> {
  const next = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.helpful || edge.from === edge.to) continue;
    if (!next.has(edge.from)) next.set(edge.from, []);
    next.get(edge.from)!.push(edge.to);
  }
  return next;
}

/** Everything reached from `start` through `next` (`start` itself only when a circle leads back to it): from
 *  what follows it, or from `first`; never by way of `around`. */
function reached(start: string, next: ReadonlyMap<string, readonly string[]>, first: readonly string[] = next.get(start) ?? [], around?: string): Set<string> {
  const seen = new Set<string>();
  const todo = [...first];
  while (todo.length > 0) {
    const key = todo.pop()!;
    if (seen.has(key) || key === around) continue;
    seen.add(key);
    for (const other of next.get(key) ?? []) if (!seen.has(other)) todo.push(other);
  }
  return seen;
}

/**
 * The links a chain of Requires already says: a Requires link A → C when
 * there is another way from A to C through Requires links, and a Helpful
 * first link A → C when Requires links lead from A to C at all. A link from a
 * concept that is in a circle of requirements is never implied. What is left
 * leads from every concept to all it led to before.
 */
export function impliedLinks(edges: readonly MapEdge[]): Set<MapEdge> {
  const next = requiredBy(edges);
  const from = new Map<string, Set<string>>();
  const reach = (key: string) => {
    if (!from.has(key)) from.set(key, reached(key, next));
    return from.get(key)!;
  };
  const implied = new Set<MapEdge>();
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    if (edge.helpful) {
      if (reach(edge.from).has(edge.to)) implied.add(edge);
      continue;
    }
    // From a concept in a circle of requirements: leave it (of two such links, each would be the other's way round)
    if (reach(edge.from).has(edge.from)) continue;
    // Another way there: by one of the other concepts that need `from`, not coming back through `from`
    const others = (next.get(edge.from) ?? []).filter((other) => other !== edge.to);
    if (others.length > 0 && reached(edge.from, next, others, edge.from).has(edge.to)) implied.add(edge);
  }
  return implied;
}

export interface LinkChoice {
  links: LinkKinds;
  hideImplied: boolean;
}

/** The links to draw: Helpful first left out when only Requires is wanted, implied ones when they are hidden. */
export function shownLinks<T extends MapEdge>(edges: readonly T[], { links, hideImplied }: LinkChoice): T[] {
  const kinds = links === 'requires' ? edges.filter((edge) => !edge.helpful) : edges;
  if (!hideImplied) return [...kinds];
  const implied = impliedLinks(kinds);
  return kinds.filter((edge) => !implied.has(edge));
}

export interface Chain {
  /** Everything the concept builds on, near and far. */
  before: Set<string>;
  /** Everything that builds on it. */
  after: Set<string>;
}

/** The chain of `key` through `edges` (give it the links that are drawn). */
export function chainOf(key: string, edges: readonly MapEdge[]): Chain {
  const forward = new Map<string, string[]>();
  const back = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    if (!forward.has(edge.from)) forward.set(edge.from, []);
    forward.get(edge.from)!.push(edge.to);
    if (!back.has(edge.to)) back.set(edge.to, []);
    back.get(edge.to)!.push(edge.from);
  }
  return { before: reached(key, back), after: reached(key, forward) };
}

/** Whether the link `edge` is part of `chain` of the concept `key`: on a way to it, or on a way on from it. */
export function inChain(edge: MapEdge, key: string, chain: Chain): boolean {
  const before = (other: string) => other === key || chain.before.has(other);
  const after = (other: string) => other === key || chain.after.has(other);
  return (before(edge.from) && before(edge.to)) || (after(edge.from) && after(edge.to));
}
