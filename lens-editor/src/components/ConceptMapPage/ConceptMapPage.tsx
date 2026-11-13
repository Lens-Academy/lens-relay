import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  IDEAS_FOLDER,
  IDEAS_SHARED_FOLDER,
  WRITE_IT_FIRST,
  ideaAsEdit,
  ideaKey,
  questionAsNew,
  togglePick,
  type IdeaEdit,
  type IdeaLinks,
  type IdeaQuestion,
  type Picks,
} from '../../lib/idea-map';
import { PathExistsError } from '../../lib/relay-api';
import { FindBox } from './FindBox';
import { IdeaForm, type FormMode, type IdeaFields } from './IdeaForm';
import { IdeaMapDrawing } from './IdeaMapDrawing';
import { IdeaOrderView } from './IdeaOrderView';
import { IdeaPanel } from './IdeaPanel';
import { IdeaTableView } from './IdeaTableView';
import { IdeaWalkView } from './IdeaWalkView';
import { ProfileSwitcher } from './ProfileSwitcher';
import { QuestionForm } from './QuestionForm';
import { SelectionBar } from './SelectionBar';
import { BUTTON, PRIMARY_BUTTON, SHIFT_LIST, type IdeaViewProps, type LinkList, type PickKeys, type PickMarks } from './ideaLook';
import { useIdeaMap } from './useIdeaMap';

const VIEWS = [
  { id: 'map', label: 'Map' },
  { id: 'order', label: 'Order' },
  { id: 'table', label: 'Table' },
  { id: 'walk', label: 'Walk through' },
] as const;
type ViewId = (typeof VIEWS)[number]['id'];

const NO_PICKS: IdeaLinks = { requires: [], helpful: [], neededFor: [], helpfulFor: [] };

/** How long the line that says what was just done stays. */
const NOTICE_MS = 6000;
/** How long the focus waits for what it is to go to (a panel that opens). */
const FOCUS_WAIT_MS = 1500;
const QUESTION_OPEN = 'Save or cancel the question first.';

/** What was just done ("Saved …"), or why a click did nothing. */
interface Notice { text: string; kind: 'done' | 'note' }

/** Where the focus goes next: the side panel, an idea in the view, or the search box. */
type FocusTarget = { to: 'panel' } | { to: 'idea'; key: string } | { to: 'find' };

/**
 * The creator's concept map of the Context Accelerator (/concept-map): the
 * idea files of `Lens Edu/Context Accelerator LOs/` as a graph, read live,
 * in four views (the map, the steps, a table, and a walk through it one
 * concept at a time) with a side panel; links that can edit also add, edit,
 * rename and delete ideas and add, edit and delete their questions from it,
 * and select several ideas to delete (or, where the hook has profiles, copy
 * into another profile) together.
 *
 * All of it works from the keyboard: "/" goes to the search box, whose list
 * opens a concept with Enter; the arrow keys move between the concepts of a
 * view; the focus follows into the panel or form that opens and comes back
 * when it closes (Escape); what was saved or deleted is said in a line over
 * the views.
 */
export function ConceptMapPage() {
  const [params, setParams] = useSearchParams();
  // ?folder= picks a test set next to the real folder (local relay only)
  const wanted = params.get('folder');
  const folder = wanted?.startsWith(IDEAS_FOLDER) ? wanted : IDEAS_FOLDER;
  const view: ViewId = VIEWS.find((v) => v.id === params.get('view'))?.id ?? 'map';
  const setParam = (name: string, value: string | null) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value === null) next.delete(name);
      else next.set(name, value);
      return next;
    }, { replace: true });
  };
  return (
    <ConceptMap
      key={folder}
      folder={folder}
      onFolder={(next) => setParam('folder', next === IDEAS_FOLDER ? null : next)}
      view={view}
      onView={(next) => setParam('view', next === 'map' ? null : next)}
    />
  );
}

