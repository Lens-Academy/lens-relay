/**
 * The orders in which the "Walk through" view of the concept map shows the
 * concepts one at a time, and what it shows of the topics. Pure, and every
 * function gives the same answer for the same graph.
 *
 *  - Foundations first: every concept once, each after what it requires, one
 *    topic after the other as far as the requirements allow (`foundationsWalk`).
 *  - Topic by topic: the same order inside one topic (`topicWalk`).
 *  - Backwards from a goal: the goal, then what it requires, depth first (`goalWalk`).
 *  - Follow my curiosity: no order; `proposeNext` says where to go when asked.
 */
import type { IdeaGraph, IdeaNode } from './idea-map';
import type { MapEdge } from './idea-map-layout';

export const WALK_ORDERS = [
  { key: 'foundations', label: 'Foundations first', hint: 'Every concept once, each after what it requires, one topic after the other.' },
  { key: 'topics', label: 'Topic by topic', hint: 'Pick a topic, walk through its concepts, come back for the next one.' },
  { key: 'goal', label: 'Backwards from a goal', hint: 'Pick a concept: the walk is that concept, then everything it requires.' },
  { key: 'curiosity', label: 'Follow my curiosity', hint: 'No fixed order: move by clicking what a concept builds on or leads to.' },
] as const;
export type WalkOrder = (typeof WALK_ORDERS)[number]['key'];

export const isWalkOrder = (value: unknown): value is WalkOrder => WALK_ORDERS.some((order) => order.key === value);

/** Some concepts that belong together: a topic of the author, or a cluster found from the links. */
export interface WalkGroup {
  key: string;
  label: string;
  members: string[];
  /** Which of the colours for topics it has. */
  tone?: number;
}

/** One concept of a walk. */
export interface WalkStep {
  key: string;
  /** Foundations first: the concept (of the topic being walked) that needs this one, which is of another topic. */
  pulledFor?: string;
  /** Backwards from a goal: the concept this one is needed for on the way from the goal; null for the goal. */
  parent?: string | null;
  /** Backwards from a goal: reached by a Helpful first link. */
  helpful?: boolean;
}

/** Every link of the graph, from what comes first to what needs it; a pair linked both ways counts as Requires. */
export function walkEdges(graph: IdeaGraph): MapEdge[] {
  return graph.nodes.flatMap((node) => {
    const requires = [...new Set(node.requires)].filter((key) => key !== node.key && graph.byKey.has(key));
    const helpful = [...new Set(node.helpful)].filter((key) => key !== node.key && graph.byKey.has(key) && !requires.includes(key));
    return [
      ...requires.map((from) => ({ from, to: node.key, helpful: false })),
      ...helpful.map((from) => ({ from, to: node.key, helpful: true })),
    ];
  });
}

/** How many other concepts build on this one. */
const weight = (node: IdeaNode) => node.neededFor.length + node.helpfulFor.length / 2;

const byName = (a: IdeaNode, b: IdeaNode) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * What must be shown before each concept: everything it Requires, and what is
 * Helpful first where that makes no circle (a Helpful first link that would
 * put a concept before something it is required for is left out).
 */
export function walkPrerequisites(graph: IdeaGraph): Map<string, string[]> {
  const before = new Map<string, string[]>();
  for (const node of graph.nodes) {
    before.set(node.key, [...new Set(node.requires)].filter((key) => key !== node.key && graph.byKey.has(key)));
  }
  /** Whether `start` needs `target` first, by the links taken so far. */
  const needs = (start: string, target: string) => {
    const seen = new Set<string>();
    const todo = [start];
    while (todo.length > 0) {
      const key = todo.pop()!;
      if (key === target) return true;
      if (seen.has(key)) continue;
      seen.add(key);
      todo.push(...(before.get(key) ?? []));
    }
    return false;
  };
  for (const node of graph.nodes) {
    const list = before.get(node.key)!;
    for (const key of node.helpful) {
      if (key === node.key || !graph.byKey.has(key) || list.includes(key)) continue;
      if (!needs(key, node.key)) list.push(key);
    }
  }
  return before;
}

