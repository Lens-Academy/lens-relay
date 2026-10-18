import { useEffect, useMemo, useRef, useState } from 'react';

export interface PickerConcept {
  id: string;
  name: string;
  /** Already has a row about the opened file. */
  taken: boolean;
}

type Option = { kind: 'existing'; concept: PickerConcept } | { kind: 'new'; name: string };

/** Characters a file name cannot hold (as generateNewDocPath strips them). */
const BAD_NAME = /[/\\?%*:|"<>]/;

/** "+ Add concept": pick a concept file, or name a new one. */
export function ConceptPicker({
  concepts,
  onPick,
  onClose,
}: {
  concepts: PickerConcept[];
  onPick: (choice: { id: string } | { name: string }) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const options = useMemo<Option[]>(() => {
    const q = query.trim().toLowerCase();
    const matches = concepts
      .filter((c) => c.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
    const out: Option[] = matches.map((concept) => ({ kind: 'existing', concept }));
    const name = query.trim();
    if (name && !BAD_NAME.test(name) && !concepts.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      out.push({ kind: 'new', name });
    }
    return out;
  }, [concepts, query]);

  const choose = (option: Option | undefined) => {
    if (!option) return;
    if (option.kind === 'new') onPick({ name: option.name });
    else if (!option.concept.taken) onPick({ id: option.concept.id });
  };

  return (
    <div className="concept-picker mt-1 rounded border border-gray-200 bg-white shadow-sm" data-testid="concept-picker">
      <input
        ref={input}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, options.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            choose(options[active]);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder="Find or create a concept…"
        className="w-full border-b border-gray-100 px-2 py-1.5 text-sm outline-none"
        aria-label="Concept name"
      />
      <ul className="max-h-48 overflow-auto py-1" role="listbox">
        {options.length === 0 && (
          <li className="px-2 py-1 text-sm text-gray-400">
            {BAD_NAME.test(query) ? 'A concept name cannot contain / \\ ? % * : | " < >' : 'No concepts yet: type a name'}
          </li>
        )}
        {options.map((option, i) => (
          <li
            key={option.kind === 'new' ? '\0new' : option.concept.id}
            role="option"
            aria-selected={i === active}
            aria-disabled={option.kind === 'existing' && option.concept.taken}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              choose(option);
            }}
            className={`flex cursor-pointer items-baseline gap-2 px-2 py-1 text-sm ${i === active ? 'bg-indigo-50' : ''} ${option.kind === 'existing' && option.concept.taken ? 'cursor-default text-gray-400' : 'text-gray-700'}`}
          >
            {option.kind === 'new'
              ? <span className="min-w-0 truncate" title={option.name}>Create new concept <span className="font-medium">“{option.name}”</span></span>
              : (
                <>
                  <span className="min-w-0 truncate" title={option.concept.name}>{option.concept.name}</span>
                  {option.concept.taken && <span className="ml-auto shrink-0 text-xs">already has a row</span>}
                </>
              )}
          </li>
        ))}
      </ul>
    </div>
  );
}
