import type { IdeaGraph, IdeaLinks, IdeaNode, Priority } from '../../lib/idea-map';

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

/** One of the four lists of the form. */
export type LinkList = keyof IdeaLinks;

/** What the creator is picking while a form is open: the ideas this one
 *  requires, and (in "Add concept" and "Edit concept") the ones it is needed for. */
export interface PickMarks {
  requires: ReadonlySet<string>;
  helpful: ReadonlySet<string>;
  neededFor?: ReadonlySet<string>;
  helpfulFor?: ReadonlySet<string>;
  /** The idea whose requirements are edited: it cannot be picked. */
  self: string | null;
}

/** The small word on a picked idea, or null. */
export function pickWord(marks: PickMarks | null, key: string): string | null {
  if (!marks) return null;
  if (marks.self === key) return 'This concept';
  if (marks.requires.has(key)) return LIST_LABEL.requires;
  if (marks.helpful.has(key)) return LIST_LABEL.helpful;
  if (marks.neededFor?.has(key)) return LIST_LABEL.neededFor;
  if (marks.helpfulFor?.has(key)) return LIST_LABEL.helpfulFor;
  return null;
}

/** How a click on an idea was made. */
export interface PickKeys {
  /** Shift was held: the "helpful" list of the two, while a form picks. */
  shift: boolean;
  /** Ctrl, Cmd or Shift was held: add it to, or take it out of, the selection of several. */
  toggle: boolean;
}

export const pickKeys = (e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): PickKeys => ({
  shift: e.shiftKey,
  toggle: e.shiftKey || e.ctrlKey || e.metaKey,
});

/** What each of the three views gets from the page. */
export interface IdeaViewProps {
  graph: IdeaGraph;
  /** The idea the side panel shows. */
  selected: string | null;
  /** The ideas selected to act on together (the bar above the views). */
  chosen: ReadonlySet<string>;
  marks: PickMarks | null;
  matches: ReadonlySet<string> | null;
  onPick: (key: string, keys: PickKeys) => void;
  /** Put these ideas into the selection of several, or take them out; left
   *  out where nothing can be selected (a link that cannot edit, an open form). */
  onChoose?: (keys: string[], on: boolean) => void;
}

/** An idea that is in the selection of several. */
export const CHOSEN_LOOK = 'outline outline-2 outline-offset-1 outline-blue-600';

/** "A", "A and B", "A, B and C". */
export function listed(names: readonly string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export const BUTTON = 'px-2 py-1 rounded border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed';
export const PRIMARY_BUTTON = 'px-3 py-1 rounded bg-blue-600 text-sm text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed';
export const DANGER_BUTTON = 'px-3 py-1 rounded bg-red-600 text-sm text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed';

/** The small grey word above a field of a form. */
export const FIELD_LABEL = 'mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-400';
export const LIST_LABEL: Record<LinkList, string> = { requires: 'Requires', helpful: 'Helpful first', neededFor: 'Needed for', helpfulFor: 'Helpful for' };
/** The list a shift-click adds to while `list` is the one clicks go to. */
export const SHIFT_LIST: Record<LinkList, LinkList> = { requires: 'helpful', helpful: 'helpful', neededFor: 'helpfulFor', helpfulFor: 'helpfulFor' };
