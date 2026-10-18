import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { embedViewExtensions } from '../Editor/extensions/noteEmbed';
import { ySectionSync, ySectionUndoManagerKeymap } from '../SectionEditor/y-section-sync';
import { closeLive, isLive, openLive } from '../../lib/embed-docs';
import { attachProvenanceRegistration } from '../../lib/provenance';
import { rowPreview, rowsAbout, type ArticleRows, type RowEntry } from '../../lib/concept-rows';
import type { FolderMetadata } from '../../hooks/useFolderMetadata';
import { RELAY_ID } from '../../App';
import { DocLink } from './DocLink';

export interface RowCardProps {
  entry: RowEntry;
  /** The document the row is about (bare uuid): finds the row again in the live text. */
  target: string;
  section: string;
  metadata: FolderMetadata;
  /** Greyed and read-only: an article's row shown on its lens. */
  context?: boolean;
  canEdit: boolean;
  canAcceptReject: boolean;
  getActor: () => string;
  /** Name of the file the row is about, for the pair header ("concept × file"). */
  targetName: string;
  /** Expanded or not: the panel holds it, for "Expand all". */
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** Open for editing on mount, cursor at the end (a row just added). */
  autoEdit?: boolean;
  onAutoEdited?: () => void;
  /** Context rows: add a row for the lens, prefilled with this one's text. */
  onAddForLens?: () => void;
  /** A lens's own row: its concept's rows about the lens's articles, shown
   *  read-only under it (given on lenses only, empty when there are none). */
  articleRows?: ArticleRows[];
}

type CardState = 'idle' | 'connecting' | 'live' | 'error';

/** "Concept × file" over an expanded row: the row belongs to the pair, not
 *  to either side. */
function PairHeader({ label, concept, file }: { label?: string; concept: string; file: string }) {
  return (
    <div className="concept-row-pair ml-5 mt-1 text-[11px] text-gray-400">
      {label && <span className="font-medium text-gray-500">{label} · </span>}
      {concept} × {file}
    </div>
  );
}

/** A read-only rendering of `text`, as embeds render (live preview). */
function RowPreview({ text }: { text: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  useEffect(() => {
    // The live preview shows the cursor's line raw: park it on a line of its own.
    const doc = `${text}\n`;
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [...embedViewExtensions(false), EditorState.readOnly.of(true), EditorView.editable.of(false)],
    });
    if (!view.current) view.current = new EditorView({ parent: host.current!, state });
    else view.current.setState(state);
  }, [text]);
  useEffect(() => () => {
    view.current?.destroy();
    view.current = null;
  }, []);
  return <div ref={host} />;
}

/**
 * One row: the concept and the first line of its text; expands to the whole
 * text, which edits in place: a live connection to the concept file (the one
 * live embed, lib/embed-docs.ts) with an editor bound to the row's text only
 * (y-section-sync), so the heading and the rest of the file stay as they are.
 */
