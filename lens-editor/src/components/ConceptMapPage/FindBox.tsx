import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { IdeaGraph } from '../../lib/idea-map';
import { pickKeys, type PickKeys } from './ideaLook';

/** No more rows than this are listed; typing more narrows them down. */
const MOST = 40;

/**
 * "Find a concept": what is typed dims or hides everything else in the views
 * (the page does that), and lists the concepts that match under the box.
 * Arrow down and up move through the list; Enter does what a click on that
 * concept does (`onGo`: open it, or pick it while a form is open), with Ctrl,
 * Cmd or Shift what that click does; Escape empties the box.
 */
export function FindBox({ graph, value, onChange, onGo, box }: {
  graph: IdeaGraph;
  value: string;
  onChange: (value: string) => void;
  /** Enter or a click on a row of the list. */
  onGo: (key: string, keys: PickKeys) => void;
  /** The input, for the page to put the focus into. */
  box: RefObject<HTMLInputElement | null>;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rows = useRef<HTMLUListElement>(null);

  const found = useMemo(() => {
    const wanted = value.trim().toLowerCase();
    if (!wanted) return [];
    // A name that starts with it comes before one that only holds it
    return graph.nodes
      .filter((node) => node.key.includes(wanted))
      .sort((a, b) => Number(b.key.startsWith(wanted)) - Number(a.key.startsWith(wanted)) || a.name.localeCompare(b.name));
  }, [graph, value]);
  const shown = open ? found.slice(0, MOST) : [];
  const at = Math.min(active, shown.length - 1);
  const listed = open && value.trim() !== '';

  // The row the arrows are on stays in sight
  useEffect(() => {
    rows.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [at]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!value.trim()) return;
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (shown.length > 0) setActive((at + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown[at]) onGo(shown[at].key, pickKeys(e));
      else if (value.trim()) setOpen(true);
    } else if (e.key === 'Escape') {
      if (!value) return;
      // Empties the box only: what is open on the page stays open
      e.preventDefault();
      e.stopPropagation();
      onChange('');
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <input
        ref={box}
        type="search"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={listed}
        aria-controls={`${id}-rows`}
        aria-activedescendant={shown[at] ? `${id}-row-${at}` : undefined}
        aria-keyshortcuts="/"
        className="lens-input w-44"
        placeholder="Find a concept"
        aria-label="Find a concept"
        title="Find a concept (press /). Arrow keys and Enter open one."
        autoComplete="off"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {listed && (
        <ul
          ref={rows}
          id={`${id}-rows`}
          role="listbox"
          aria-label="Concepts found"
          className="absolute left-0 top-full z-30 mt-1 max-h-72 w-72 overflow-y-auto rounded border border-gray-200 bg-white text-sm shadow-lg"
          data-testid="idea-find-rows"
        >
          {shown.map((node, i) => (
            <li
              key={node.key}
              id={`${id}-row-${i}`}
              role="option"
              aria-selected={i === at}
              className={`cursor-pointer break-words px-2 py-1 ${i === at ? 'bg-blue-600 text-white' : 'text-gray-700'}`}
              // The box keeps the focus: a press on a row must not blur it
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => { if (i !== at) setActive(i); }}
              onClick={(e) => onGo(node.key, { ...pickKeys(e), byKey: false })}
            >
              {node.name}
              {!node.written && <span className={`ml-1.5 text-xs ${i === at ? 'text-blue-100' : 'text-gray-400'}`}>Not written yet</span>}
            </li>
          ))}
          {found.length === 0 && <li className="px-2 py-1 text-gray-500" role="presentation">No concept matches.</li>}
          {found.length > MOST && (
            <li className="border-t border-gray-100 px-2 py-1 text-xs text-gray-400" role="presentation">
              {found.length - MOST} more: type more of the name.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
