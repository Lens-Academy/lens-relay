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
  ideaEditChanges,
  ideaKey,
  ideaNameProblem,
  mergePicks,
  newQuestionProblem,
  parseIdea,
  questionChanges,
  questionDeleteChanges,
  questionEditChanges,
  removeLinkChanges,
  renameLinkChanges,
  renderIdeaFile,
  renderQuestion,
  requirementChanges,
  type IdeaEdit,
  type IdeaGraph,
  type IdeaNode,
  type IdeaQuestion,
  type NewIdea,
  type NewQuestion,
  type Picks,
} from '../../lib/idea-map';
import { attachProvenanceRegistration, humanActor } from '../../lib/provenance';
import {
  TrashRefusedError,
  createDocument,
  createFolder,
  deleteErrorMessage,
  generateUUID,
  moveErrorMessage,
  movePath,
  trashPath,
} from '../../lib/relay-api';
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
  /**
   * Save the "Edit concept" form: `before` is what the form was opened with
   * (`ideaAsEdit`), `after` what it holds now. Only the parts that differ are
   * written (ideaEditChanges); a file that no longer says `before` is left
   * alone (IDEA_MOVED_ERROR). A changed `after.name` renames the file, after
   * the other changes: the relay's move rewrites the `[[links]]` to it in
   * other files, and what it left under Requires / Helpful first is rewritten
   * here. The idea's key is `ideaKey(after.name)` afterwards. Resolves to an
   * error to show, or null.
   */
  editIdea: (key: string, before: IdeaEdit, after: IdeaEdit) => Promise<string | null>;
  /**
   * Delete an idea: its links are taken out of the other ideas' Requires /
   * Helpful first, then its file goes to the folder's `_trash/` (the editor's
   * normal delete; a move back restores it). Nothing is changed when a file
   * outside the map links to it, or when a link cannot be taken out safely.
   * Resolves to an error to show, or null.
   */
  deleteIdea: (key: string) => Promise<string | null>;
  /** What becomes of a deleted idea's file, said before it is deleted. */
  deleteNote?: string;
  /**
   * Save the "Edit question" form for the `index`-th question of an idea
   * (place in `idea.questionList`): `before` is the question the form was
   * opened with, `after` what the form holds now. Resolves to an error to
   * show, or null.
   */
  editQuestion: (key: string, index: number, before: IdeaQuestion, after: NewQuestion) => Promise<string | null>;
  /** Take the `index`-th question out of an idea's file, when it still is
   *  `before`; resolves to an error to show, or null. */
  deleteQuestion: (key: string, index: number, before: IdeaQuestion) => Promise<string | null>;
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

  const editQuestion = useCallback<IdeaMap['editQuestion']>(
    (key, index, before, after) => editFile(key, (text) => questionEditChanges(text, index, before, after)),
    [editFile],
  );

  const deleteQuestion = useCallback<IdeaMap['deleteQuestion']>(
    (key, index, before) => editFile(key, (text) => questionDeleteChanges(text, index, before)),
    [editFile],
  );

  /** The path the relay knows an idea's file by ("Lens Edu/<folder>/<name>.md"). */
  const relayPath = useCallback((name: string) => `${IDEAS_SHARED_FOLDER}/${folder}/${name}.md`, [folder]);
  /** The written ideas that name `node` under Requires or Helpful first. */
  const linkersOf = useCallback((node: IdeaNode) => [...new Set([...node.neededFor, ...node.helpfulFor])]
    .map((other) => graph.byKey.get(other))
    .filter((other): other is IdeaNode & { docId: string } => Boolean(other?.docId)), [graph]);

  const editIdea = useCallback<IdeaMap['editIdea']>(async (key, before, after) => {
    const node = graph.byKey.get(ideaKey(key));
    if (!node?.docId) return 'This concept has no file yet.';
    const name = after.name.trim();
    const renamed = name !== node.name;
    if (renamed) {
      const problem = ideaNameProblem(name, files.map((f) => f.name).filter((other) => other !== node.name));
      if (problem) return problem;
    }
    // An idea is never its own requirement, under the old name or the new
    const own = new Set([node.key, ideaKey(name)]);
    const others = (names: string[]) => names.filter((other) => !own.has(ideaKey(other)));
    const wanted = { ...after, requires: others(after.requires), helpful: others(after.helpful) };
    const failed = await editFile(key, (text) => ideaEditChanges(text, before, wanted));
    if (failed || !renamed) return failed;

    try {
      await movePath(relayPath(node.name), `/${folder}/${name}.md`);
    } catch (error) {
      return `The other changes are saved, but the rename failed: ${moveErrorMessage(error, `${name}.md`)}. Close this form and open it again.`;
    }
    // The relay rewrites the links to a moved file. Read the files that named
    // it again, and rewrite here what is still under the old name.
    const left: IdeaNode[] = [];
    await Promise.all(linkersOf(node).map(async (linker) => {
      const text = await refreshSnapshot(`${RELAY_ID}-${linker.docId}`).catch(() => null);
      const rest = text == null ? null : renameLinkChanges(text, node.name, name);
      if (!rest || 'error' in rest || rest.changes.length > 0) left.push(linker);
    }));
    const unchanged: string[] = [];
    for (const linker of left) {
      if (await editFile(linker.key, (text) => renameLinkChanges(text, node.name, name))) unchanged.push(linker.name);
    }
    return unchanged.length > 0
      ? `The concept is renamed, but the link to it in ${unchanged.join(', ')} still has the old name. Change it in the file.`
      : null;
  }, [graph, files, folder, editFile, relayPath, linkersOf]);

  const deleteIdea = useCallback<IdeaMap['deleteIdea']>(async (key) => {
    const node = graph.byKey.get(ideaKey(key));
    if (!node?.docId) return 'This concept has no file yet.';
    const linkers = linkersOf(node);
    // Before anything is written: can every link be taken out?
    for (const linker of linkers) {
      const text = texts.get(linker.docId);
      const check = text === undefined ? null : removeLinkChanges(text, node.name);
      if (check && 'error' in check) return `Nothing was deleted. In "${linker.name}": ${check.error}`;
    }
    // Without force the relay refuses while other files link to this one, and
    // names them: a file outside the map that links here stops the delete.
    let trashed = false;
    try {
      await trashPath(relayPath(node.name));
      trashed = true;
    } catch (error) {
      if (!(error instanceof TrashRefusedError)) return deleteErrorMessage(error);
      const known = new Set(linkers.map((linker) => relayPath(linker.name).toLowerCase()));
      const outside = error.referencing.map((doc) => doc.path).filter((path) => !known.has(path.toLowerCase()));
      if (outside.length > 0) {
        return `Nothing was deleted: ${outside.join(', ')} ${outside.length === 1 ? 'links' : 'link'} to this concept too. Take that link out first, or delete the file in the file tree.`;
      }
    }
    for (const linker of linkers) {
      const failed = await editFile(linker.key, (text) => removeLinkChanges(text, node.name));
      if (failed) return `${trashed ? 'The concept is deleted, but its link is still in' : 'The concept is not deleted. In'} "${linker.name}": ${failed}`;
    }
    if (trashed) return null;
    try {
      await trashPath(relayPath(node.name), true);
    } catch (error) {
      return `The links to this concept are taken out, but its file is not deleted: ${deleteErrorMessage(error)}`;
    }
    return null;
  }, [graph, texts, editFile, relayPath, linkersOf]);

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
    editIdea,
    deleteIdea,
    deleteNote: `The file moves to the trash (${IDEAS_SHARED_FOLDER}/_trash). It can be moved back from there until the relay empties the trash (after 10 days, unless it is set otherwise).`,
    editQuestion,
    deleteQuestion,
  };
}
