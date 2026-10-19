import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { useNavigation } from '../../contexts/NavigationContext';
import { useAuth } from '../../contexts/AuthContext';
import { useDisplayName } from '../../contexts/DisplayNameContext';
import { setSnapshot, withLiveDoc } from '../../lib/embed-docs';
import { attachProvenanceRegistration, humanActor } from '../../lib/provenance';
import { createDocument, createFolder, generateUUID } from '../../lib/relay-api';
import { computeRelativePath, resolvePageName } from '../../lib/document-resolver';
import {
  insertRowUnlessPresent,
  groupLensRows,
  lensSourceTargets,
  matchRule,
  newConceptText,
  rowLinkProblem,
  rowsFolder,
  sourceKind,
  type CollectedRows,
  type ConceptRowRule,
  type RowEntry,
  type SourceRows,
} from '../../lib/concept-rows';
import { RELAY_ID } from '../../App';
import { basenameOf } from '../../lib/course-tree';
import { docUuidFromCompoundId } from '../../lib/url-utils';
import { ConceptRowCard } from './ConceptRowCard';
import { ConceptPicker, type PickerConcept } from './ConceptPicker';
import { useConceptRows, useLensesUsing, type AddedSource } from './useConceptRows';
import { DocLink } from '../DocLink';

const OPEN_KEY = 'lens-editor:concept-rows-open';

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== 'false';
  } catch {
    return true;
  }
}

function writeOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, String(open));
  } catch {
    // storage unavailable
  }
}

interface PanelProps {
  /** Compound id (relay-doc) of the opened document. */
  docId: string;
  /** Its merged path, e.g. /Lens Edu/articles/x.md. */
  path: string | undefined;
  /** Its text, for a lens's article links. */
  ytext: Y.Text;
  /** The main editor is in Suggesting mode (row edits become suggestions). */
  suggestionMode?: boolean;
}

/**
 * Rows about the opened file from the files that hold them (concept files),
 * at the top of the document, for the files the rule table names
 * (lib/concept-rows.ts). Nothing for other files.
 */
export function ConceptRowsPanel(props: PanelProps) {
  const rule = matchRule(props.path);
  if (!rule || !props.path) return null;
  return <Panel {...props} path={props.path} rule={rule} />;
}

/** The lens's sources with rows of their own (articles, videos), resolved,
 *  kept up to date with its text. */
function useSources(rule: ConceptRowRule, ytext: Y.Text, path: string) {
  const enabled = !!rule.sourceContext;
  const { metadata } = useNavigation();
  const [targets, setTargets] = useState<string[]>([]);
  useEffect(() => {
    if (!enabled) return;
    const update = () => {
      const next = lensSourceTargets(ytext.toString());
      setTargets((prev) => (prev.join('\n') === next.join('\n') ? prev : next));
    };
    update();
    ytext.observe(update);
    return () => ytext.unobserve(update);
  }, [enabled, ytext]);
  return useMemo(() => {
    const out: Array<{ id: string; path: string; kind: string }> = [];
    for (const target of targets) {
      const resolved = resolvePageName(target, metadata, path);
      const kind = resolved && sourceKind(resolved.path, rule.sharedFolder);
      if (resolved && kind && !out.some((a) => a.id === resolved.docId)) {
        out.push({ id: resolved.docId, path: resolved.path, kind });
      }
    }
    return out;
  }, [targets, metadata, path, rule.sharedFolder]);
}