/**
 * The concepts of `sequence` (lists of keys, one list after the other), each
 * once, each after its prerequisites among them.
 *
 * Inside a list the next concept is one whose prerequisites are all shown,
 * and of those the one whose latest prerequisite was shown last: so the walk
 * follows a chain (a concept, then something that builds on it) before it
 * starts on the next foundation. When none is free (a prerequisite is in a
 * later list, or the concepts require each other in a circle), the one that
 * misses least is taken and what it misses is shown right before it: a
 * prerequisite from another list is marked `pulledFor`. In a circle the link
 * that closes it is the one not kept.
 */
function ordered(graph: IdeaGraph, sequence: ReadonlyArray<readonly string[]>): WalkStep[] {
  const listOf = new Map<string, number>();
  sequence.forEach((keys, index) => {
    for (const key of keys) if (graph.byKey.has(key) && !listOf.has(key)) listOf.set(key, index);
  });
  const all = walkPrerequisites(graph);
  const before = (key: string) => (all.get(key) ?? []).filter((other) => listOf.has(other));
  const at = new Map<string, number>();
  const open = new Set<string>();
  const steps: WalkStep[] = [];
  const node = (key: string) => graph.byKey.get(key)!;
  /** Earlier steps first, then what more builds on, then by name. */
  const first = (a: string, b: string) => node(a).step - node(b).step || weight(node(b)) - weight(node(a)) || byName(node(a), node(b));
  const missing = (key: string) => before(key).filter((other) => !at.has(other));

  const show = (key: string, list: number, pulledFor?: string) => {
    open.add(key);
    for (const other of missing(key).sort(first)) {
      if (!open.has(other) && !at.has(other)) show(other, list, key);
    }
    open.delete(key);
    at.set(key, steps.length);
    steps.push(listOf.get(key) !== list && pulledFor !== undefined ? { key, pulledFor } : { key });
  };

  sequence.forEach((keys, list) => {
    let left = [...new Set(keys)].filter((key) => listOf.get(key) === list && !at.has(key));
    while (left.length > 0) {
      const rated = left.map((key) => ({
        key,
        missing: missing(key).length,
        latest: Math.max(-1, ...before(key).map((other) => at.get(other) ?? -1)),
      }));
      rated.sort((a, b) => (
        a.missing === 0 && b.missing === 0 ? b.latest - a.latest : a.missing - b.missing
      ) || first(a.key, b.key));
      show(rated[0].key, list);
      left = left.filter((key) => !at.has(key));
    }
  });
  return steps;
}

/**
 * Foundations first: every concept of the groups once, each after everything
 * it Requires (and what is Helpful first, where that makes no circle), one
 * group after the other in the order given (`readingOrder`). A prerequisite
 * from a later group is shown right before the concept that needs it, marked
 * `pulledFor`. Concepts that require each other in a circle all appear.
 */
export function foundationsWalk(graph: IdeaGraph, groups: readonly WalkGroup[]): WalkStep[] {
  const grouped = new Set(groups.flatMap((group) => group.members));
  const rest = graph.nodes.filter((node) => !grouped.has(node.key)).map((node) => node.key);
  return ordered(graph, [...groups.map((group) => group.members), ...(rest.length > 0 ? [rest] : [])]);
}

/** Topic by topic: the concepts of one group in the order of `foundationsWalk`; what they need from other groups is not a step. */
export function topicWalk(graph: IdeaGraph, group: WalkGroup): WalkStep[] {
  return ordered(graph, [group.members]);
}

/**
 * Backwards from a goal: the goal, then what it requires, depth first (a
 * concept, then what that one requires, before the goal's next requirement),
 * each concept once. With `helpful` the Helpful first links are followed too,
 * after the Requires of each concept.
 */
export function goalWalk(graph: IdeaGraph, goal: string, { helpful = false }: { helpful?: boolean } = {}): WalkStep[] {
  if (!graph.byKey.has(goal)) return [];
  const steps: WalkStep[] = [];
  const seen = new Set<string>();
  // Iterative: a long chain must not overflow the call stack
  const todo: WalkStep[] = [{ key: goal, parent: null }];
  while (todo.length > 0) {
    const step = todo.pop()!;
    if (seen.has(step.key)) continue;
    seen.add(step.key);
    steps.push(step);
    const node = graph.byKey.get(step.key)!;
    const next: WalkStep[] = [
      ...node.requires.map((key) => ({ key, parent: step.key })),
      ...(helpful ? node.helpful.map((key) => ({ key, parent: step.key, helpful: true })) : []),
    ].filter((other) => graph.byKey.has(other.key) && !seen.has(other.key));
    // The first requirement is the next step
    for (let i = next.length - 1; i >= 0; i--) todo.push(next[i]);
  }
  return steps;
}

