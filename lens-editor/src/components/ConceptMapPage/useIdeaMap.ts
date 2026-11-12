import { useCallback, useEffect, useMemo, useRef } from 'react';
import { RELAY_ID } from '../../App';
import { useDisplayName } from '../../contexts/DisplayNameContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { resolvePageName } from '../../lib/document-resolver';
import { refreshSnapshot, setSnapshot, withLiveDoc } from '../../lib/embed-docs';
import {
  IDEAS_FOLDER,
  IDEAS_SHARED_FOLDER,
  buildIdeaGraph,
  ideaKey,
  mergePicks,
  newQuestionProblem,
  parseIdea,
  questionChanges,
  renderIdeaFile,
  renderQuestion,
  requirementChanges,
  type IdeaGraph,
  type NewIdea,
  type NewQuestion,
  type Picks,
} from '../../lib/idea-map';
import { attachProvenanceRegistration, humanActor } from '../../lib/provenance';
import { createDocument, createFolder, generateUUID } from '../../lib/relay-api';
import { useSnapshots } from '../ConceptRowsPanel/useConceptRows';

export interface IdeaMap {
  /** The folder shown, as a path in the tree ("/Lens Edu/Context Accelerator LOs"). */
  folderPath: string;
  /** Folders that hold ideas: the real one, and test sets next to it on a local relay. */
  folders: string[];
  graph: IdeaGraph;
  /** Names of every file in the folder, skipped ones (`_Template`) included. */
  fileNames: string[];
  /** Idea files in the folder, and how many of them are read so far. */
  total: number;
  read: number;
  /** The folder list itself has arrived. */
  ready: boolean;
  /** Read every file again. */
  refresh: () => void;
  /** The doc a Learn link points to (bare uuid), or null. */
  lensDoc: (link: string) => string | null;
  /** Write a new idea file; resolves once it is on the map and its text is stored. */
  createIdea: (idea: Omit<NewIdea, 'id'> & { name: string }) => Promise<void>;
  /** Change an idea's requirements from `before` to `after`; resolves to an
   *  error to show, or null. */
  saveRequirements: (key: string, before: Picks, after: Picks) => Promise<string | null>;
  /** Add a question at the end of an idea's `## Questions`; resolves to an
   *  error to show, or null. */
  addQuestion: (key: string, question: NewQuestion) => Promise<string | null>;
}

/**
 * The ideas of `Lens Edu/<folder>/` as a graph, read through the snapshot
 * cache (three files at a time, lib/embed-docs.ts) and kept fresh while the
 * page is open: every file is read again when the page opens, on window
 * focus and every few minutes (useSnapshots).
 */
