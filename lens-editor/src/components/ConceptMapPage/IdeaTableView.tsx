import { useEffect, useMemo, useRef, useState } from 'react';
import { sortIdeas, type IdeaSortColumn } from '../../lib/idea-map';
import { arrowFocus } from './ideaKeys';
import { PRIORITY_LABEL, PRIORITY_LOOK, pickByEnter, pickKeys, pickWord, type IdeaViewProps } from './ideaLook';

const COLUMNS: Array<{ id: IdeaSortColumn; label: string; title?: string; number?: boolean }> = [
  { id: 'name', label: 'Name' },
  { id: 'priority', label: 'Priority' },
  { id: 'topic', label: 'Topic', title: 'The group the author put the concept in' },
  { id: 'step', label: 'Step', title: 'Step 1 needs nothing first', number: true },
  { id: 'requires', label: 'Requires' },
  { id: 'neededFor', label: 'Needed for' },
  { id: 'lenses', label: 'Lenses', title: 'Links under ## Lenses', number: true },
  { id: 'questions', label: 'Questions', number: true },
  { id: 'problems', label: 'Problems' },
];

/** The "what is still missing" view: one row per idea, sortable. Arrow up and
 *  down move the focus from name to name. */
export function IdeaTableView({ graph, selected, chosen, marks, matches, onPick, onChoose }: IdeaViewProps) {
  const [sort, setSort] = useState<{ column: IdeaSortColumn; descending: boolean }>({ column: 'name', descending: false });
  const rows = useMemo(() => {
    const sorted = sortIdeas(graph.nodes, sort.column, sort.descending);
    return matches ? sorted.filter((node) => matches.has(node.key)) : sorted;
  }, [graph, sort, matches]);

  // The box in the header: every row shown, some of them, or none
  const shownChosen = rows.filter((node) => chosen.has(node.key)).length;
  const all = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (all.current) all.current.indeterminate = shownChosen > 0 && shownChosen < rows.length;
  }, [shownChosen, rows.length]);

  /** "2 · A, B": the count, then the names, each selecting its idea. */
  const names = (keys: string[]) => (
    <>
      <span className="tabular-nums text-gray-700">{keys.length}</span>
      {keys.length > 0 && <span className="text-gray-300"> · </span>}
      {keys.map((key, i) => {
        const other = graph.byKey.get(key);
        if (!other) return null;
        return (
          <span key={key}>
            {i > 0 && ', '}
            {/* Not a <button>: that is one box, so a long name could not wrap with the list */}
            <span
              role="button"
              tabIndex={0}
              className={`cursor-pointer hover:underline ${other.written ? 'text-blue-600' : 'text-gray-500 italic'}`}
              title={other.written ? undefined : 'Not written yet'}
              onClick={(e) => { e.stopPropagation(); onPick(key, pickKeys(e)); }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                e.stopPropagation();
                onPick(key, pickKeys(e));
              }}
            >
              {other.name}
            </span>
          </span>
        );
      })}
    </>
  );

  return (
    <div className="h-full overflow-auto" data-testid="idea-table">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-white text-left text-xs text-gray-500 shadow-[0_1px_0_var(--color-gray-200)]">
          <tr>
            {onChoose && (
              <th scope="col" className="w-8 py-2 pl-3 pr-0">
                <input
                  ref={all}
                  type="checkbox"
                  aria-label={matches ? 'Select every concept shown' : 'Select every concept'}
                  title={matches ? 'Select every concept shown' : 'Select every concept'}
                  checked={rows.length > 0 && shownChosen === rows.length}
                  disabled={rows.length === 0}
                  onChange={(e) => onChoose(rows.map((node) => node.key), e.target.checked)}
                />
              </th>
            )}
            {COLUMNS.map((column) => {
              const active = sort.column === column.id;
              return (
                <th
                  key={column.id}
                  scope="col"
                  className={`whitespace-nowrap px-3 py-2 font-medium ${column.number ? 'text-right' : ''}`}
                  aria-sort={active ? (sort.descending ? 'descending' : 'ascending') : undefined}
                >
                  <button
                    type="button"
                    title={column.title}
                    className={`hover:text-gray-800 ${active ? 'text-gray-800' : ''}`}
                    onClick={() => setSort({ column: column.id, descending: active && !sort.descending })}
                  >
                    {column.label}
                    <span className="ml-1 inline-block w-2 text-gray-400" aria-hidden="true">{active ? (sort.descending ? '↓' : '↑') : ''}</span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody onKeyDown={arrowFocus}>
          {rows.map((node) => {
            const word = pickWord(marks, node.key);
            const inSet = chosen.has(node.key);
            const lit = marks ? word !== null : inSet || node.key === selected;
            return (
              <tr
                key={node.key}
                data-idea={node.name}
                data-chosen={inSet || undefined}
                aria-selected={lit}
                onClick={(e) => onPick(node.key, pickKeys(e))}
                className={`cursor-pointer border-t border-gray-100 align-top ${lit ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
              >
                {onChoose && (
                  // The whole cell takes the click, so a near miss does not open the panel instead
                  <td className="w-8 py-1.5 pl-3 pr-0" onClick={(e) => { e.stopPropagation(); onChoose([node.key], !inSet); }}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${node.name}`}
                      checked={inSet}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => onChoose([node.key], e.target.checked)}
                    />
                  </td>
                )}
                <td className="max-w-72 px-3 py-1.5">
                  <button
                    type="button"
                    data-key={node.key}
                    className={`text-left font-medium ${node.written ? 'text-gray-800' : 'text-gray-500 italic'}`}
                    onKeyDown={(e) => pickByEnter(e, (keys) => onPick(node.key, keys))}
                  >
                    {node.name}
                  </button>
                  {word && <span className="ml-1.5 rounded bg-indigo-600 px-1 py-px text-[10px] font-medium text-white">{word}</span>}
                </td>
                <td className="whitespace-nowrap px-3 py-1.5">
                  {node.idea && (
                    <span className={`rounded border px-1.5 py-0.5 text-xs ${PRIORITY_LOOK[node.idea.priority]}`}>{PRIORITY_LABEL[node.idea.priority]}</span>
                  )}
                </td>
                <td className="max-w-56 px-3 py-1.5 text-xs leading-5 text-gray-600">{node.idea?.topic}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-gray-600">{node.step}</td>
                <td className="max-w-80 px-3 py-1.5 text-xs leading-5 text-gray-600">{names(node.requires)}</td>
                <td className="max-w-80 px-3 py-1.5 text-xs leading-5 text-gray-600">{names(node.neededFor)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-gray-600">{node.idea ? node.idea.lenses.length : ''}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-gray-600">{node.idea ? node.idea.questions : ''}</td>
                <td className="max-w-80 px-3 py-1.5 text-xs leading-5">
                  {node.problems.map((problem, i) => (
                    <span key={i} className={`block ${problem.error ? 'text-red-700' : problem.kind === 'placeholder' ? 'text-gray-500' : 'text-amber-700'}`}>
                      {problem.text}
                    </span>
                  ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && <p className="px-3 py-6 text-sm text-gray-500">No concept matches.</p>}
    </div>
  );
}
