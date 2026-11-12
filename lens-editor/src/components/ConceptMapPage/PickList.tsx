import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ideaKey, pickChoices, type Dependents, type IdeaGraph, type PickOption, type Picks } from '../../lib/idea-map';
import { LIST_LABEL, type LinkList } from './ideaLook';

/** What "Needed for" and "Helpful for" do, said under their names. */
const LIST_NOTE: Partial<Record<LinkList, string>> = {
  neededFor: 'This concept goes into the Requires of each.',
  helpfulFor: 'This concept goes into the Helpful first of each.',
};

/**
 * One list of picked ideas: its names as chips, and a combobox to add by
 * typing. The list under the box opens while typing (or with an arrow key);
 * the arrows move the highlight, Enter picks it, Escape closes the list,
 * Backspace in the empty box takes the last chip out. Under "Requires" and
 * "Helpful first" a name no idea has is offered as a new idea: the link is
 * written, and the map shows it as "not written yet". "Needed for" and
 * "Helpful for" take written ideas only: the link goes into their file.
 */
export function PickList({ list, picks, graph, ownNames, clicksHere = false, footnote, onActivate, onToggle }: {
  list: LinkList;
  picks: Picks & Partial<Dependents>;
  graph: IdeaGraph;
  /** The names of the idea the lists belong to: it is never offered. */
  ownNames: readonly string[];
  /** A click on an idea in the view next to the form adds to this list. */
  clicksHere?: boolean;
  /** One more grey line under the box. */
  footnote?: string | null;
  /** Make this the list such clicks add to (a click into its box does). */
  onActivate?: () => void;
  /** Add a name to this list, or take it out. */
  onToggle: (name: string) => void;
}) {
  const id = useId();
  const box = useRef<HTMLInputElement>(null);
  const rows = useRef<HTMLUListElement>(null);
  const [typed, setTyped] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const names = picks[list] ?? [];
  // The link to a picked idea goes into this idea's file, the other way into theirs
  const writtenOnly = list === 'neededFor' || list === 'helpfulFor';
  const { options, problem } = pickChoices(typed, graph.nodes, picks, ownNames, 50, writtenOnly);
  const shown = open ? options : [];
  const at = Math.min(active, shown.length - 1);

  // The highlighted row stays in sight in a long list
  useEffect(() => {
    rows.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [at, shown.length]);

  const pick = (option: PickOption) => {
    onToggle(option.name);
    setTyped('');
    setOpen(false);
    setActive(0);
    // The next one can be typed at once
    box.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const down = e.key === 'ArrowDown';
      if (shown.length === 0) {
        setOpen(true);
        setActive(down ? 0 : options.length - 1);
      } else {
        setActive((at + (down ? 1 : shown.length - 1)) % shown.length);
      }
    } else if (e.key === 'Enter') {
      // Ctrl/Cmd+Enter saves the form; a plain Enter here never does
      if (e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      if (shown[at]) pick(shown[at]);
      else if (typed.trim()) setOpen(true);
    } else if (e.key === 'Escape') {
      if (shown.length === 0) return;
      // Closes the list only, not the form
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === 'Backspace' && typed === '' && names.length > 0) {
      e.preventDefault();
      onToggle(names[names.length - 1]);
    }
  };

  const said = typed.trim() !== '' ? problem
    : open && options.length === 0 ? (writtenOnly ? 'No written concept left to pick.' : 'No concept left to pick. Type a name to add a new one.')
    : null;
  const note = LIST_NOTE[list];

  return (
    <div className="mt-4" data-list={list} data-active={clicksHere || undefined}>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2">
        <label htmlFor={id} className="text-xs font-semibold uppercase tracking-wide text-gray-400">{LIST_LABEL[list]}</label>
        {clicksHere && (
          <span className="rounded bg-indigo-600 px-1.5 py-px text-[10px] font-medium text-white" data-testid="idea-click-here">Map clicks add here</span>
        )}
      </div>
      {note && <p id={`${id}-note`} className="mb-1.5 text-xs text-gray-400">{note}</p>}
      {names.length > 0 && (
        <ul className="mb-1.5 flex flex-wrap gap-1" aria-label={`${LIST_LABEL[list]}: picked`}>
          {names.map((name) => {
            const written = graph.byKey.get(ideaKey(name))?.written ?? false;
            return (
              <li
                key={name}
                data-chip={written ? 'written' : 'unwritten'}
                title={written ? undefined : 'Not written yet'}
                className={`flex max-w-full items-center gap-1 rounded border py-0.5 pl-2 pr-1 text-xs ${written ? 'border-indigo-200 bg-indigo-50 text-indigo-900' : 'border-dashed border-gray-400 bg-white text-gray-600'}`}
              >
                <span className="min-w-0 break-words">{name}</span>
                <button
                  type="button"
                  className={`rounded px-1 ${written ? 'text-indigo-700 hover:bg-indigo-100' : 'text-gray-500 hover:bg-gray-100'}`}
                  onClick={() => { onToggle(name); box.current?.focus(); }}
                  aria-label={`Remove ${name} from ${LIST_LABEL[list]}`}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <input
        ref={box}
        id={id}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={shown.length > 0}
        aria-controls={`${id}-rows`}
        aria-activedescendant={shown[at] ? `${id}-row-${at}` : undefined}
        aria-invalid={typed.trim() !== '' && problem !== null}
        aria-describedby={[said ? `${id}-said` : '', note ? `${id}-note` : ''].filter(Boolean).join(' ') || undefined}
        className={`lens-input w-full ${clicksHere ? '!border-indigo-400' : ''}`}
        placeholder="Type a name, or click a concept"
        autoComplete="off"
        value={typed}
        onChange={(e) => {
          setTyped(e.target.value);
          setOpen(e.target.value.trim() !== '');
          setActive(0);
        }}
        onClick={() => {
          if (typed.trim()) setOpen(true);
          onActivate?.();
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {shown.length > 0 && (
        <ul
          ref={rows}
          id={`${id}-rows`}
          role="listbox"
          aria-label={`${LIST_LABEL[list]}: concepts to pick`}
          className="mt-1 max-h-48 overflow-y-auto rounded border border-gray-200 bg-white text-sm shadow-sm"
        >
          {shown.map((option, i) => (
            <li
              key={option.kind === 'new' ? '+new' : option.key}
              id={`${id}-row-${i}`}
              role="option"
              aria-selected={i === at}
              data-new={option.kind === 'new' || undefined}
              className={`cursor-pointer break-words px-2 py-1 ${option.kind === 'new' && i > 0 ? 'border-t border-dashed border-gray-300' : ''} ${i === at ? 'bg-blue-600 text-white' : 'text-gray-700'}`}
              // The box keeps the focus: a press on a row must not blur it
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => { if (i !== at) setActive(i); }}
              onClick={() => pick(option)}
            >
              {option.kind === 'new' ? (
                <>Add "{option.name}" as a new concept</>
              ) : (
                <>
                  {option.name}
                  {!option.written && <span className={`ml-1.5 text-xs ${i === at ? 'text-blue-100' : 'text-gray-400'}`}>Not written yet</span>}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {said && (
        <p id={`${id}-said`} role="status" className={`mt-1 text-xs ${typed.trim() !== '' ? 'text-red-700' : 'text-gray-400'}`}>{said}</p>
      )}
      {footnote && <p className="mt-1 break-words text-xs text-gray-400" data-testid="idea-list-footnote">{footnote}</p>}
    </div>
  );
}