function ConceptMap({ folder, onFolder, view, onView }: {
  folder: string;
  onFolder: (folder: string) => void;
  view: ViewId;
  onView: (view: ViewId) => void;
}) {
  const { canEdit } = useAuth();
  const map = useIdeaMap(folder);
  const { graph } = map;
  const [selected, setSelected] = useState<string | null>(null);
  const [find, setFind] = useState('');
  const [mode, setMode] = useState<FormMode | null>(null);
  /** The lists of the form: what this idea requires, and what it is needed for. */
  const [picks, setPicks] = useState<IdeaLinks>(NO_PICKS);
  /** The lists as they were when the form opened. */
  const [before, setBefore] = useState<IdeaLinks>(NO_PICKS);
  /** The list a click on an idea adds to while a form is open. */
  const [clickList, setClickList] = useState<LinkList>('requires');
  /** Why the last such click added nothing. */
  const [pickNote, setPickNote] = useState<string | null>(null);
  /** The idea as it was when "Edit concept" opened. */
  const [editBefore, setEditBefore] = useState<IdeaEdit | null>(null);
  /** The idea a question is added to, or whose question (`edit`: its place
   *  and what it said when the form opened) is edited. */
  const [questionFor, setQuestionFor] = useState<{ key: string; edit?: { index: number; before: IdeaQuestion } } | null>(null);
  /** The ideas selected to act on together (Ctrl/Cmd/Shift-click, the boxes of the table). */
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const say = useCallback((text: string, kind: Notice['kind'] = 'done') => setNotice({ text, kind }), []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  // The focus follows what the keyboard opened and comes back when it closes.
  // What it is to go to may only be drawn a moment later (a panel of an idea
  // just created), so it is looked for after every drawing until it is there.
  const page = useRef<HTMLDivElement>(null);
  const findBox = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<(FocusTarget & { until: number }) | null>(null);
  const focusOn = useCallback((target: FocusTarget) => {
    focusNext.current = { ...target, until: Date.now() + FOCUS_WAIT_MS };
  }, []);

  // The views wait until every file is read once, so the map is not laid out
  // again for each file that arrives; later additions just appear.
  const [loaded, setLoaded] = useState(false);
  // Another profile is another set of concepts: nothing of the one before stays open
  const profile = map.profiles?.current;
  const [shownProfile, setShownProfile] = useState(profile);
  if (profile !== shownProfile) {
    setShownProfile(profile);
    setSelected(null);
    setMode(null);
    setQuestionFor(null);
    setChosen([]);
    setFind('');
    setLoaded(false);
  }
  if (!loaded && map.ready && map.total > 0 && map.read === map.total) setLoaded(true);

  useEffect(() => {
    const want = focusNext.current;
    const root = page.current;
    if (!want || !root) return;
    const done = (el: HTMLElement | null | undefined) => {
      focusNext.current = null;
      el?.focus();
    };
    if (Date.now() > want.until) {
      focusNext.current = null;
    } else if (want.to === 'find') {
      done(findBox.current);
    } else if (want.to === 'panel') {
      const panel = root.querySelector<HTMLElement>('[data-testid="idea-panel"]');
      if (panel) done(panel);
      // No panel to come: back to the button the form was opened with
      else if (selected === null && !mode && !questionFor) done(addButton.current ?? findBox.current);
    } else {
      const idea = [...root.querySelectorAll<HTMLElement>('[data-key]')].find((el) => el.dataset.key === want.key);
      done(idea ?? findBox.current);
    }
  });

  // "/" goes to the search box, from anywhere but a field
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (!findBox.current) return;
      e.preventDefault();
      findBox.current.focus();
      findBox.current.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const matches = useMemo(() => {
    const wanted = find.trim().toLowerCase();
    return wanted ? new Set(graph.nodes.filter((node) => node.key.includes(wanted)).map((node) => node.key)) : null;
  }, [find, graph]);
  const marks = useMemo<PickMarks | null>(() => (mode ? {
    requires: new Set(picks.requires.map(ideaKey)),
    helpful: new Set(picks.helpful.map(ideaKey)),
    neededFor: new Set(picks.neededFor.map(ideaKey)),
    helpfulFor: new Set(picks.helpfulFor.map(ideaKey)),
    self: mode.kind === 'add' ? null : mode.key,
  } : null), [mode, picks]);

  const openForm = (next: FormMode, start: IdeaLinks = NO_PICKS) => {
    setMode(next);
    setPicks(start);
    setBefore(start);
    setClickList('requires');
    setPickNote(null);
  };
  const names = (keys: string[]) => keys.map((k) => graph.byKey.get(k)?.name ?? k);
  const editRequirements = (key: string) => {
    const node = graph.byKey.get(key);
    if (!node) return;
    openForm({ kind: 'requirements', key }, { ...NO_PICKS, requires: names(node.requires), helpful: names(node.helpful) });
  };
  const editIdea = (key: string) => {
    const node = graph.byKey.get(key);
    if (!node?.idea) return;
    // The names as the file has them: saving compares the file with these.
    // What it is needed for is in the other ideas' files: the graph knows.
    const start = ideaAsEdit(node.name, node.idea, { neededFor: names(node.neededFor), helpfulFor: names(node.helpfulFor) });
    setEditBefore(start);
    openForm({ kind: 'edit', key }, { requires: start.requires, helpful: start.helpful, neededFor: start.neededFor, helpfulFor: start.helpfulFor });
  };

  /** Several can be selected by a link that can edit, while no form is open. */
  const choosing = canEdit && !mode && !questionFor;
  const chosenKeys = useMemo(() => (choosing ? chosen.filter((key) => graph.byKey.has(key)) : []), [choosing, chosen, graph]);
  const chosenSet = useMemo(() => new Set(chosenKeys), [chosenKeys]);
  const choose = useCallback((keys: string[], on: boolean) => setChosen((current) => {
    const next = new Set(current);
    for (const key of keys) {
      if (on) next.add(key);
      else next.delete(key);
    }
    return [...next];
  }), []);

  /**
   * A click on an idea in any view: open it in the panel, or with Ctrl, Cmd
   * or Shift put it into (or take it out of) the selection of several; while
   * a form is open, pick it as a requirement instead.
   */
  const onPick = (key: string, keys: PickKeys) => {
    // The question form belongs to one idea: a click elsewhere must not lose what is typed
    if (questionFor) {
      say(QUESTION_OPEN, 'note');
      return;
    }
    if (!mode) {
      if (keys.toggle && choosing) choose([key], !chosenSet.has(key));
      else {
        setSelected(key);
        if (keys.byKey) focusOn({ to: 'panel' });
      }
      return;
    }
    const node = graph.byKey.get(key);
    if (!node || (mode.kind !== 'add' && mode.key === key)) return;
    const list = keys.shift ? SHIFT_LIST[clickList] : clickList;
    // "Needed for" / "Helpful for" write into the file of the idea clicked
    if ((list === 'neededFor' || list === 'helpfulFor') && !node.written) {
      setPickNote(`"${node.name}" is not written yet, so it cannot go under ${list === 'neededFor' ? 'Needed for' : 'Helpful for'}. ${WRITE_IT_FIRST}`);
      return;
    }
    setPickNote(null);
    setPicks((current) => togglePick(current, node.name, list));
  };

  /** Enter in the search box, or a click on a row of its list: as a click on that idea. */
  const onFind = (key: string, keys: PickKeys) => {
    const several = !mode && !questionFor && keys.toggle && choosing;
    onPick(key, { ...keys, byKey: false });
    if (questionFor || several) return;
    // The next one can be typed at once; an opened idea is seen among the others
    setFind('');
    if (!mode) focusOn({ to: 'panel' });
  };

  // Escape: first the selection of several, then the panel. (A menu, a
  // confirm step or the list of a pick box that is open takes it before.)
  const escape = choosing ? (chosenKeys.length > 0 ? 'selection' : selected !== null ? 'panel' : null) : null;
  useEffect(() => {
    if (!escape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (escape === 'selection') setChosen([]);
      else {
        if (selected !== null) focusOn({ to: 'idea', key: selected });
        setSelected(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [escape, selected, focusOn]);

  const submit = async (fields: IdeaFields | null): Promise<string | null> => {
    if (!mode) return null;
    try {
      if (mode.kind === 'requirements') {
        const two = ({ requires, helpful }: Picks): Picks => ({ requires, helpful });
        const failed = await map.saveRequirements(mode.key, two(before), two(picks));
        if (failed) return failed;
        setSelected(mode.key);
        say(`Saved the requirements of "${graph.byKey.get(mode.key)?.name ?? mode.key}".`);
      } else if (mode.kind === 'edit') {
        if (!fields || !editBefore) return null;
        const failed = await map.editIdea(mode.key, editBefore, { ...fields, ...picks });
        if (failed) return failed;
        // A renamed idea is on the map under its new name
        setSelected(ideaKey(fields.name));
        say(fields.name === editBefore.name ? `Saved "${fields.name}".` : `Saved "${fields.name}" (renamed from "${editBefore.name}").`);
      } else if (fields) {
        // An idea is never its own requirement
        const own = ideaKey(fields.name);
        const others = (names: string[]) => names.filter((name) => ideaKey(name) !== own);
        await map.createIdea({
          ...fields,
          requires: others(picks.requires),
          helpful: others(picks.helpful),
          neededFor: others(picks.neededFor),
          helpfulFor: others(picks.helpfulFor),
        });
        setSelected(own);
        say(`Created "${fields.name}".`);
      }
    } catch (error) {
      if (error instanceof PathExistsError) return 'A file with this name already exists.';
      return error instanceof Error ? error.message : String(error);
    }
    setMode(null);
    focusOn({ to: 'panel' });
    return null;
  };

  const selectedNode = selected ? graph.byKey.get(selected) : undefined;
  const questionNode = questionFor ? graph.byKey.get(questionFor.key) : undefined;
  const questionEdit = questionFor?.edit;
  const written = graph.nodes.filter((node) => node.written).length;
  const unwritten = graph.nodes.length - written;
  const views: IdeaViewProps = {
    graph,
    selected: mode ? null : selected,
    chosen: chosenSet,
    marks,
    matches,
    onPick,
    onChoose: choosing ? choose : undefined,
  };

  return (
    <div ref={page} className="flex h-full flex-col" data-testid="concept-map-page">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-gray-200 px-6 py-3">
        <h1 className="text-xl font-semibold text-gray-800">Concept map</h1>
        {map.profiles && <ProfileSwitcher profiles={map.profiles} count={map.ready && map.read === map.total ? written : null} />}
        {map.folders.length > 1 ? (
          <select className="lens-input" aria-label="Folder" value={folder} onChange={(e) => onFolder(e.target.value)}>
            {map.folders.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        ) : !map.profiles && (
          <span className="text-sm text-gray-500">Context Accelerator</span>
        )}
        <div role="group" aria-label="View" className="inline-flex items-center rounded bg-gray-200 p-0.5">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              aria-pressed={view === v.id}
              onClick={() => onView(v.id)}
              className={`rounded px-3 py-1 text-xs font-medium transition-colors ${view === v.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
            >
              {v.label}
            </button>
          ))}
        </div>
        <FindBox graph={graph} value={find} onChange={setFind} onGo={onFind} box={findBox} />
        {loaded && (
          // While something is searched only that count: the header keeps its one line
          <span className="text-xs text-gray-500" data-testid="idea-counts">
            {matches ? `${matches.size} found` : (
              <>
                {written} {written === 1 ? 'concept' : 'concepts'}
                {unwritten > 0 && ` · ${unwritten} not written yet`}
              </>
            )}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button type="button" className={BUTTON} onClick={map.refresh} title="Read every file again">Refresh</button>
          {canEdit && (
            <button
              ref={addButton}
              type="button"
              className={PRIMARY_BUTTON}
              disabled={!map.ready || questionFor !== null}
              title={questionFor ? QUESTION_OPEN : undefined}
              onClick={() => openForm({ kind: 'add', name: '' })}
            >
              Add concept
            </button>
          )}
        </div>
      </div>

      {graph.cycles.length > 0 && (
        <div className="border-b border-red-200 bg-red-50 px-6 py-2 text-xs text-red-700" role="alert">
          {graph.cycles.map((cycle) => (
            <p key={cycle.join('|')}>
              These concepts require each other in a circle: {cycle.map((key) => graph.byKey.get(key)?.name ?? key).join(', ')}
            </p>
          ))}
        </div>
      )}

      {chosenKeys.length > 0 && (
        <SelectionBar
          graph={graph}
          keys={chosenKeys}
          profiles={map.profiles}
          deleteNote={map.deleteNote}
          onClear={() => setChosen([])}
          onDelete={async (keys) => {
            const failed = await map.deleteIdeas(keys);
            // Stopped half way: what is gone leaves the selection by itself
            if (!failed) {
              setChosen([]);
              say(`Deleted ${keys.length === 1 ? '1 concept' : `${keys.length} concepts`}.`);
              focusOn({ to: 'find' });
            }
            return failed;
          }}
        />
      )}

      <div className="relative flex min-h-0 flex-1">
        {notice && (
          <p
            className={`pointer-events-none absolute left-1/2 top-3 z-30 max-w-[calc(100%-2rem)] -translate-x-1/2 rounded border px-3 py-1.5 text-sm shadow ${notice.kind === 'done' ? 'border-green-200 bg-green-50 text-green-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}
            role="status"
            data-testid="idea-notice"
          >
            {notice.text}
          </p>
        )}
        <div className="min-w-0 flex-1" key={profile}>
          {!map.ready ? (
            <p className="px-6 py-6 text-sm text-gray-500">Loading…</p>
          ) : map.total === 0 ? (
            <p className="px-6 py-6 text-sm text-gray-500">
              {map.profiles ? 'No concepts in this profile yet.' : `No concepts in ${IDEAS_SHARED_FOLDER}/${folder} yet.`}{canEdit && ' Add the first one with "Add concept".'}
            </p>
          ) : !loaded ? (
            <p className="px-6 py-6 text-sm text-gray-500" role="status">Reading {map.read} of {map.total} concepts…</p>
          ) : view === 'map' ? (
            <IdeaMapDrawing {...views} />
          ) : view === 'order' ? (
            <IdeaOrderView {...views} />
          ) : view === 'walk' ? (
            // What was seen is remembered per set of concepts: a profile where there are profiles, else the folder
            <IdeaWalkView {...views} seenSet={profile === undefined ? `folder:${folder}` : `profile:${profile}`} />
          ) : (
            <IdeaTableView {...views} />
          )}
        </div>
        {(mode || questionNode || selectedNode) && (
          <div className="absolute inset-y-0 right-0 z-20 w-full max-w-sm border-l border-gray-200 bg-white shadow-lg md:static md:w-80 md:shrink-0 md:shadow-none lg:w-96">
            {questionNode ? (
              <QuestionForm
                key={`${questionNode.key}:${questionEdit ? questionEdit.index : 'new'}`}
                ideaName={questionNode.name}
                initial={questionEdit ? questionAsNew(questionEdit.before) ?? undefined : undefined}
                onCancel={() => {
                  setQuestionFor(null);
                  focusOn({ to: 'panel' });
                }}
                onSubmit={async (question) => {
                  const failed = questionEdit
                    ? await map.editQuestion(questionNode.key, questionEdit.index, questionEdit.before, question)
                    : await map.addQuestion(questionNode.key, question);
                  if (!failed) {
                    setQuestionFor(null);
                    say(questionEdit ? `Saved question ${questionEdit.index + 1} of "${questionNode.name}".` : `Added the question to "${questionNode.name}".`);
                    focusOn({ to: 'panel' });
                  }
                  return failed;
                }}
              />
            ) : mode ? (
              <IdeaForm
                key={mode.kind === 'add' ? `add:${mode.name}` : `${mode.kind}:${mode.key}`}
                mode={mode}
                initial={mode.kind === 'edit' ? editBefore ?? undefined : undefined}
                graph={graph}
                fileNames={map.fileNames}
                picks={picks}
                onPicks={(next) => {
                  setPicks(next);
                  setPickNote(null);
                }}
                before={before}
                clickList={clickList}
                onClickList={(list) => {
                  setClickList(list);
                  setPickNote(null);
                }}
                note={pickNote}
                onCancel={() => {
                  setMode(null);
                  focusOn({ to: 'panel' });
                }}
                onSubmit={submit}
              />
            ) : selectedNode && (
              <IdeaPanel
                key={selectedNode.key}
                node={selectedNode}
                graph={graph}
                lensDoc={map.lensDoc}
                canEdit={canEdit}
                deleteNote={map.deleteNote}
                onSelect={(key) => {
                  setSelected(key);
                  // The name pressed goes with the panel it was in
                  focusOn({ to: 'panel' });
                }}
                onClose={() => {
                  setSelected(null);
                  focusOn({ to: 'idea', key: selectedNode.key });
                }}
                onCreate={() => openForm({ kind: 'add', name: selectedNode.name })}
                onEdit={() => editIdea(selectedNode.key)}
                onDelete={async () => {
                  // One that is not written yet has no file: every link to it goes instead
                  const failed = selectedNode.docId ? await map.deleteIdea(selectedNode.key) : await map.deleteIdeas([selectedNode.key]);
                  // An idea other files still name stays on the map as "not written yet"
                  if (!failed) {
                    setSelected(null);
                    say(selectedNode.docId ? `Deleted "${selectedNode.name}".` : `Removed the links to "${selectedNode.name}".`);
                    focusOn({ to: 'find' });
                  }
                  return failed;
                }}
                onEditRequirements={() => editRequirements(selectedNode.key)}
                onAddQuestion={() => setQuestionFor({ key: selectedNode.key })}
                onEditQuestion={(index) => {
                  const before = selectedNode.idea?.questionList[index];
                  if (before) setQuestionFor({ key: selectedNode.key, edit: { index, before } });
                }}
                onDeleteQuestion={async (index) => {
                  const before = selectedNode.idea?.questionList[index];
                  if (!before) return null;
                  const failed = await map.deleteQuestion(selectedNode.key, index, before);
                  if (!failed) say(`Deleted question ${index + 1} of "${selectedNode.name}".`);
                  return failed;
                }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
