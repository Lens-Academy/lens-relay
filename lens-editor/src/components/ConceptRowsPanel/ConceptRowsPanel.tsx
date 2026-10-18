import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { useNavigation } from '../../contexts/NavigationContext';
import { useAuth } from '../../contexts/AuthContext';
import { useDisplayName } from '../../contexts/DisplayNameContext';
import { closeLive, openLive, setSnapshot } from '../../lib/embed-docs';
import { attachProvenanceRegistration, humanActor } from '../../lib/provenance';
import { createDocument, createFolder } from '../../lib/relay-api';
import { computeRelativePath, resolvePageName } from '../../lib/document-resolver';
import {
  fileName,
  groupLensRows,
  lensArticleTargets,
  matchRule,
  newConceptText,
  planRowInsertion,
  rowsAbout,
  rowsFolder,
  type CollectedRows,
  type ConceptRowRule,
  type RowEntry,
} from '../../lib/concept-rows';
import { RELAY_ID } from '../../App';
import { ConceptRowCard } from './ConceptRowCard';
import { ConceptPicker, type PickerConcept } from './ConceptPicker';
import { useConceptRows, type AddedSource } from './useConceptRows';

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

/** The lens's article targets, resolved, kept up to date with its text. */
function useArticles(enabled: boolean, ytext: Y.Text, path: string) {
  const { metadata } = useNavigation();
  const [targets, setTargets] = useState<string[]>([]);
  useEffect(() => {
    if (!enabled) return;
    const update = () => {
      const next = lensArticleTargets(ytext.toString());
      setTargets((prev) => (prev.join('\n') === next.join('\n') ? prev : next));
    };
    update();
    ytext.observe(update);
    return () => ytext.unobserve(update);
  }, [enabled, ytext]);
  return useMemo(() => {
    const out: Array<{ id: string; path: string }> = [];
    for (const target of targets) {
      const resolved = resolvePageName(target, metadata, path);
      if (resolved && !out.some((a) => a.id === resolved.docId)) out.push({ id: resolved.docId, path: resolved.path });
    }
    return out;
  }, [targets, metadata, path]);
}