/** The way from the goal to a concept of its walk: goal first. */
export function goalPath(steps: readonly WalkStep[], key: string): string[] {
  const parent = new Map(steps.map((step) => [step.key, step.parent ?? null]));
  const path: string[] = [];
  for (let at: string | null = parent.has(key) ? key : null; at !== null && !path.includes(at); at = parent.get(at) ?? null) path.push(at);
  return path.reverse();
}

/** The links between two groups, in the direction most of them go. */
export interface GroupLink {
  /** The group whose concepts come first. */
  from: string;
  /** The group that builds on it. */
  to: string;
  /** Links that way. */
  count: number;
  /** Links the other way. */
  back: number;
}

/** Group by group: how many links lead from each to each. */
function linkCounts(graph: IdeaGraph, groups: readonly WalkGroup[], helpfulWeight = 1): Map<string, Map<string, number>> {
  const groupOf = new Map<string, string>();
  for (const group of groups) for (const key of group.members) if (!groupOf.has(key)) groupOf.set(key, group.key);
  const counts = new Map<string, Map<string, number>>(groups.map((group) => [group.key, new Map()]));
  for (const edge of walkEdges(graph)) {
    const from = groupOf.get(edge.from);
    const to = groupOf.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    const row = counts.get(from)!;
    row.set(to, (row.get(to) ?? 0) + (edge.helpful ? helpfulWeight : 1));
  }
  return counts;
}

/** One entry per pair of groups with a link between them, in the order of the groups. */
export function groupLinks(graph: IdeaGraph, groups: readonly WalkGroup[]): GroupLink[] {
  const counts = linkCounts(graph, groups);
  const links: GroupLink[] = [];
  groups.forEach((a, i) => {
    for (const b of groups.slice(i + 1)) {
      const forth = counts.get(a.key)!.get(b.key) ?? 0;
      const back = counts.get(b.key)!.get(a.key) ?? 0;
      if (forth + back === 0) continue;
      links.push(forth >= back ? { from: a.key, to: b.key, count: forth, back } : { from: b.key, to: a.key, count: back, back: forth });
    }
  });
  return links;
}

/**
 * The groups in reading order: a group after the groups it builds on, as far
 * as that goes (two topics usually build on each other a little). The order
 * is the one with the least weight of links pointing backwards that moving
 * one group at a time finds, starting from "the group that needs least of
 * what is left comes next".
 */
export function readingOrder(graph: IdeaGraph, groups: readonly WalkGroup[]): WalkGroup[] {
  const counts = linkCounts(graph, groups, 0.5);
  const link = (from: string, to: string) => counts.get(from)?.get(to) ?? 0;
  const meanStep = new Map(groups.map((group) => {
    const steps = group.members.map((key) => graph.byKey.get(key)?.step ?? 1);
    return [group.key, steps.reduce((sum, step) => sum + step, 0) / Math.max(1, steps.length)];
  }));
  const tie = (a: WalkGroup, b: WalkGroup) => meanStep.get(a.key)! - meanStep.get(b.key)! || a.label.localeCompare(b.label) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

  let left = [...groups].sort(tie);
  let order: WalkGroup[] = [];
  while (left.length > 0) {
    const rated = left.map((group) => ({
      group,
      // What it needs of the groups still to come, less what those need of it
      owes: left.reduce((sum, other) => sum + link(other.key, group.key) - link(group.key, other.key), 0),
    }));
    rated.sort((a, b) => a.owes - b.owes || tie(a.group, b.group));
    order.push(rated[0].group);
    left = left.filter((group) => group !== rated[0].group);
  }

  /** The weight of the links from a later group to an earlier one. */
  const backwards = (list: readonly WalkGroup[]) => {
    let sum = 0;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) sum += link(list[j].key, list[i].key);
    return sum;
  };
  let least = backwards(order);
  for (let round = 0, better = true; better && round < 50; round++) {
    better = false;
    for (let from = 0; from < order.length; from++) {
      for (let to = 0; to < order.length; to++) {
        if (to === from) continue;
        const moved = [...order];
        moved.splice(to, 0, ...moved.splice(from, 1));
        const sum = backwards(moved);
        if (sum < least - 1e-9) {
          order = moved;
          least = sum;
          better = true;
        }
      }
    }
  }
  return order;
}

