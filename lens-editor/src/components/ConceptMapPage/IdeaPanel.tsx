import type { ReactNode } from 'react';
import type { IdeaGraph, IdeaNode } from '../../lib/idea-map';
import { DocLink } from '../DocLink';
import { BUTTON, PRIMARY_BUTTON, PRIORITY_LABEL, PRIORITY_LOOK } from './ideaLook';

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-4">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-400">{title}</h3>
      {children}
    </section>
  );
}

const NONE = <p className="text-sm text-gray-400">None</p>;

/** The side panel of one idea: what its file says, and what needs it. */
export function IdeaPanel({ node, graph, lensDoc, canEdit, onSelect, onClose, onCreate, onEditRequirements, onAddQuestion }: {
  node: IdeaNode;
  graph: IdeaGraph;
  /** The doc a Learn link points to (bare uuid), or null. */
  lensDoc: (link: string) => string | null;
  canEdit: boolean;
  onSelect: (key: string) => void;
  onClose: () => void;
  /** "Create this concept", on a "not written yet" idea. */
  onCreate: () => void;
  onEditRequirements: () => void;
  onAddQuestion: () => void;
}) {
  const names = (keys: string[]) => (keys.length === 0 ? NONE : (
    <ul className="space-y-0.5">
      {keys.map((key) => {
        const other = graph.byKey.get(key);
        if (!other) return null;
        return (
          <li key={key}>
            <button type="button" className="text-left text-sm text-blue-600 hover:underline" onClick={() => onSelect(key)}>
              {other.name}
            </button>
            {!other.written && <span className="ml-1.5 text-xs text-gray-400">Not written yet</span>}
          </li>
        );
      })}
    </ul>
  ));
  const idea = node.idea;

  return (
    <aside className="flex h-full flex-col" aria-label={`Concept: ${node.name}`} data-testid="idea-panel">
      <div className="flex items-start gap-2 border-b border-gray-200 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-base font-semibold text-gray-800">{node.name}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
            {idea && <span className={`rounded border px-1.5 py-0.5 ${PRIORITY_LOOK[idea.priority]}`}>{PRIORITY_LABEL[idea.priority]} priority</span>}
            {!node.written && <span className="rounded border border-dashed border-gray-400 px-1.5 py-0.5">Not written yet</span>}
            <span>Step {node.step}</span>
          </div>
        </div>
        <button type="button" className="lens-icon-button" onClick={onClose} aria-label="Close" title="Close">
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {!node.written && (
          <p className="mt-4 text-sm text-gray-600">
            Other concepts name this one, but it has no file yet.
          </p>
        )}
        {node.written && !idea && <p className="mt-4 text-sm text-red-700">Could not read this file.</p>}

        {(node.written || canEdit) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {node.docId && <DocLink docId={node.docId} className={BUTTON}>Open file</DocLink>}
            {canEdit && idea && <button type="button" className={BUTTON} onClick={onEditRequirements}>Edit requirements</button>}
            {canEdit && !node.written && <button type="button" className={PRIMARY_BUTTON} onClick={onCreate}>Create this concept</button>}
          </div>
        )}

        {idea && (
          <Part title="Outcome">
            {idea.outcome ? <p className="whitespace-pre-wrap text-sm text-gray-800">{idea.outcome}</p> : NONE}
          </Part>
        )}
        {idea && <Part title="Requires">{names(node.requires)}</Part>}
        {idea && <Part title="Helpful first">{names(node.helpful)}</Part>}
        <Part title="Needed for">{names(node.neededFor)}</Part>
        {node.helpfulFor.length > 0 && <Part title="Helpful for">{names(node.helpfulFor)}</Part>}
        {idea && (
          <>
            <Part title="Why it matters">
              {idea.why ? <p className="whitespace-pre-wrap text-sm text-gray-800">{idea.why}</p> : NONE}
            </Part>
            <Part title="Learn">
              {idea.learn.length === 0 ? NONE : (
                <ul className="list-disc space-y-1 pl-4 text-sm text-gray-800">
                  {idea.learn.map((line, i) => (
                    <li key={i}>
                      {line.map((part, j) => {
                        if ('text' in part) return <span key={j}>{part.text}</span>;
                        const docId = lensDoc(part.link);
                        return docId
                          ? <DocLink key={j} docId={docId} className="text-blue-600 hover:underline">{part.label}</DocLink>
                          : <span key={j} className="text-red-700" title={`No file found for ${part.link}`}>{part.label}</span>;
                      })}
                    </li>
                  ))}
                </ul>
              )}
            </Part>
            <Part title="Questions">
              {idea.questionList.length === 0 ? NONE : (
                <ol className="list-decimal space-y-1 pl-5 text-sm text-gray-800" data-testid="idea-questions">
                  {idea.questionList.map((question, i) => (
                    <li key={i}>
                      <span className="mr-1.5 rounded border border-gray-200 px-1 py-px text-xs text-gray-500">{question.type || 'No type'}</span>
                      {question.content || <span className="text-gray-400">No question text</span>}
                    </li>
                  ))}
                </ol>
              )}
              {canEdit && <button type="button" className={`${BUTTON} mt-2`} onClick={onAddQuestion}>Add question</button>}
            </Part>
            {node.problems.length > 0 && (
              <Part title="Problems">
                <ul className="space-y-0.5 text-sm">
                  {node.problems.map((problem, i) => (
                    <li key={i} className={problem.error ? 'text-red-700' : 'text-amber-700'}>{problem.text}</li>
                  ))}
                </ul>
              </Part>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
