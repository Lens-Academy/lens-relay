import { useId, useMemo, useState, type FormEvent } from 'react';
import {
  IDEA_COURSE_LINK,
  PRIORITIES,
  ideaEditProblem,
  ideaKey,
  ideaNameProblem,
  requirementCircle,
  togglePick,
  type IdeaEdit,
  type IdeaGraph,
  type IdeaNode,
  type Picks,
  type Priority,
} from '../../lib/idea-map';
import { BUTTON, PRIMARY_BUTTON, PRIORITY_LABEL } from './ideaLook';

/** What the form is for: a new idea, every part of an existing one, or only
 *  the requirements of an existing one. */
export type FormMode = { kind: 'add'; name: string } | { kind: 'edit'; key: string } | { kind: 'requirements'; key: string };

/** What the form holds besides the two lists of requirements. */
export interface IdeaFields {
  name: string;
  outcome: string;
  priority: Priority;
  why: string;
  /** Link targets of the `courses` list, one per line in the form. */
  courses: string[];
  /** The text under `## Learn`, as written. */
  learn: string;
}

const TITLE: Record<FormMode['kind'], string> = { add: 'Add concept', edit: 'Edit concept', requirements: 'Edit requirements' };

const LABEL = 'mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-400';
const LIST_LABEL: Record<keyof Picks, string> = { requires: 'Requires', helpful: 'Helpful first' };

/** One list of picked ideas: its names as chips, and a box to add by typing. */
function PickList({ list, names, candidates, onToggle }: {
  list: keyof Picks;
  names: string[];
  /** Ideas that can still be picked for this list. */
  candidates: IdeaNode[];
  onToggle: (name: string) => void;
}) {
  const id = useId();
  const [typed, setTyped] = useState('');
  const found = useMemo(() => {
    const wanted = typed.trim().toLowerCase();
    return wanted ? candidates.filter((node) => node.key.includes(wanted)).slice(0, 8) : [];
  }, [typed, candidates]);
  const add = (name: string) => {
    onToggle(name);
    setTyped('');
  };
  return (
    <div className="mt-4" data-list={list}>
      <label htmlFor={id} className={LABEL}>{LIST_LABEL[list]}</label>
      {names.length > 0 && (
        <ul className="mb-1.5 flex flex-wrap gap-1">
          {names.map((name) => (
            <li key={name} className="flex max-w-full items-center gap-1 rounded border border-indigo-200 bg-indigo-50 py-0.5 pl-2 pr-1 text-xs text-indigo-900">
              <span className="truncate">{name}</span>
              <button type="button" className="rounded px-1 text-indigo-700 hover:bg-indigo-100" onClick={() => onToggle(name)} aria-label={`Remove ${name} from ${LIST_LABEL[list]}`}>×</button>
            </li>
          ))}
        </ul>
      )}
      <input
        id={id}
        className="lens-input w-full"
        placeholder="Type a name, or click a concept"
        autoComplete="off"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          // Enter picks the first match; it never sends the form
          e.preventDefault();
          if (found[0]) add(found[0].name);
        }}
      />
      {typed.trim() !== '' && (
        <ul className="mt-1 max-h-48 overflow-y-auto rounded border border-gray-200 bg-white text-sm">
          {found.map((node) => (
            <li key={node.key}>
              <button type="button" className="block w-full truncate px-2 py-1 text-left text-gray-700 hover:bg-gray-50" onClick={() => add(node.name)}>
                {node.name}
                {!node.written && <span className="ml-1.5 text-xs text-gray-400">Not written yet</span>}
              </button>
            </li>
          ))}
          {found.length === 0 && <li className="px-2 py-1 text-gray-400">No concept with this name</li>}
        </ul>
      )}
    </div>
  );
}

/**
 * The creator's form, in the side panel so the map stays in view: "Add
 * concept" (a new file), "Edit concept" (every part of an existing file, its
 * name included) or "Edit requirements" (only the two lists). Requirements
 * are picked by typing here or by clicking ideas in the view next to it.
 */