/** The concepts of a group that most others require: what the group is about, in two or three names. */
export function mostRequired(graph: IdeaGraph, members: readonly string[], most = 3): IdeaNode[] {
  const nodes = members.flatMap((key) => graph.byKey.get(key) ?? []);
  return [...nodes].sort((a, b) => weight(b) - weight(a) || a.step - b.step || byName(a, b)).slice(0, most);
}

/** Where "Follow my curiosity" would go next, and why. */
export interface Proposal {
  key: string;
  why: string;
}

const others = (count: number) => (count === 1 ? '1 other' : `${count} others`);

/**
 * The next concept for someone following their curiosity: a neighbour of
 * `current` that is not seen yet (first what `current` requires, then what
 * only waited for `current`, then what else it leads to, then the Helpful
 * first links), else the nearest concept not seen yet, else (nothing linked
 * is left) the earliest one. Null when everything is seen.
 */
export function proposeNext(graph: IdeaGraph, current: string | null, seen: ReadonlySet<string>): Proposal | null {
  const fresh = (key: string) => key !== current && !seen.has(key) && graph.byKey.has(key);
  const best = (keys: readonly string[]) => keys.map((key) => graph.byKey.get(key)!).sort((a, b) => weight(b) - weight(a) || a.step - b.step || byName(a, b))[0];
  const tail = (node: IdeaNode) => (node.neededFor.length > 0 ? ` · needed for ${others(node.neededFor.length)}` : '');
  const here = current === null ? undefined : graph.byKey.get(current);

  if (here) {
    const ready = (key: string) => graph.byKey.get(key)!.requires.every((other) => other === here.key || seen.has(other));
    const leadsTo = here.neededFor.filter(fresh);
    const ranks: Array<[string[], string]> = [
      [here.requires.filter(fresh), `"${here.name}" requires it`],
      [leadsTo.filter(ready), `builds on "${here.name}" (all it requires is seen)`],
      [leadsTo, `builds on "${here.name}"`],
      [here.helpful.filter(fresh), `helpful before "${here.name}"`],
      [here.helpfulFor.filter(fresh), `"${here.name}" helps with it`],
    ];
    for (const [keys, reason] of ranks) {
      if (keys.length === 0) continue;
      const node = best(keys);
      return { key: node.key, why: `Not seen yet · ${reason}${tail(node)}` };
    }
    // The nearest one, by links in either direction
    let ring = [here.key];
    const reached = new Set(ring);
    for (let far = 1; ring.length > 0; far++) {
      const next: string[] = [];
      for (const key of ring) {
        const node = graph.byKey.get(key)!;
        for (const other of [...node.requires, ...node.neededFor, ...node.helpful, ...node.helpfulFor]) {
          if (reached.has(other) || !graph.byKey.has(other)) continue;
          reached.add(other);
          next.push(other);
        }
      }
      const found = next.filter(fresh);
      if (found.length > 0) {
        const node = best(found);
        return { key: node.key, why: `The nearest concept not seen yet · ${far} links from "${here.name}"${tail(node)}` };
      }
      ring = next;
    }
  }
  const left = graph.nodes.filter((node) => fresh(node.key));
  if (left.length === 0) return null;
  const node = [...left].sort((a, b) => a.step - b.step || weight(b) - weight(a) || byName(a, b))[0];
  return { key: node.key, why: here ? `Not seen yet · not linked to "${here.name}"${tail(node)}` : `Not seen yet${node.requires.length === 0 ? ' · requires nothing first' : ''}${tail(node)}` };
}

/** What a concept is remembered by once it was seen: the `id` of its file, else its key. */
export const seenId = (node: IdeaNode): string => node.idea?.id ?? node.key;

/** What the browser kept of the concepts seen. */
export function parseSeen(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}
