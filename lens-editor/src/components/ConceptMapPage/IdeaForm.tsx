import { useRef, useState, type FormEvent } from 'react';
import {
  IDEA_COURSE_LINK,
  PRIORITIES,
  ideaEditProblem,
  ideaKey,
  ideaNameProblem,
  neededForCircle,
  requirementCircle,
  togglePick,
  type Dependents,
  type IdeaEdit,
  type IdeaGraph,
  type IdeaLinks,
  type Priority,
} from '../../lib/idea-map';
import { BUTTON, FIELD_LABEL, LIST_LABEL, PRIMARY_BUTTON, PRIORITY_LABEL, SHIFT_LIST, listed, type LinkList } from './ideaLook';
import { GrowingTextarea } from './GrowingTextarea';
import { PickList } from './PickList';
import { LEAVE_NOTE, saveKeys, useFormKeys } from './formKeys';

/** What the form is for: a new idea, every part of an existing one, or only
 *  the requirements of an existing one. */
export type FormMode = { kind: 'add'; name: string } | { kind: 'edit'; key: string } | { kind: 'requirements'; key: string };

/** What the form holds besides its lists of other ideas. */
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

const LABEL = FIELD_LABEL;

const REQUIREMENT_LISTS: readonly LinkList[] = ['requires', 'helpful'];
const ALL_LISTS: readonly LinkList[] = ['requires', 'helpful', 'neededFor', 'helpfulFor'];
const NO_DEPENDENTS: Dependents = { neededFor: [], helpfulFor: [] };

/**
 * The creator's form, in the side panel so the map stays in view: "Add
 * concept" (a new file), "Edit concept" (every part of an existing file, its
 * name included) or "Edit requirements" (only the two lists). Requirements
 * are picked by typing here or by clicking ideas in the view next to it.
 * "Add concept" and "Edit concept" also have the other direction: "Needed
 * for" and "Helpful for", the ideas whose own Requires / Helpful first get
 * this one.
 *
 * By keyboard: the focus starts in the first field; Enter in the name moves
 * on instead of saving; Ctrl/Cmd+Enter saves; Escape closes (asking once when
 * something is not saved).
 */