function Panel({ docId, path, ytext, rule, suggestionMode }: PanelProps & { path: string; rule: ConceptRowRule }) {
  const { metadata, folderDocs } = useNavigation();
  const { canEdit } = useAuth();
  const { displayName } = useDisplayName();
  const displayNameRef = useRef(displayName);
  displayNameRef.current = displayName;
  const getActor = useCallback(() => humanActor(displayNameRef.current ?? ''), []);

  const target = docUuidFromCompoundId(docId);
  const [open, setOpen] = useState(readOpen);
  const sources = useSources(rule, ytext, path);
  // An article or video: the lenses that use it (rule #10), in place of sources.
  const lensUse = useLensesUsing(rule, target, open);
  const related = useMemo(
    () => (rule.lensContext
      ? lensUse.lenses.map((l) => ({ id: l.id, path: l.path, kind: 'Lens' }))
      : sources),
    [rule.lensContext, lensUse.lenses, sources],
  );
  const targets = useMemo(() => [target, ...related.map((a) => a.id)], [target, related]);
  const [added, setAdded] = useState<AddedSource[]>([]);
  const { byTarget, failed, failedFor } = useConceptRows(rule, targets, added, open);
  const own: CollectedRows = byTarget.get(target) ?? { rows: [], mentions: [], pending: 0 };

  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoEdit, setAutoEdit] = useState<string | null>(null);
  const clearAutoEdit = useCallback(() => setAutoEdit(null), []);
  // Expanded rows, by card key: held here so "Expand all" reaches every row.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const setRowExpanded = useCallback((key: string, value: boolean) => {
    setExpanded((prev) => {
      if (prev.has(key) === value) return prev;
      const next = new Set(prev);
      if (value) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const toggle = () => {
    setOpen((v) => {
      writeOpen(!v);
      return !v;
    });
  };

  const folder = rowsFolder(rule);
  const concepts = useMemo<PickerConcept[]>(() => {
    const taken = new Set(own.rows.map((r) => r.conceptId));
    return Object.entries(metadata)
      .filter(([p, m]) => p.startsWith(`${folder}/`) && m.type === 'markdown' && /\.md$/i.test(p))
      .map(([p, m]) => ({ id: m.id, name: basenameOf(p), taken: taken.has(m.id) }));
  }, [metadata, folder, own.rows]);

  /** Add a row about the opened file to a concept file (made when `name` is
   *  new), then open it for editing. */
  const addRow = useCallback(async (choice: { id: string } | { name: string }, body = '') => {
    // The row heading links here by relative path: a path that cannot be a
    // wikilink would make a row that never shows (and a retry, a second one).
    const problem = rowLinkProblem(computeRelativePath(`${folder}/x.md`, path));
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let conceptId: string;
      let index = 0;
      if ('id' in choice) {
        conceptId = choice.id;
        const conceptPath = Object.entries(metadata).find(([, m]) => m.id === conceptId)?.[0];
        if (!conceptPath) throw new Error('concept file not found');
        // Checked against the live text, not the (possibly stale) snapshot:
        // a row about this file already there is opened, not doubled.
        const result = await withLiveDoc(`${RELAY_ID}-${conceptId}`, ({ doc }) => {
          const detach = attachProvenanceRegistration(doc, getActor);
          try {
            return insertRowUnlessPresent(doc.getText('contents'), conceptPath, target,
              computeRelativePath(conceptPath, path), body, metadata, rule.section);
          } finally {
            detach();
          }
        });
        if (!result) {
          setError('Another file was opened for editing meanwhile. Try again.');
          return;
        }
        index = result.index;
      } else {
        const folderDoc = folderDocs.get(rule.sharedFolder);
        if (!folderDoc) throw new Error(`folder ${rule.sharedFolder} not loaded`);
        if (!folderDoc.getMap('filemeta_v0').has(`/${rule.rowsIn}`)) createFolder(folderDoc, `/${rule.rowsIn}`);
        const conceptPath = `${folder}/${choice.name}.md`;
        const text = newConceptText(choice.name, generateUUID(), computeRelativePath(conceptPath, path), body, rule.section);
        conceptId = await createDocument(folderDoc, `/${rule.rowsIn}/${choice.name}.md`, 'markdown', text);
        setSnapshot(`${RELAY_ID}-${conceptId}`, text);
      }
      setAdded((prev) => [...prev, { target, source: conceptId }]);
      setAutoEdit(`${conceptId}:${index}`);
      setPicking(false);
      setOpen(true);
    } catch (err) {
      console.error('Could not add the concept row:', err);
      setError('Could not add the relationship. Try again.');
    } finally {
      setBusy(false);
    }
  }, [metadata, folderDocs, getActor, path, rule, folder, target]);

  const cardProps = (key: string, entry: RowEntry, about: string, aboutName: string, keyword: string) => ({
    entry,
    target: about,
    targetName: aboutName,
    targetKeyword: keyword,
    section: rule.section,
    metadata,
    canEdit,
    canAcceptReject: canEdit,
    suggestionMode,
    getActor,
    expanded: expanded.has(key),
    onExpandedChange: (value: boolean) => setRowExpanded(key, value),
  });

  const loading = own.pending - failedFor(target) > 0 || lensUse.pending > 0;
  // Each concept shows once: on a lens with its rows about the lens's
  // sources, on an article or video with its rows about the lenses using it.
  const groups = groupLensRows(own.rows, related.map((src) => ({
    sourceId: src.id,
    sourceName: basenameOf(src.path),
    kind: src.kind,
    rows: byTarget.get(src.id)?.rows ?? [],
  })));
  const ownKey = (entry: RowEntry) => `${entry.conceptId}:${entry.index}`;
  const sourceOnlyKey = (conceptId: string) => `sources:${conceptId}`;
  const lensRowKey = (src: SourceRows, row: RowEntry) => `lens:${src.sourceId}:${row.conceptId}:${row.index}`;
  const lensRowKeys = (sourceRows: SourceRows[]) => (rule.lensContext
    ? sourceRows.flatMap((src) => src.rows.map((row) => lensRowKey(src, row)))
    : []);
  const allKeys = [
    ...groups.lens.flatMap(({ entry, sourceRows }) => [ownKey(entry), ...lensRowKeys(sourceRows)]),
    ...groups.sourceOnly.flatMap((c) => [sourceOnlyKey(c.conceptId), ...lensRowKeys(c.sourceRows)]),
  ];
  const sourceOnlyHeading = related.length === 1
    ? `Only linked to ${related[0].kind}: ${basenameOf(related[0].path)}`
    : rule.lensContext ? 'Only linked to the lenses that use it' : 'Only linked to its sources';
  /** On an article or video: a lens's row, editable, nested in its concept's card. */
  const renderLensRow = rule.lensContext
    ? (src: SourceRows, row: RowEntry) => {
      const key = lensRowKey(src, row);
      return (
        <ConceptRowCard
          key={key}
          {...cardProps(key, row, src.sourceId, src.sourceName, 'Lens')}
          label={{ kind: src.kind, docId: src.sourceId, name: src.sourceName }}
        />
      );
    }
    : undefined;
  const allExpanded = allKeys.length > 0 && allKeys.every((k) => expanded.has(k));
  const targetName = basenameOf(path);

  return (
    <section
      className="concept-rows-panel mb-3 mt-1 rounded-md border border-gray-200 bg-gray-50/70 text-sm"
      data-testid="concept-rows-panel"
      aria-label={rule.title}
    >
      <header className="flex items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          onClick={toggle}
          className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-500 cursor-pointer"
          aria-expanded={open}
        >
          <span className="w-3 text-gray-400">{open ? '▾' : '▸'}</span>
          {rule.title}
          <span className="font-normal text-gray-400">{own.rows.length || ''}</span>
        </button>
        {open && allKeys.length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(allExpanded ? new Set() : new Set(allKeys))}
            className="ml-auto text-xs text-gray-500 hover:underline cursor-pointer"
          >
            {allExpanded ? 'Collapse all' : 'Expand all'}
          </button>
        )}
        {canEdit && (
          <button
            type="button"
            onClick={() => {
              setPicking((v) => !v);
              setOpen(true);
            }}
            disabled={busy}
            className={`${open && allKeys.length > 0 ? '' : 'ml-auto '}text-xs text-indigo-600 hover:underline cursor-pointer disabled:text-gray-400`}
          >
            {busy ? 'Adding…' : '+ Add relationship'}
          </button>
        )}
      </header>
      {open && (
        <div className="px-1 pb-2">
          {picking && (
            <div className="px-1 pb-1">
              <ConceptPicker concepts={concepts} onPick={(c) => void addRow(c)} onClose={() => setPicking(false)} />
            </div>
          )}
          {error && <div className="px-2 py-1 text-xs text-red-700">{error}</div>}
          {groups.lens.map(({ entry, sourceRows }) => {
            const key = ownKey(entry);
            return (
              <ConceptRowCard
                key={key}
                {...cardProps(key, entry, target, targetName, rule.openedLabel)}
                sourceRows={rule.sourceContext || rule.lensContext ? sourceRows : undefined}
                renderSourceRow={renderLensRow}
                autoEdit={autoEdit === key}
                onAutoEdited={clearAutoEdit}
              />
            );
          })}
          {own.rows.length === 0 && (
            <div className="px-2 py-1 text-gray-400">{loading ? 'Loading…' : 'No concept relationships yet'}</div>
          )}
          {failed > 0 && (
            <div className="px-2 py-1 text-xs text-red-700">
              {failed === 1 ? 'One concept file' : `${failed} concept files`} could not be read.
            </div>
          )}
          {own.mentions.length > 0 && (
            <div className="px-2 pt-1 text-xs text-gray-500">
              Also mentioned in:{' '}
              {own.mentions.map((m, i) => (
                <span key={m.conceptId}>
                  {i > 0 && ', '}
                  <DocLink docId={m.conceptId} className="hover:underline" title={`Open ${m.conceptPath}`}>
                    {m.conceptName}
                  </DocLink>
                </span>
              ))}
            </div>
          )}
          {groups.sourceOnly.length > 0 && (
            <div className="mt-2 border-t border-gray-200 pt-1.5" data-testid="concept-context-group">
              <div className="truncate px-2 pb-0.5 text-xs text-gray-400" title={sourceOnlyHeading}>
                {sourceOnlyHeading}
              </div>
              {groups.sourceOnly.map(({ conceptId, sourceRows }) => {
                const first = sourceRows[0];
                const entry = first.rows[0];
                const key = sourceOnlyKey(conceptId);
                return (
                  <ConceptRowCard
                    key={key}
                    {...cardProps(key, entry, first.sourceId, first.sourceName, first.kind)}
                    context
                    sourceRows={sourceRows}
                    renderSourceRow={renderLensRow}
                    // Prefilled with the first source's notes, as a draft.
                    onAddForLens={canEdit && !busy ? () => void addRow({ id: conceptId }, entry.body) : undefined}
                    addLabel={rule.lensContext ? `Add for this ${rule.openedLabel.replace(/^This /, '').toLowerCase()} too` : undefined}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