export function useIdeaMap(folder: string = IDEAS_FOLDER): IdeaMap {
  const { metadata, folderDocs } = useNavigation();
  const { displayName } = useDisplayName();
  const displayNameRef = useRef(displayName);
  displayNameRef.current = displayName;

  const shared = `/${IDEAS_SHARED_FOLDER}/`;
  const folderPath = `${shared}${folder}`;

  const folders = useMemo(() => {
    const found = new Set<string>([IDEAS_FOLDER]);
    for (const path of Object.keys(metadata)) {
      if (!path.startsWith(shared)) continue;
      const top = path.slice(shared.length).split('/')[0];
      if (top.toLowerCase().startsWith(IDEAS_FOLDER.toLowerCase()) && !/\.\w+$/.test(top)) found.add(top);
    }
    return [...found].sort((a, b) => a.length - b.length || a.localeCompare(b));
  }, [metadata, shared]);

  const files = useMemo(() => {
    const prefix = `${folderPath}/`;
    return Object.entries(metadata)
      .filter(([path, meta]) => path.startsWith(prefix) && meta.type === 'markdown' && /\.md$/i.test(path))
      .map(([path, meta]) => ({ name: path.slice(prefix.length, -3), docId: meta.id }))
      // Files directly in the folder: a subfolder is not part of the map
      .filter((file) => !file.name.includes('/'))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [metadata, folderPath]);
  const ideaFiles = useMemo(() => files.filter((f) => !f.name.startsWith('_')), [files]);
  const ids = useMemo(() => ideaFiles.map((f) => f.docId), [ideaFiles]);
  const { texts, failed } = useSnapshots(ids, true);

  // A file edited in the editor a moment ago is newer than its snapshot:
  // read each file once more when the page opens.
  const refreshed = useRef(new Set<string>());
  useEffect(() => {
    for (const id of ids) {
      if (refreshed.current.has(id)) continue;
      refreshed.current.add(id);
      refreshSnapshot(`${RELAY_ID}-${id}`).catch(() => {});
    }
  }, [ids]);
  const refresh = useCallback(() => {
    for (const id of ids) refreshSnapshot(`${RELAY_ID}-${id}`).catch(() => {});
  }, [ids]);

  const lensDoc = useCallback(
    (link: string) => resolvePageName(link, metadata, `${folderPath}/x.md`)?.docId ?? null,
    [metadata, folderPath],
  );

  const read = ideaFiles.filter((f) => texts.has(f.docId) || failed.has(f.docId)).length;
  const graph = useMemo(
    () => buildIdeaGraph(
      // Until a file is read it is left out, so the map never shows it as empty
      ideaFiles
        .filter((f) => texts.has(f.docId) || failed.has(f.docId))
        .map((f) => ({ ...f, text: texts.get(f.docId) ?? null })),
      { lensExists: (link) => lensDoc(link) !== null },
    ),
    [ideaFiles, texts, failed, lensDoc],
  );

  const createIdea = useCallback<IdeaMap['createIdea']>(async ({ name, ...idea }) => {
    const folderDoc = folderDocs.get(IDEAS_SHARED_FOLDER);
    if (!folderDoc) throw new Error(`folder ${IDEAS_SHARED_FOLDER} not loaded`);
    if (!folderDoc.getMap('filemeta_v0').has(`/${folder}`)) createFolder(folderDoc, `/${folder}`);
    const text = renderIdeaFile({ ...idea, id: generateUUID() });
    const docId = await createDocument(folderDoc, `/${folder}/${name.trim()}.md`, 'markdown', text);
    // Shown at once; the read after it tells whether the text arrived
    // (createDocument only logs when writing it fails).
    setSnapshot(`${RELAY_ID}-${docId}`, text);
    const stored = await refreshSnapshot(`${RELAY_ID}-${docId}`);
    if (stored !== text) throw new Error('The file was made, but its text was not written. Open the file to fill it in.');
  }, [folderDocs, folder]);

  /** Make the changes `changesFor` works out from the live text of an idea's
   *  file, as one collaborative edit; resolves to an error to show, or null. */
  const editFile = useCallback(async (key: string, changesFor: (text: string) => ReturnType<typeof requirementChanges>) => {
    const node = graph.byKey.get(ideaKey(key));
    if (!node?.docId) return 'This concept has no file yet.';
    const getActor = () => humanActor(displayNameRef.current ?? '');
    const result = await withLiveDoc(`${RELAY_ID}-${node.docId}`, ({ doc }) => {
      const ytext = doc.getText('contents');
      const outcome = changesFor(ytext.toString());
      if ('error' in outcome) return outcome.error;
      const detach = attachProvenanceRegistration(doc, getActor);
      try {
        doc.transact(() => {
          // From the last change back, so earlier positions stay valid
          for (const change of [...outcome.changes].reverse()) {
            if (change.to > change.from) ytext.delete(change.from, change.to - change.from);
            if (change.insert) ytext.insert(change.from, change.insert);
          }
        });
      } finally {
        detach();
      }
      return '';
    });
    if (result === null) return 'Another file was opened for editing meanwhile. Try again.';
    return result || null;
  }, [graph]);

  const saveRequirements = useCallback<IdeaMap['saveRequirements']>((key, before, after) => editFile(key, (text) => {
    const live = parseIdea(text);
    const wanted = mergePicks({ requires: live.requires, helpful: live.helpful }, before, after);
    return requirementChanges(text, wanted.requires, wanted.helpful);
  }), [editFile]);

  const addQuestion = useCallback<IdeaMap['addQuestion']>(async (key, question) => {
    const problem = newQuestionProblem(question);
    if (problem) return problem;
    const segment = renderQuestion({ ...question, id: generateUUID() });
    return editFile(key, (text) => questionChanges(text, segment));
  }, [editFile]);

  return {
    folderPath,
    folders,
    graph,
    fileNames: files.map((f) => f.name),
    total: ideaFiles.length,
    read,
    ready: folderDocs.has(IDEAS_SHARED_FOLDER),
    refresh,
    lensDoc,
    createIdea,
    saveRequirements,
    addQuestion,
  };
}