export function IdeaForm({ mode, initial, graph, fileNames, picks, onPicks, before = NO_DEPENDENTS, clickList, onClickList, note, onCancel, onSubmit }: {
  mode: FormMode;
  /** "Edit concept": what the file says now (its lists are in `picks`). */
  initial?: IdeaEdit;
  graph: IdeaGraph;
  /** Names of the files in the folder: an idea cannot take another one's. */
  fileNames: readonly string[];
  picks: IdeaLinks;
  onPicks: (picks: IdeaLinks) => void;
  /** "Needed for" / "Helpful for" as they were when the form opened. */
  before?: Dependents;
  /** The list a plain click on an idea adds to (a shift-click adds to the "helpful" one of its pair). */
  clickList: LinkList;
  onClickList: (list: LinkList) => void;
  /** Why the last click on an idea added nothing. */
  note?: string | null;
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
  // What the form opened with: Escape asks before it discards anything else
  const [start] = useState(() => JSON.stringify([name, outcome, priority, why, courses, learn, picks]));
  const { onKeyDown, leaving } = useFormKeys({
    dirty: JSON.stringify([name, outcome, priority, why, courses, learn, picks]) !== start,
    busy,
    onCancel,
  });

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
  // Never offered as its own requirement: the name of its file, and the one typed for it
  const ownNames = [ownName, name];
  const lists = mode.kind === 'requirements' ? REQUIREMENT_LISTS : ALL_LISTS;
  const has = (names: readonly string[], other: string) => names.some((n) => ideaKey(n) === ideaKey(other));
  // A circle through what the file of another idea says already is said, not
  // refused (it can be the way out of one); a circle a new "Needed for" makes
  // is refused: nothing is saved.
  const circle = requirementCircle(graph, self?.name ?? name, picks.requires, before.neededFor.filter((other) => !has(picks.neededFor, other)));
  const blocked = mode.kind === 'requirements' ? null
    : neededForCircle(graph, self?.name ?? name, picks.requires, picks.neededFor.filter((other) => !has(before.neededFor, other)));
  const blockedNote = useRef<HTMLParagraphElement>(null);
  // A new idea under a name other ideas link to already: say who does
  const named = mode.kind === 'add' ? graph.byKey.get(ideaKey(name)) : undefined;
  const already = (keys: readonly string[], shown: readonly string[], word: string, section: string) => {
    const names = keys.map((key) => graph.byKey.get(key)?.name ?? key).filter((other) => !has(shown, other));
    return names.length > 0 ? `Already ${word} ${listed(names)}: ${names.length === 1 ? 'it names' : 'they name'} this concept under ${section}.` : null;
  };
  const footnotes: Partial<Record<LinkList, string | null>> = named ? {
    neededFor: already(named.neededFor, picks.neededFor, 'needed for', 'Requires'),
    helpfulFor: already(named.helpfulFor, picks.helpfulFor, 'helpful for', 'Helpful first'),
  } : {};

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (nameProblem || busy) return;
    if (blocked) {
      blockedNote.current?.scrollIntoView?.({ block: 'nearest' });
      return;
    }
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
    <form className="flex h-full flex-col" onSubmit={submit} onKeyDown={onKeyDown} aria-label={TITLE[mode.kind]} data-testid="idea-form">
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
                autoFocus
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
              <GrowingTextarea
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
              <GrowingTextarea id="idea-why" className="lens-input w-full" rows={mode.kind === 'edit' ? 4 : 2} placeholder="One or two sentences" value={why} onChange={(e) => setWhy(e.target.value)} />
            </div>
          </>
        )}

        <div className="mt-4 rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span id="idea-click-list">A click on a concept adds it to</span>
            <div role="group" aria-labelledby="idea-click-list" className="inline-flex flex-wrap items-center rounded bg-gray-200 p-0.5">
              {lists.map((list) => (
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
          <p className="mt-1.5 text-gray-500">
            Click it again to take it out.{SHIFT_LIST[clickList] !== clickList && ` Shift-click adds to ${LIST_LABEL[SHIFT_LIST[clickList]]}.`}
          </p>
          {note && <p className="mt-1.5 text-amber-700" role="status" data-testid="idea-click-note">{note}</p>}
        </div>

        {lists.map((list) => (
          <PickList
            key={list}
            list={list}
            picks={picks}
            graph={graph}
            ownNames={ownNames}
            clicksHere={clickList === list}
            autoFocus={mode.kind === 'requirements' && list === 'requires'}
            footnote={footnotes[list]}
            onActivate={() => onClickList(list)}
            onToggle={(n) => onPicks(togglePick(picks, n, list))}
          />
        ))}
        {blocked && (
          <p ref={blockedNote} className="mt-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert" data-testid="idea-needed-circle">
            This makes a circle of requirements: {blocked.join(' → ')}. Take {blocked[blocked.length - 2]} out of Needed for, or change Requires: it cannot be saved like this.
          </p>
        )}

        {mode.kind !== 'requirements' && (
          <>
            <div className="mt-4">
              <label htmlFor="idea-learn" className={LABEL}>Learn</label>
              <GrowingTextarea
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
              <GrowingTextarea
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

        {circle && (
          <p className="mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700" role="status">
            This makes a circle of requirements: {circle.join(' → ')}
          </p>
        )}
        {error && (
          <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">{error}</p>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-4 py-3">
        {leaving && <p className="mr-auto text-xs text-amber-700" role="status" data-testid="form-leave-note">{LEAVE_NOTE}</p>}
        <button type="button" className={BUTTON} onClick={onCancel} disabled={busy} title="Escape">Cancel</button>
        <button type="submit" className={PRIMARY_BUTTON} disabled={busy} title={saveKeys()}>
          {mode.kind === 'add' ? (busy ? 'Creating…' : 'Create concept')
            : busy ? 'Saving…' : mode.kind === 'edit' ? 'Save' : 'Save requirements'}
        </button>
      </div>
    </form>
  );
}
