import { useState, type ReactNode } from 'react';
import { questionAsNew, type IdeaGraph, type IdeaNode } from '../../lib/idea-map';
import { DocLink } from '../DocLink';
import { Confirm } from './Confirm';
import { BUTTON, PRIMARY_BUTTON, PRIORITY_LABEL, PRIORITY_LOOK, listed } from './ideaLook';

const ROW_ACTION = 'text-xs text-blue-600 hover:underline';

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-4">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-400">{title}</h3>
      {children}
    </section>
  );
}

const NONE = <p className="text-sm text-gray-400">None</p>;

/**
 * The side panel of one idea: what its file says, and what needs it. With
 * edit rights also the ways to change it: edit or delete the idea, and add,
 * edit or delete a question. The page gives it a `key` per idea, so a
 * question asked about one idea never stays open on the next.
 */
export function IdeaPanel({ node, graph, lensDoc, canEdit, deleteNote, onSelect, onClose, onCreate, onEdit, onDelete, onEditRequirements, onAddQuestion, onEditQuestion, onDeleteQuestion }: {
  node: IdeaNode;
  graph: IdeaGraph;
  /** The doc a Learn link points to (bare uuid), or null. */
  lensDoc: (link: string) => string | null;
  canEdit: boolean;
  /** What becomes of a deleted file, said before deleting ("… can be restored …"). */
  deleteNote?: string;
  onSelect: (key: string) => void;
  onClose: () => void;
  /** "Create this concept", on a "not written yet" idea. */
  onCreate: () => void;
  /** Open the form with every part of the idea. */
  onEdit: () => void;
  /** Delete the idea (for one that is not written yet: take every link to it
   *  out), once confirmed here; resolves to an error to show, or null. */
  onDelete: () => Promise<string | null>;
  onEditRequirements: () => void;
  onAddQuestion: () => void;
  /** Open the form for the question at this place of `idea.questionList`. */
  onEditQuestion: (index: number) => void;
  /** Delete that question, once confirmed here; resolves to an error to show, or null. */
  onDeleteQuestion: (index: number) => Promise<string | null>;
}) {
  /** What is about to be deleted: the idea, or the question at a place. */
  const [confirm, setConfirm] = useState<'idea' | number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ask = (what: 'idea' | number | null) => {
    setConfirm(what);
    setError(null);
  };
  const run = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    const failed = await action();
    setBusy(false);
    if (failed) setError(failed);
    else setConfirm(null);
  };
  const namesOf = (keys: string[]) => keys.map((key) => graph.byKey.get(key)?.name ?? key);

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
            {canEdit && idea && <button type="button" className={BUTTON} onClick={onEdit}>Edit</button>}
            {canEdit && idea && <button type="button" className={BUTTON} onClick={onEditRequirements}>Edit requirements</button>}
            {canEdit && node.docId && <button type="button" className={BUTTON} onClick={() => ask('idea')}>Delete</button>}
            {canEdit && !node.written && <button type="button" className={PRIMARY_BUTTON} onClick={onCreate}>Create this concept</button>}
            {canEdit && !node.written && <button type="button" className={BUTTON} onClick={() => ask('idea')}>Remove links</button>}
          </div>
        )}
        {confirm === 'idea' && !node.written && (
          <Confirm label="Remove links" action="Remove links" busyLabel="Removing…" busy={busy} error={error} onCancel={() => ask(null)} onConfirm={() => run(onDelete)}>
            <p>Take every link to "{node.name}" out?</p>
            <p className="mt-1">
              {listed(namesOf([...new Set([...node.neededFor, ...node.helpfulFor])]))} {node.neededFor.length + node.helpfulFor.length === 1 ? 'names' : 'name'} it. It has no file, so it leaves the map with its last link.
            </p>
          </Confirm>
        )}
        {confirm === 'idea' && node.written && (
          <Confirm label="Delete concept" action="Delete concept" busy={busy} error={error} onCancel={() => ask(null)} onConfirm={() => run(onDelete)}>
            <p>Delete the concept "{node.name}"?</p>
            {node.neededFor.length > 0 && (
              <p className="mt-1">
                {listed(namesOf(node.neededFor))} {node.neededFor.length === 1 ? 'lists' : 'list'} it as required; {node.neededFor.length === 1 ? 'that link is' : 'those links are'} removed too.
              </p>
            )}
            {node.helpfulFor.length > 0 && (
              <p className="mt-1">
                {listed(namesOf(node.helpfulFor))} {node.helpfulFor.length === 1 ? 'lists' : 'list'} it as helpful first; {node.helpfulFor.length === 1 ? 'that link is' : 'those links are'} removed too.
              </p>
            )}
            {idea && idea.questionList.length > 0 && (
              <p className="mt-1">Its {idea.questionList.length === 1 ? 'question goes' : `${idea.questionList.length} questions go`} with it.</p>
            )}
            {deleteNote && <p className="mt-1 text-xs text-gray-600">{deleteNote}</p>}
          </Confirm>
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
                  {idea.questionList.map((question, i) => {
                    const [first, ...more] = question.content.split('\n');
                    return (
                      <li key={i}>
                        <span className="mr-1.5 rounded border border-gray-200 px-1 py-px text-xs text-gray-500">{question.type || 'No type'}</span>
                        <span title={more.length > 0 ? question.content : undefined} data-testid="idea-question-text">
                          {question.content ? `${first}${more.length > 0 ? ' …' : ''}` : <span className="text-gray-400">No question text</span>}
                        </span>
                        {canEdit && (
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5" data-testid="idea-question-actions">
                            {questionAsNew(question) ? (
                              <button type="button" className={ROW_ACTION} aria-label={`Edit question ${i + 1}`} onClick={() => onEditQuestion(i)}>Edit</button>
                            ) : (
                              <>
                                {node.docId && <DocLink docId={node.docId} className={ROW_ACTION}>Open file</DocLink>}
                                <span className="text-xs text-gray-400">This kind of question is edited in the file.</span>
                              </>
                            )}
                            <button type="button" className={ROW_ACTION} aria-label={`Delete question ${i + 1}`} onClick={() => ask(i)}>Delete</button>
                          </div>
                        )}
                        {confirm === i && (
                          <Confirm label="Delete question" action="Delete question" busy={busy} error={error} onCancel={() => ask(null)} onConfirm={() => run(() => onDeleteQuestion(i))}>
                            <p>Delete question {i + 1} from the file?</p>
                          </Confirm>
                        )}
                      </li>
                    );
                  })}
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
