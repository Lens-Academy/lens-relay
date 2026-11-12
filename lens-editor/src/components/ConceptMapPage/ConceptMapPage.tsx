import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { IDEAS_FOLDER, IDEAS_SHARED_FOLDER, ideaKey, togglePick, type Picks } from '../../lib/idea-map';
import { PathExistsError } from '../../lib/relay-api';
import { IdeaForm, type FormMode, type IdeaFields } from './IdeaForm';
import { IdeaMapDrawing } from './IdeaMapDrawing';
import { IdeaOrderView } from './IdeaOrderView';
import { IdeaPanel } from './IdeaPanel';
import { IdeaTableView } from './IdeaTableView';
import { QuestionForm } from './QuestionForm';
import { BUTTON, PRIMARY_BUTTON, type PickMarks } from './ideaLook';
import { useIdeaMap } from './useIdeaMap';

const VIEWS = [
  { id: 'map', label: 'Map' },
  { id: 'order', label: 'Order' },
  { id: 'table', label: 'Table' },
] as const;
type ViewId = (typeof VIEWS)[number]['id'];

const NO_PICKS: Picks = { requires: [], helpful: [] };

/**
 * The creator's concept map of the Context Accelerator (/concept-map): the
 * idea files of `Lens Edu/Context Accelerator LOs/` as a graph, read live,
 * in three views with a side panel; links that can edit also add ideas,
 * change requirements and add questions from it.
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
  const [picks, setPicks] = useState<Picks>(NO_PICKS);
  /** The requirements as they were when "Edit requirements" opened. */
  const [before, setBefore] = useState<Picks>(NO_PICKS);
  const [clickList, setClickList] = useState<keyof Picks>('requires');
  /** Key of the idea a question is being added to. */
  const [questionFor, setQuestionFor] = useState<string | null>(null);

  // The views wait until every file is read once, so the map is not laid out
  // again for each file that arrives; later additions just appear.
  const [loaded, setLoaded] = useState(false);
  if (!loaded && map.ready && map.total > 0 && map.read === map.total) setLoaded(true);

  const matches = useMemo(() => {
    const wanted = find.trim().toLowerCase();
    return wanted ? new Set(graph.nodes.filter((node) => node.key.includes(wanted)).map((node) => node.key)) : null;
  }, [find, graph]);
  const marks = useMemo<PickMarks | null>(() => (mode ? {
    requires: new Set(picks.requires.map(ideaKey)),
    helpful: new Set(picks.helpful.map(ideaKey)),
    self: mode.kind === 'requirements' ? mode.key : null,
  } : null), [mode, picks]);

  const openForm = (next: FormMode, start: Picks = NO_PICKS) => {
    setMode(next);
    setPicks(start);
    setBefore(start);
    setClickList('requires');
  };
  const editRequirements = (key: string) => {
    const node = graph.byKey.get(key);
    if (!node) return;
    const names = (keys: string[]) => keys.map((k) => graph.byKey.get(k)?.name ?? k);
    openForm({ kind: 'requirements', key }, { requires: names(node.requires), helpful: names(node.helpful) });
  };

  /** A click on an idea in any view: select it, or, while a form is open, pick it. */
  const onPick = (key: string, shift: boolean) => {
    // The question form belongs to one idea: a click elsewhere must not lose what is typed
    if (questionFor) return;
    if (!mode) {
      setSelected(key);
      return;
    }
    const node = graph.byKey.get(key);
    if (!node || (mode.kind === 'requirements' && mode.key === key)) return;
    setPicks((current) => togglePick(current, node.name, shift ? 'helpful' : clickList));
  };

  const submit = async (fields: IdeaFields | null): Promise<string | null> => {
    if (!mode) return null;
    try {
      if (mode.kind === 'requirements') {
        const failed = await map.saveRequirements(mode.key, before, picks);
        if (failed) return failed;
        setSelected(mode.key);
      } else if (fields) {
        // An idea is never its own requirement
        const own = ideaKey(fields.name);
        const others = (names: string[]) => names.filter((name) => ideaKey(name) !== own);
        await map.createIdea({ ...fields, requires: others(picks.requires), helpful: others(picks.helpful) });
        setSelected(own);
      }
    } catch (error) {
      if (error instanceof PathExistsError) return 'A file with this name already exists.';
      return error instanceof Error ? error.message : String(error);
    }
    setMode(null);
    return null;
  };

  const selectedNode = selected ? graph.byKey.get(selected) : undefined;
  const questionNode = questionFor ? graph.byKey.get(questionFor) : undefined;
  const written = graph.nodes.filter((node) => node.written).length;
  const unwritten = graph.nodes.length - written;
  const views = { graph, selected: mode ? null : selected, marks, matches, onPick };

  return (
    <div className="flex h-full flex-col" data-testid="concept-map-page">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-gray-200 px-6 py-3">
        <h1 className="text-xl font-semibold text-gray-800">Concept map</h1>
        {map.folders.length > 1 ? (
          <select className="lens-input" aria-label="Folder" value={folder} onChange={(e) => onFolder(e.target.value)}>
            {map.folders.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        ) : (
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
        <input
          type="search"
          className="lens-input w-44"
          placeholder="Find a concept"
          aria-label="Find a concept"
          value={find}
          onChange={(e) => setFind(e.target.value)}
        />
        {loaded && (
          <span className="text-xs text-gray-500" data-testid="idea-counts">
            {written} {written === 1 ? 'concept' : 'concepts'}
            {unwritten > 0 && ` · ${unwritten} not written yet`}
            {matches && ` · ${matches.size} found`}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button type="button" className={BUTTON} onClick={map.refresh} title="Read every file again">Refresh</button>
          {canEdit && (
            <button type="button" className={PRIMARY_BUTTON} disabled={!map.ready || questionFor !== null} onClick={() => openForm({ kind: 'add', name: '' })}>
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

      <div className="relative flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {!map.ready ? (
            <p className="px-6 py-6 text-sm text-gray-500">Loading…</p>
          ) : map.total === 0 ? (
            <p className="px-6 py-6 text-sm text-gray-500">
              No concepts in {IDEAS_SHARED_FOLDER}/{folder} yet.{canEdit && ' Add the first one with "Add concept".'}
            </p>
          ) : !loaded ? (
            <p className="px-6 py-6 text-sm text-gray-500" role="status">Reading {map.read} of {map.total} concepts…</p>
          ) : view === 'map' ? (
            <IdeaMapDrawing {...views} />
          ) : view === 'order' ? (
            <IdeaOrderView {...views} />
          ) : (
            <IdeaTableView {...views} />
          )}
        </div>
        {(mode || questionNode || selectedNode) && (
          <div className="absolute inset-y-0 right-0 z-20 w-full max-w-sm border-l border-gray-200 bg-white shadow-lg md:static md:w-80 md:shrink-0 md:shadow-none lg:w-96">
            {questionNode ? (
              <QuestionForm
                key={questionNode.key}
                ideaName={questionNode.name}
                onCancel={() => setQuestionFor(null)}
                onSubmit={async (question) => {
                  const failed = await map.addQuestion(questionNode.key, question);
                  if (!failed) setQuestionFor(null);
                  return failed;
                }}
              />
            ) : mode ? (
              <IdeaForm
                key={mode.kind === 'add' ? `add:${mode.name}` : `requirements:${mode.key}`}
                mode={mode}
                graph={graph}
                fileNames={map.fileNames}
                picks={picks}
                onPicks={setPicks}
                clickList={clickList}
                onClickList={setClickList}
                onCancel={() => setMode(null)}
                onSubmit={submit}
              />
            ) : selectedNode && (
              <IdeaPanel
                node={selectedNode}
                graph={graph}
                lensDoc={map.lensDoc}
                canEdit={canEdit}
                onSelect={setSelected}
                onClose={() => setSelected(null)}
                onCreate={() => openForm({ kind: 'add', name: selectedNode.name })}
                onEditRequirements={() => editRequirements(selectedNode.key)}
                onAddQuestion={() => setQuestionFor(selectedNode.key)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
