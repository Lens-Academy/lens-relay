import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import type { IdeaGraph } from '../../lib/idea-map';

/** No more rows than this are listed; typing more narrows them down. */
const MOST = 30;

/**
 * "Goal concept": type part of a name, pick one from the list (arrow keys and
 * Enter, or a click). Escape empties the box. The box then holds the name of
 * the goal picked.
 */
export function WalkGoalBox({ graph, goal, onGoal }: {
  graph: IdeaGraph;
  goal: string | null;
  onGoal: (key: string | null) => void;
}) {
  const id = useId();
  const [typed, setTyped] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const value = typed ?? (goal ? graph.byKey.get(goal)?.name ?? '' : '');
  const found = useMemo(() => {
    const wanted = (typed ?? '').trim().toLowerCase();
    if (!wanted) return [];
    return graph.nodes
      .filter((node) => node.key.includes(wanted))
      .sort((a, b) => Number(b.key.startsWith(wanted)) - Number(a.key.startsWith(wanted)) || a.name.localeCompare(b.name))
      .slice(0, MOST);
  }, [graph, typed]);
  const listed = typed !== null && typed.trim() !== '';
  const at = Math.min(active, found.length - 1);
  const pick = (key: string) => {
    onGoal(key);
    setTyped(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (found.length === 0) return;
      e.preventDefault();
      setActive((at + (e.key === 'ArrowDown' ? 1 : found.length - 1)) % found.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (found[at]) pick(found[at].key);
    } else if (e.key === 'Escape') {
      if (!value) return;
      e.preventDefault();
      e.stopPropagation();
      setTyped(null);
      onGoal(null);
    }
  };

  return (
    <div className="relative">
      <input
        type="search"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={listed}
        aria-controls={`${id}-rows`}
        aria-activedescendant={listed && found[at] ? `${id}-row-${at}` : undefined}
        className="lens-input w-72"
        placeholder="Type the name of a concept"
        aria-label="Goal concept"
        autoComplete="off"
        value={value}
        onChange={(e) => {
          setTyped(e.target.value);
          setActive(0);
          if (goal !== null) onGoal(null);
        }}
        onBlur={() => setTyped(null)}
        onKeyDown={onKeyDown}
      />
      {listed && (
        <ul
          id={`${id}-rows`}
          role="listbox"
          aria-label="Concepts found"
          className="absolute left-0 top-full z-30 mt-1 max-h-72 w-80 overflow-y-auto rounded border border-gray-200 bg-white text-sm shadow-lg"
          data-testid="walk-goal-rows"
        >
          {found.map((node, i) => (
            <li
              key={node.key}
              id={`${id}-row-${i}`}
              role="option"
              aria-selected={i === at}
              className={`cursor-pointer break-words px-2 py-1 ${i === at ? 'bg-blue-600 text-white' : 'text-gray-700'}`}
              // The box keeps the focus: a press on a row must not blur it
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => { if (i !== at) setActive(i); }}
              onClick={() => pick(node.key)}
            >
              {node.name}
            </li>
          ))}
          {found.length === 0 && <li className="px-2 py-1 text-gray-500" role="presentation">No concept matches.</li>}
        </ul>
      )}
    </div>
  );
}