export function IdeaForm({ mode, initial, graph, fileNames, picks, onPicks, clickList, onClickList, onCancel, onSubmit }: {
  mode: FormMode;
  /** "Edit concept": what the file says now (its lists are in `picks`). */
  initial?: IdeaEdit;
  graph: IdeaGraph;
  /** Names of the files in the folder: an idea cannot take another one's. */
  fileNames: readonly string[];
  picks: Picks;
  onPicks: (picks: Picks) => void;
  /** The list a plain click on an idea adds to (a shift-click always adds to "helpful first"). */
  clickList: keyof Picks;
  onClickList: (list: keyof Picks) => void;
  onCancel: () => void;
  /** Create or save (with the fields), or save the requirements (null);
   *  resolves to an error to show, or null. */
  onSubmit: (fields: IdeaFields | null) => Promise<string | null>;
}) {
  const [name, setName] = useState(mode.kind === 'add' ? mode.name : initial?.name ?? '');
  const [outcome, setOutcome] = useState(initial?.outcome ?? '');
  const [priority, setPriority] = useState<Priority>(initial?.priority ?? 'medium');
  const [why, setWhy] = useState(initial?.why ?? '');
  const [courses, setCourses] = useState((initial?.courses ?? [IDEA_COURSE_LINK]).join('\n'));
  const [learn, setLearn] = useState(initial?.learn ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);

  const self = mode.kind === 'add' ? undefined : graph.byKey.get(mode.key);
  // The name the file has now; the form's own text until the map shows a rename
  const ownName = self?.name ?? initial?.name ?? '';
  const renamed = mode.kind === 'edit' && name.trim() !== ownName;
  const nameProblem = mode.kind === 'add' ? ideaNameProblem(name, fileNames)
    : renamed ? ideaNameProblem(name, fileNames.filter((other) => other !== ownName))
    : null;
  const fields = (): IdeaFields => ({
    name: name.trim(),
    outcome,
    priority,
    why,
    courses: courses.split('\n').map((line) => line.trim()).filter(Boolean),
    learn,
  });
  const picked = new Set([...picks.requires, ...picks.helpful].map(ideaKey));
  const ownKey = self?.key ?? ideaKey(name);
  const candidates = graph.nodes.filter((node) => node.key !== ownKey && !picked.has(node.key));
  const circle = requirementCircle(graph, self?.name ?? name, picks.requires);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (nameProblem || busy) return;
    // A changed file is checked part by part when it is saved (ideaEditChanges)
    const problem = mode.kind === 'add' ? ideaEditProblem(fields()) : null;
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    const failed = await onSubmit(mode.kind === 'requirements' ? null : fields());
    // On success the page closes the form
    if (failed) {
      setError(failed);
      setBusy(false);
    }
  };

  return (
    <form className="flex h-full flex-col" onSubmit={submit} aria-label={TITLE[mode.kind]} data-testid="idea-form">
      <div className="border-b border-gray-200 px-4 py-3">
        <h2 className="break-words text-base font-semibold text-gray-800">
          {mode.kind === 'requirements' ? `Requirements of ${ownName}` : TITLE[mode.kind]}
        </h2>
        {mode.kind === 'edit' && <p className="mt-0.5 break-words text-xs text-gray-500">{ownName}</p>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {mode.kind !== 'requirements' && (
          <>
            <div className="mt-4">
              <label htmlFor="idea-name" className={LABEL}>Name</label>
              <input
                id="idea-name"
                className="lens-input w-full"
                value={name}
                autoFocus={mode.kind === 'add'}
                autoComplete="off"
                aria-invalid={tried && nameProblem !== null}
                aria-describedby="idea-name-note"
                onChange={(e) => setName(e.target.value)}
              />
              <p id="idea-name-note" className={`mt-1 text-xs ${nameProblem && (tried || name.trim()) ? 'text-red-700' : 'text-gray-400'}`}>
                {nameProblem && (tried || name.trim()) ? nameProblem
                  : renamed ? 'Saving renames the file. Links to it in other concepts get the new name.'
                  : mode.kind === 'edit' ? 'The name is the file name.' : 'The name becomes the file name.'}
              </p>
            </div>
            <div className="mt-4">
              <label htmlFor="idea-outcome" className={LABEL}>Outcome</label>
              <textarea
                id="idea-outcome"
                className="lens-input w-full"
                rows={mode.kind === 'edit' ? 4 : 3}
                placeholder="What a learner can explain or do, in one sentence"
                value={outcome}
                onChange={(e) => setOutcome(e.target.value)}
              />
            </div>
            <div className="mt-4">
              <label htmlFor="idea-priority" className={LABEL}>Priority</label>
              <select id="idea-priority" className="lens-input" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
              </select>
            </div>
            <div className="mt-4">
              <label htmlFor="idea-why" className={LABEL}>Why it matters</label>
              <textarea id="idea-why" className="lens-input w-full" rows={mode.kind === 'edit' ? 4 : 2} placeholder="One or two sentences" value={why} onChange={(e) => setWhy(e.target.value)} />
            </div>
          </>
        )}

        <PickList list="requires" names={picks.requires} candidates={candidates} onToggle={(n) => onPicks(togglePick(picks, n, 'requires'))} />
        <PickList list="helpful" names={picks.helpful} candidates={candidates} onToggle={(n) => onPicks(togglePick(picks, n, 'helpful'))} />

        {mode.kind !== 'requirements' && (
          <>
            <div className="mt-4">
              <label htmlFor="idea-learn" className={LABEL}>Learn</label>
              <textarea
                id="idea-learn"
                className="lens-input w-full font-mono text-xs"
                rows={mode.kind === 'edit' ? 4 : 2}
                placeholder="- [[../Lenses/Name of a lens]]: what it is for"
                aria-describedby="idea-learn-note"
                value={learn}
                onChange={(e) => setLearn(e.target.value)}
              />
              <p id="idea-learn-note" className="mt-1 text-xs text-gray-400">One line per lens, as in the file.</p>
            </div>
            <div className="mt-4">
              <label htmlFor="idea-courses" className={LABEL}>Courses</label>
              <textarea
                id="idea-courses"
                className="lens-input w-full font-mono text-xs"
                rows={2}
                aria-describedby="idea-courses-note"
                value={courses}
                onChange={(e) => setCourses(e.target.value)}
              />
              <p id="idea-courses-note" className="mt-1 text-xs text-gray-400">One course link per line.</p>
            </div>
          </>
        )}

        <div className="mt-4 rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
          <div className="flex flex-wrap items-center gap-2">
            <span id="idea-click-list">A click on a concept adds it to</span>
            <div role="group" aria-labelledby="idea-click-list" className="inline-flex items-center rounded bg-gray-200 p-0.5">
              {(['requires', 'helpful'] as const).map((list) => (
                <button
                  key={list}
                  type="button"
                  aria-pressed={clickList === list}
                  onClick={() => onClickList(list)}
                  className={`rounded px-2 py-0.5 text-xs font-medium ${clickList === list ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                >
                  {LIST_LABEL[list]}
                </button>
              ))}
            </div>
          </div>
          <p className="mt-1.5 text-gray-500">Click it again to take it out. Shift-click adds to Helpful first.</p>
        </div>

        {circle && (
          <p className="mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700" role="status">
            This makes a circle of requirements: {circle.join(' → ')}
          </p>
        )}
        {error && (
          <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">{error}</p>
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-gray-200 px-4 py-3">
        <button type="button" className={BUTTON} onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className={PRIMARY_BUTTON} disabled={busy}>
          {mode.kind === 'add' ? (busy ? 'Creating…' : 'Create concept')
            : busy ? 'Saving…' : mode.kind === 'edit' ? 'Save' : 'Save requirements'}
        </button>
      </div>
    </form>
  );
}
