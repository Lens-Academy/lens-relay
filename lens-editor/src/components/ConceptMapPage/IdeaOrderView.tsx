import type { IdeaGraph } from '../../lib/idea-map';
import { ideaLook, ideaTitle, pickWord, type PickMarks } from './ideaLook';

/**
 * The ideas as steps, a row per step: step 1 needs nothing first, each later
 * step needs only ideas from the steps before it.
 */
export function IdeaOrderView({ graph, selected, marks, matches, onPick }: {
  graph: IdeaGraph;
  selected: string | null;
  marks: PickMarks | null;
  matches: ReadonlySet<string> | null;
  onPick: (key: string, shift: boolean) => void;
}) {
  return (
    <div className="h-full overflow-y-auto px-6 py-4" data-testid="idea-order">
      <p className="mb-3 text-xs text-gray-500">
        Step 1 needs nothing first. Every later step needs only concepts from the steps before it.
      </p>
      {graph.steps.map((nodes, index) => {
        const shown = matches ? nodes.filter((node) => matches.has(node.key)) : nodes;
        return (
          <section key={index} className="flex gap-4 border-t border-gray-200 py-3" data-step={index + 1}>
            <div className="w-20 shrink-0">
              <h2 className="text-sm font-semibold text-gray-700">Step {index + 1}</h2>
              <p className="text-xs text-gray-400">{nodes.length} {nodes.length === 1 ? 'concept' : 'concepts'}</p>
            </div>
            <div className="flex min-w-0 flex-1 flex-wrap content-start gap-1.5">
              {shown.map((node) => {
                const word = pickWord(marks, node.key);
                const ring = word ? 'ring-2 ring-indigo-500' : node.key === selected ? 'ring-2 ring-blue-600' : '';
                return (
                  <button
                    key={node.key}
                    type="button"
                    data-idea={node.name}
                    aria-pressed={marks ? word !== null : node.key === selected}
                    title={ideaTitle(node)}
                    onClick={(e) => onPick(node.key, e.shiftKey)}
                    className={`flex max-w-full items-center gap-1.5 rounded border px-2 py-1 text-xs hover:brightness-95 ${ideaLook(node)} ${ring}`}
                  >
                    <span className="truncate">{node.name}</span>
                    {word && <span className="shrink-0 rounded bg-indigo-600 px-1 py-px text-[9px] font-medium leading-none text-white">{word}</span>}
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