export function ConceptRowCard(props: RowCardProps) {
  const { entry, target, section, metadata, context, canEdit, canAcceptReject, getActor } = props;
  const { expanded, onExpandedChange } = props;
  const [state, setState] = useState<CardState>('idle');
  const [owner] = useState(() => ({}));
  const liveHost = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const live = useRef<{ view: EditorView; detach: () => void; onOutside: (e: MouseEvent) => void } | null>(null);
  const unmounted = useRef(false);
  const editable = canEdit && !context;
  const fullId = `${RELAY_ID}-${entry.conceptId}`;

  const ended = useCallback(() => {
    const current = live.current;
    live.current = null;
    if (current) {
      document.removeEventListener('mousedown', current.onOutside, true);
      current.detach();
      current.view.destroy();
    }
    if (!unmounted.current) setState('idle');
  }, []);

  const startEdit = useCallback(async () => {
    if (!editable || live.current || isLive(owner)) return;
    onExpandedChange(true);
    setState('connecting');
    let opened;
    try {
      opened = await openLive(fullId, owner, ended);
    } catch {
      if (isLive(owner)) closeLive(owner);
      if (!unmounted.current) setState('error');
      return;
    }
    if (!opened) return;
    if (unmounted.current || !liveHost.current) {
      closeLive(owner);
      return;
    }
    const { doc } = opened.connection;
    const ytext = doc.getText('contents');
    const detach = attachProvenanceRegistration(doc, getActor);
    let row = rowsAbout(ytext.toString(), entry.conceptPath, target, metadata, section)[entry.index];
    if (row && row.bodyFrom === row.headingTo) {
      // The heading ends the file: give the text a line of its own.
      ytext.insert(row.headingTo, '\n');
      row = rowsAbout(ytext.toString(), entry.conceptPath, target, metadata, section)[entry.index];
    }
    if (!row) {
      detach();
      closeLive(owner);
      setState('error');
      return;
    }
    const view = new EditorView({
      parent: liveHost.current,
      state: EditorState.create({
        doc: ytext.toString().slice(row.bodyFrom, row.bodyTo),
        extensions: [
          ...embedViewExtensions(canAcceptReject),
          keymap.of([{ key: 'Escape', run: () => { closeLive(owner); return true; } }]),
          ySectionUndoManagerKeymap,
          keymap.of(defaultKeymap),
          ySectionSync(ytext, row.bodyFrom, row.bodyTo),
          EditorView.contentAttributes.of({ 'aria-label': `Notes on ${entry.conceptName}` }),
        ],
      }),
    });
    const onOutside = (e: MouseEvent) => {
      if (!cardRef.current?.contains(e.target as Node)) closeLive(owner);
    };
    document.addEventListener('mousedown', onOutside, true);
    live.current = { view, detach, onOutside };
    setState('live');
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    // The host shows once React has rendered the live state.
    requestAnimationFrame(() => view.focus());
  }, [editable, owner, fullId, ended, getActor, entry, target, metadata, section, canAcceptReject, onExpandedChange]);

  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      closeLive(owner);
    };
  }, [owner]);

  const { autoEdit, onAutoEdited } = props;
  useEffect(() => {
    if (!autoEdit) return;
    // After this render: the card's editor host must be mounted first.
    const timer = setTimeout(() => {
      onAutoEdited?.();
      void startEdit();
    }, 0);
    return () => clearTimeout(timer);
  }, [autoEdit, onAutoEdited, startEdit]);

  const preview = rowPreview(entry.body);
  const showBody = expanded || state !== 'idle';
  const articleRows = props.articleRows ?? [];
  const labelled = articleRows.length > 0;

  return (
    <div
      ref={cardRef}
      className={`concept-row group rounded px-2 py-1 ${context ? 'text-gray-400' : 'text-gray-700'} ${state === 'live' ? 'bg-white ring-1 ring-blue-200' : 'hover:bg-white'}`}
      data-state={state}
      data-concept={entry.conceptName}
    >
      <div className="flex items-baseline gap-2 min-w-0">
        <button
          type="button"
          onClick={() => (state === 'idle' ? onExpandedChange(!expanded) : closeLive(owner))}
          className="w-3 shrink-0 text-xs text-gray-400 cursor-pointer"
          aria-label={showBody ? 'Collapse row' : 'Expand row'}
          aria-expanded={showBody}
        >
          {showBody ? '▾' : '▸'}
        </button>
        <DocLink
          docId={entry.conceptId}
          className={`shrink-0 font-medium hover:underline ${context ? 'text-gray-500' : 'text-indigo-700'}`}
          title={`Open ${entry.conceptPath}`}
        >
          {entry.conceptName}
        </DocLink>
        {!showBody && (
          <button
            type="button"
            onClick={() => onExpandedChange(true)}
            className={`min-w-0 flex-1 truncate text-left cursor-pointer ${preview ? '' : 'italic text-gray-400'}`}
          >
            {preview || 'No notes yet'}
          </button>
        )}
        {props.articleRows && (
          <span
            className="shrink-0 rounded bg-gray-100 px-1.5 text-[11px] text-gray-500"
            title={labelled ? 'Notes on this lens and on its article' : 'Notes on this lens'}
          >
            {labelled ? 'lens · article' : 'lens'}
          </span>
        )}
        <span className="ml-auto shrink-0 text-xs text-gray-400">
          {state === 'connecting' && 'Opening…'}
          {state === 'live' && 'Editing · Esc to finish'}
          {state === 'error' && <span className="text-red-700">Could not open</span>}
        </span>
        {props.onAddForLens && (
          <button
            type="button"
            onClick={props.onAddForLens}
            className="shrink-0 text-xs text-indigo-600 hover:underline cursor-pointer"
          >
            Add for this lens too
          </button>
        )}
      </div>
      {showBody && (
        <PairHeader label={labelled ? 'This lens' : undefined} concept={entry.conceptName} file={props.targetName} />
      )}
      {expanded && state === 'idle' && (
        <div
          className={`concept-row-body ml-5 mt-1 ${editable ? 'cursor-text' : ''}`}
          title={editable ? 'Click to edit' : undefined}
          onMouseDown={(e) => {
            if (!editable) return;
            if ((e.target as HTMLElement).closest('a, .cm-wikilink-widget')) return;
            e.preventDefault();
            void startEdit();
          }}
        >
          {entry.body
            ? <RowPreview text={entry.body} />
            : <div className="italic text-gray-400">{editable ? 'No notes yet · click to write' : 'No notes yet'}</div>}
        </div>
      )}
      {/* Always mounted: the editor goes in as soon as the connection is up. */}
      <div ref={liveHost} className="concept-row-body ml-5 mt-1" hidden={state === 'idle'} />
      {showBody && articleRows.map((article) => (
        <div key={article.articleId} className="mt-2 text-gray-400" data-testid="concept-row-article">
          <PairHeader label={`Article: ${article.articleName}`} concept={entry.conceptName} file={article.articleName} />
          {article.rows.map((row) => (
            <div key={row.index} className="concept-row-body ml-5 mt-0.5">
              {row.body ? <RowPreview text={row.body} /> : <div className="italic">No notes yet</div>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