function Panel({ docId, path, ytext, rule }: PanelProps & { path: string; rule: ConceptRowRule }) {
  const { metadata, folderDocs, onNavigate } = useNavigation();
  const { canEdit } = useAuth();
  const { displayName } = useDisplayName();
  const displayNameRef = useRef(displayName);
  displayNameRef.current = displayName;
  const getActor = useCallback(() => humanActor(displayNameRef.current ?? ''), []);

  const target = docId.slice(RELAY_ID.length + 1);
  const articles = useArticles(!!rule.articleContext, ytext, path);
  const targets = useMemo(() => [target, ...articles.map((a) => a.id)], [target, articles]);
  const [added, setAdded] = useState<AddedSource[]>([]);
  const { byTarget, failed } = useConceptRows(rule, targets, added);
  const own: CollectedRows = byTarget.get(target) ?? { rows: [], mentions: [], pending: 0 };

  const [open, setOpen] = useState(readOpen);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoEdit, setAutoEdit] = useState<string | null>(null);
  const clearAutoEdit = useCallback(() => setAutoEdit(null), []);

  const toggle = () => {
    setOpen((v) => {
      writeOpen(!v);
      return !v;
    });
  };

  const openConcept = useCallback((id: string) => onNavigate(`${RELAY_ID}-${id}`), [onNavigate]);

  const folder = rowsFolder(rule);
  const concepts = useMemo<PickerConcept[]>(() => {
    const taken = new Set(own.rows.map((r) => r.conceptId));
    return Object.entries(metadata)
      .filter(([p, m]) => p.startsWith(`${folder}/`) && m.type === 'markdown' && /\.md$/i.test(p))
      .map(([p, m]) => ({ id: m.id, name: fileName(p), taken: taken.has(m.id) }));
  }, [metadata, folder, own.rows]);

  /** Add a row about the opened file to a concept file (made when `name` is
   *  new), then open it for editing. */
  const addRow = useCallback(async (choice: { id: string } | { name: string }, body = '') => {
    setBusy(true);
    setError(null);
    try {
      let conceptId: string;
      let index = 0;
      if ('id' in choice) {
        conceptId = choice.id;
        const conceptPath = Object.entries(metadata).find(([, m]) => m.id === conceptId)?.[0];
        if (!conceptPath) throw new Error('concept file not found');
        const owner = {};
        const opened = await openLive(`${RELAY_ID}-${conceptId}`, owner, () => {});
        if (!opened) return;
        const { doc } = opened.connection;
        const text = doc.getText('contents');
        const detach = attachProvenanceRegistration(doc, getActor);
        const plan = planRowInsertion(text.toString(), computeRelativePath(conceptPath, path), body, rule.section);
        text.insert(plan.at, plan.insert);
        detach();
        index = Math.max(0, rowsAbout(text.toString(), conceptPath, target, metadata, rule.section)
          .findIndex((r) => r.bodyFrom === plan.bodyFrom));
        closeLive(owner); // records the new text for the panel
      } else {
        const folderDoc = folderDocs.get(rule.sharedFolder);
        if (!folderDoc) throw new Error(`folder ${rule.sharedFolder} not loaded`);
        if (!folderDoc.getMap('filemeta_v0').has(`/${rule.rowsIn}`)) createFolder(folderDoc, `/${rule.rowsIn}`);
        const conceptPath = `${folder}/${choice.name}.md`;
        const text = newConceptText(choice.name, computeRelativePath(conceptPath, path), body, rule.section);
        conceptId = await createDocument(folderDoc, `/${rule.rowsIn}/${choice.name}.md`, 'markdown', text);
        setSnapshot(`${RELAY_ID}-${conceptId}`, text);
      }
      setAdded((prev) => [...prev, { target, source: conceptId }]);
      setAutoEdit(`${conceptId}:${index}`);
      setPicking(false);
      setOpen(true);
    } catch (err) {
      console.error('Could not add the concept row:', err);
      setError('Could not add the concept. Try again.');
    } finally {
      setBusy(false);
    }
  }, [metadata, folderDocs, getActor, path, rule, folder, target]);

  const cardProps = (entry: RowEntry, about: string) => ({
    entry,
    target: about,
    section: rule.section,
    metadata,
    canEdit,
    canAcceptReject: canEdit,
    getActor,
    onOpenConcept: openConcept,
  });

  const loading = own.pending - failed > 0;
  // Lenses: a concept with rows on the lens and on its article shows once.
  const groups = groupLensRows(own.rows, articles.map((a) => ({
    articleId: a.id,
    articleName: fileName(a.path),
    rows: byTarget.get(a.id)?.rows ?? [],
  })));

  return (
    <section
      className="concept-rows-panel mx-6 mt-3 rounded-md border border-gray-200 bg-gray-50/70 text-sm"
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
        {canEdit && (
          <button
            type="button"
            onClick={() => {
              setPicking((v) => !v);
              setOpen(true);
            }}
            disabled={busy}
            className="ml-auto text-xs text-indigo-600 hover:underline cursor-pointer disabled:text-gray-400"
          >
            {busy ? 'Adding…' : '+ Add concept'}
          </button>
        )}
      </header>
      {open && (
        <div className="max-h-[40vh] overflow-auto px-1 pb-2">
          {picking && (
            <div className="px-1 pb-1">
              <ConceptPicker concepts={concepts} onPick={(c) => void addRow(c)} onClose={() => setPicking(false)} />
            </div>
          )}
          {error && <div className="px-2 py-1 text-xs text-red-700">{error}</div>}
          {groups.lens.map(({ entry, articleRows }) => {
            const key = `${entry.conceptId}:${entry.index}`;
            return (
              <ConceptRowCard
                key={key}
                {...cardProps(entry, target)}
                articleRows={rule.articleContext ? articleRows : undefined}
                autoEdit={autoEdit === key}
                onAutoEdited={clearAutoEdit}
              />
            );
          })}
          {own.rows.length === 0 && (
            <div className="px-2 py-1 text-gray-400">{loading ? 'Loading…' : 'No concepts yet'}</div>
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
                  <button type="button" onClick={() => openConcept(m.conceptId)} className="hover:underline cursor-pointer">
                    {m.conceptName}
                  </button>
                </span>
              ))}
            </div>
          )}
          {groups.articleOnly.map((article) => (
            <div key={article.articleId} className="mt-2 border-t border-gray-200 pt-1.5" data-testid="concept-context-group">
              <div className="px-2 pb-0.5 text-xs text-gray-400">
                Only linked to its article ({article.articleName})
              </div>
              {article.rows.map((entry) => (
                <ConceptRowCard
                  key={`${entry.conceptId}:${entry.index}`}
                  {...cardProps(entry, article.articleId)}
                  context
                  onAddForLens={canEdit && !busy ? () => void addRow({ id: entry.conceptId }, entry.body) : undefined}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
