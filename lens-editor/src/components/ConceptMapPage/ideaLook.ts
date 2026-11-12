import type { IdeaNode, Picks, Priority } from '../../lib/idea-map';

/** The three priority colours, shared by the map, the steps and the legend. */
export const PRIORITY_LOOK: Record<Priority, string> = {
  high: 'border-amber-300 bg-amber-100 text-amber-900',
  medium: 'border-sky-300 bg-sky-50 text-sky-900',
  low: 'border-gray-300 bg-gray-50 text-gray-700',
};

export const PRIORITY_LABEL: Record<Priority, string> = { high: 'High', medium: 'Medium', low: 'Low' };

/** A "not written yet" idea: dashed and muted. */
export const UNWRITTEN_LOOK = 'border-dashed border-gray-400 bg-white text-gray-500';

/** How an idea's box looks: by priority; dashed when it has no file; a red
 *  edge when it is in a circle of requirements. */
export function ideaLook(node: IdeaNode): string {
  const look = node.written ? PRIORITY_LOOK[node.idea?.priority ?? 'medium'] : UNWRITTEN_LOOK;
  return node.inCycle ? `${look} !border-red-500 border-2` : look;
}

/** What hovering an idea says. */
export function ideaTitle(node: IdeaNode): string {
  const parts = [node.name];
  if (!node.written) parts.push('Not written yet');
  else if (node.idea) parts.push(`${PRIORITY_LABEL[node.idea.priority]} priority`);
  if (node.inCycle) parts.push('In a circle of requirements');
  return parts.join(' · ');
}

/** What the creator is picking as requirements while a form is open. */
export interface PickMarks {
  requires: ReadonlySet<string>;
  helpful: ReadonlySet<string>;
  /** The idea whose requirements are edited: it cannot be picked. */
  self: string | null;
}

/** The small word on a picked idea, or null. */
export function pickWord(marks: PickMarks | null, key: string): string | null {
  if (!marks) return null;
  if (marks.self === key) return 'This concept';
  if (marks.requires.has(key)) return 'Requires';
  if (marks.helpful.has(key)) return 'Helpful first';
  return null;
}

export const BUTTON = 'px-2 py-1 rounded border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed';
export const PRIMARY_BUTTON = 'px-3 py-1 rounded bg-blue-600 text-sm text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed';

/** The small grey word above a field of a form. */
export const FIELD_LABEL = 'mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-400';
export const LIST_LABEL: Record<keyof Picks, string> = { requires: 'Requires', helpful: 'Helpful first' };
