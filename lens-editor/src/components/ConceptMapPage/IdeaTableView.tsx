import { useMemo, useState } from 'react';
import { sortIdeas, type IdeaGraph, type IdeaSortColumn } from '../../lib/idea-map';
import { PRIORITY_LABEL, PRIORITY_LOOK, pickWord, type PickMarks } from './ideaLook';

const COLUMNS: Array<{ id: IdeaSortColumn; label: string; title?: string; number?: boolean }> = [
  { id: 'name', label: 'Name' },
  { id: 'priority', label: 'Priority' },
  { id: 'step', label: 'Step', title: 'Step 1 needs nothing first', number: true },
  { id: 'requires', label: 'Requires' },
  { id: 'neededFor', label: 'Needed for' },
  { id: 'lenses', label: 'Lenses', title: 'Lenses under Learn', number: true },
  { id: 'questions', label: 'Questions', number: true },
  { id: 'problems', label: 'Problems' },
];

/** The "what is still missing" view: one row per idea, sortable. */
export function IdeaTableView({ graph, selected, marks, matches, onPick }: {
  graph: IdeaGraph;
  selected: string | null;
  marks: PickMarks | null;
  matches: ReadonlySet<string> | null;
  onPick: (key: string, shift: boolean) => void;
}) {
  const [sort, setSort] = useState<{ column: IdeaSortColumn; descending: boolean }>({ column: 'name', descending: false });
  const rows = useMemo(() => {
    const sorted = sortIdeas(graph.nodes, sort.column, sort.descending);
    return matches ? sorted.filter((node) => matches.has(node.key)) : sorted;
  }, [graph, sort, matches]);

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
              onClick={(e) => { e.stopPropagation(); onPick(key, e.shiftKey); }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                e.stopPropagation();
                onPick(key, e.shiftKey);
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
        <tbody>
          {rows.map((node) => {
            const word = pickWord(marks, node.key);
            const chosen = marks ? word !== null : node.key === selected;
            return (
              <tr
                key={node.key}
                data-idea={node.name}
                aria-selected={chosen}
                onClick={(e) => onPick(node.key, e.shiftKey)}
                className={`cursor-pointer border-t border-gray-100 align-top ${chosen ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
              >
                <td className="max-w-72 px-3 py-1.5">
                  <button type="button" className={`text-left font-medium ${node.written ? 'text-gray-800' : 'text-gray-500 italic'}`}>
                    {node.name}
                  </button>
                  {word && <span className="ml-1.5 rounded bg-indigo-600 px-1 py-px text-[10px] font-medium text-white">{word}</span>}
                </td>
                <td className="whitespace-nowrap px-3 py-1.5">
                  {node.idea && (
                    <span className={`rounded border px-1.5 py-0.5 text-xs ${PRIORITY_LOOK[node.idea.priority]}`}>{PRIORITY_LABEL[node.idea.priority]}</span>
                  )}
                </td>
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
