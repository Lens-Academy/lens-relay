import { useCallback, useEffect, useMemo, useRef } from 'react';
import { RELAY_ID } from '../../App';
import { useDisplayName } from '../../contexts/DisplayNameContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { backlinkSources } from '../../lib/backlinks';
import { resolvePageName } from '../../lib/document-resolver';
import { refreshSnapshot, setSnapshot, withLiveDoc } from '../../lib/embed-docs';
import {
  IDEAS_FOLDER,
  IDEAS_SHARED_FOLDER,
  buildIdeaGraph,
  deletePlan,
  deletePlanChanges,
  dependentEdits,
  dependentLinkChanges,
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
  removeLinksChanges,
  renameLinkChanges,
  renderIdeaFile,
  renderQuestion,
  requirementChanges,
  type DependentEdit,
  type Dependents,
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
import { listed } from './ideaLook';

/**
 * Profiles: separate sets of concepts to switch between. Optional: a hook
 * that has none leaves `IdeaMap.profiles` out, and the page shows nothing of
 * it (the editor's own hook does so; the standalone map provides them).
 */
export interface IdeaProfiles {
  current: string;
  /** Every profile, the current one included. */
  names: string[];
  /** Switch to another profile; the hook reloads the graph. */
  open: (name: string) => void;
  /** A new profile, empty or as a copy of `copyFrom`. The hook opens it on
   *  success unless `open` is false. Resolves to an error to show, or null. */
  create: (name: string, copyFrom?: string, open?: boolean) => Promise<string | null>;
  rename: (name: string, to: string) => Promise<string | null>;
  /** Not offered for the last profile left. */
  remove: (name: string) => Promise<string | null>;
  /** Copy these concepts (whole files, questions included) from the current
   *  profile into another. `keys` are keys of written concepts; `copied` and
   *  `skipped` (already there, `replace` false) are their names. */
  copyTo: (keys: string[], target: string, replace: boolean) => Promise<{ error: string } | { copied: string[]; skipped: string[] }>;
}

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
  /**
   * Write a new idea file; resolves once it is on the map and its text is
   * stored. `neededFor` / `helpfulFor` are names of written ideas: the new one
   * is added to the `## Requires` / `## Helpful first` of each, after its own
   * file is made (nothing is taken out of a file here). Everything is checked
   * before anything is written (`dependentEdits`). Throws an error to show;
   * when it stops half way, the error says what was written.
   */
  createIdea: (idea: Omit<NewIdea, 'id'> & { name: string } & Partial<Dependents>) => Promise<void>;
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
   * here. The idea's key is `ideaKey(after.name)` afterwards.
   *
   * `neededFor` / `helpfulFor` live in the other ideas' files: an idea added
   * to one of them gets this one under its `## Requires` / `## Helpful first`,
   * one taken out loses the link (`dependentsDiff`, `dependentLinkChanges`).
   * Everything is checked before anything is written (`dependentEdits`);
   * those files are written last, under the idea's new name. When it stops
   * half way, the error says what was written. Resolves to an error to show,
   * or null.
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
  /**
   * Delete several ideas at once (`deletePlan`): the files of the written
   * ones go to the trash, and every link to any of them, written or not,
   * leaves the Requires / Helpful first of the ideas that stay. Everything
   * is checked before anything is written. The links are taken out first,
   * then the files go one after another; when it stops half way the error
   * says exactly which were deleted and which were not. Resolves to an error
   * to show, or null.
   */
  deleteIdeas: (keys: string[]) => Promise<string | null>;
  /** What becomes of a deleted idea's file, said before it is deleted. */
  deleteNote?: string;
  /** Separate sets of concepts to switch between, where there are any. */
  profiles?: IdeaProfiles;
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

  /** The text of an idea's file as last read, for a check before anything is written. */
  const textOf = useCallback((node: IdeaNode) => (node.docId ? texts.get(node.docId) : undefined), [texts]);

  /**
   * Write the idea `name` into (or take it out of) the Requires / Helpful
   * first of other ideas, one file after another: which files were written,
   * and when it stopped, which were not and why.
   */
  const linkDependents = useCallback(async (name: string, edits: DependentEdit[], formerNames: string[] = []) => {
    const done: string[] = [];
    for (const [index, { node, list }] of edits.entries()) {
      const failed = await editFile(node.key, (text) => dependentLinkChanges(text, name, list, formerNames));
      if (failed) return { done, left: edits.slice(index).map((edit) => edit.node.name), error: `In "${node.name}": ${failed}` };
      done.push(node.name);
    }
    return { done, left: [] as string[], error: null };
  }, [editFile]);

  const createIdea = useCallback<IdeaMap['createIdea']>(async ({ name, neededFor = [], helpfulFor = [], ...idea }) => {
    const folderDoc = folderDocs.get(IDEAS_SHARED_FOLDER);
    if (!folderDoc) throw new Error(`folder ${IDEAS_SHARED_FOLDER} not loaded`);
    const title = name.trim();
    // Before anything is written: can the new idea go into every file picked
    // under Needed for / Helpful for?
    const links = dependentEdits(graph, { name: title, requires: idea.requires }, { neededFor: [], helpfulFor: [] }, { neededFor, helpfulFor }, textOf);
    if ('error' in links) throw new Error(`Nothing was created. ${links.error}`);
    if (!folderDoc.getMap('filemeta_v0').has(`/${folder}`)) createFolder(folderDoc, `/${folder}`);
    const text = renderIdeaFile({ ...idea, id: generateUUID() });
    const docId = await createDocument(folderDoc, `/${folder}/${title}.md`, 'markdown', text);
    // Shown at once; the read after it tells whether the text arrived
    // (createDocument only logs when writing it fails).
    setSnapshot(`${RELAY_ID}-${docId}`, text);
    const stored = await refreshSnapshot(`${RELAY_ID}-${docId}`);
    if (stored !== text) throw new Error('The file was made, but its text was not written. Open the file to fill it in.');
    const linked = await linkDependents(title, links.edits);
    if (linked.error) {
      throw new Error(
        `The concept is created${linked.done.length > 0 ? ` and added to ${listed(linked.done)}` : ''}, but it is not added to ${listed(linked.left)}. `
        + `${linked.error} Close this form; "Edit concept" can add the rest.`,
      );
    }
  }, [folderDocs, folder, graph, textOf, linkDependents]);

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
    // Before anything is written: the files of the ideas under Needed for /
    // Helpful for that gain or lose a link, and this idea's own file
    const links = dependentEdits(graph, { name: node.name, requires: wanted.requires }, before, wanted, textOf);
    if ('error' in links) return `Nothing was saved. ${links.error}`;
    const ownText = textOf(node);
    const check = ownText == null || links.edits.length === 0 ? null : ideaEditChanges(ownText, before, wanted);
    if (check && 'error' in check) return check.error;

    const failed = await editFile(key, (text) => ideaEditChanges(text, before, wanted));
    if (failed) return failed;

    const said: string[] = [];
    if (renamed) {
      try {
        await movePath(relayPath(node.name), `/${folder}/${name}.md`);
      } catch (error) {
        return `The other changes are saved, but the rename failed: ${moveErrorMessage(error, `${name}.md`)}.`
          + `${links.edits.length > 0 ? ' Needed for and Helpful for are not changed either.' : ''} Close this form and open it again.`;
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
      if (unchanged.length > 0) said.push(`The concept is renamed, but the link to it in ${unchanged.join(', ')} still has the old name. Change it in the file.`);
    }

    // Last, under the name the idea has now: the other ideas' files
    const linked = await linkDependents(name, links.edits, renamed ? [node.name] : []);
    if (linked.error) {
      said.push(
        `The concept's own changes are saved${renamed ? ' and it is renamed' : ''}${linked.done.length > 0 ? `; ${listed(linked.done)} ${linked.done.length === 1 ? 'is' : 'are'} changed too` : ''}. `
        + `Not changed: ${listed(linked.left)}. ${linked.error} Close this form and open it again.`,
      );
    }
    return said.length > 0 ? said.join(' ') : null;
  }, [graph, files, folder, editFile, relayPath, linkersOf, textOf, linkDependents]);

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

  const deleteIdeas = useCallback<IdeaMap['deleteIdeas']>(async (keys) => {
    const plan = deletePlan(graph, keys);
    if (plan.files.length + plan.unwritten.length === 0) return 'These concepts are not on the map any more.';
    // Before anything is written: can every link be taken out?
    const check = deletePlanChanges(plan, (node) => (node.docId ? texts.get(node.docId) : undefined));
    if ('error' in check) return `Nothing was deleted. ${check.error}`;
    // … and does a file outside the map link to one of them? (the relay's index of links)
    const going = new Set(plan.files.map((node) => node.docId));
    const pathOf = (docId: string) => Object.entries(metadata).find(([, meta]) => meta.id === docId)?.[0].slice(1) ?? 'another file';
    const outside = plan.files.flatMap((node) => {
      const known = new Set(linkersOf(node).map((linker) => linker.docId));
      return backlinkSources(node.docId!, folderDocs.values())
        .filter((source) => !known.has(source) && !going.has(source))
        .map((source) => `${pathOf(source)} links to "${node.name}"`);
    });
    if (outside.length > 0) {
      return `Nothing was deleted: ${outside.join('; ')}. Take ${outside.length === 1 ? 'that link' : 'those links'} out first, or delete the ${plan.files.length === 1 ? 'file' : 'files'} in the file tree.`;
    }

    // The links first: until a file goes, nothing is lost
    const edited: string[] = [];
    for (const { node, names } of plan.losing) {
      const failed = await editFile(node.key, (text) => removeLinksChanges(text, names));
      if (failed) {
        return `No concept was deleted. In "${node.name}": ${failed}${edited.length > 0 ? ` The links are already taken out of ${edited.join(', ')}.` : ''}`;
      }
      edited.push(node.name);
    }

    // What may still link to a file that goes: the others that go, and the
    // files just changed (the relay's index of links can be a moment behind)
    const expected = new Set([...plan.files, ...plan.losing.map((entry) => entry.node)].map((node) => relayPath(node.name).toLowerCase()));
    const deleted: string[] = [];
    for (const [index, node] of plan.files.entries()) {
      let failed: string | null = null;
      try {
        await trashPath(relayPath(node.name));
      } catch (error) {
        if (!(error instanceof TrashRefusedError)) {
          failed = deleteErrorMessage(error);
        } else {
          const others = error.referencing.map((doc) => doc.path).filter((path) => !expected.has(path.toLowerCase()));
          if (others.length > 0) {
            failed = `${others.join(', ')} ${others.length === 1 ? 'links' : 'link'} to it`;
          } else {
            try {
              await trashPath(relayPath(node.name), true);
            } catch (forced) {
              failed = deleteErrorMessage(forced);
            }
          }
        }
      }
      if (failed) {
        const left = plan.files.slice(index).map((other) => other.name);
        return `${deleted.length > 0 ? `Deleted: ${deleted.join(', ')}. ` : ''}Not deleted: ${left.join(', ')}. "${node.name}": ${failed}.`
          + (plan.losing.length > 0 ? ' The links to all of them are already taken out of the other concepts.' : '');
      }
      deleted.push(node.name);
    }
    return null;
  }, [graph, texts, metadata, folderDocs, editFile, relayPath, linkersOf]);

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
    deleteIdeas,
    deleteNote: `The file moves to the trash (${IDEAS_SHARED_FOLDER}/_trash). It can be moved back from there until the relay empties the trash (after 10 days, unless it is set otherwise).`,
    editQuestion,
    deleteQuestion,
  };
}
