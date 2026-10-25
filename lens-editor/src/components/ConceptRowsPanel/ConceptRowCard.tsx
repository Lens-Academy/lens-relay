import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { embedViewExtensions } from '../Editor/extensions/noteEmbed';
import { toggleSuggestionMode } from '../Editor/extensions/criticmarkup';
import { ySectionSync, ySectionUndoManagerKeymap } from '../SectionEditor/y-section-sync';
import { closeLive, isLive, openLive } from '../../lib/embed-docs';
import { attachProvenanceRegistration } from '../../lib/provenance';
import { bodyLineFix, findLiveRow, rowHasCR, rowPreview, rowsAbout, type RowEntry, type SourceRows } from '../../lib/concept-rows';
import type { FolderMetadata } from '../../hooks/useFolderMetadata';
import { RELAY_ID } from '../../App';
import { DocLink } from '../DocLink';

export interface RowCardProps {
  entry: RowEntry;
  /** The document the row is about (bare uuid): finds the row again in the live text. */
  target: string;
  section: string;
  metadata: FolderMetadata;
  /** Greyed and read-only, on a lens: a concept with rows about the lens's
   *  sources only. `entry` is its first such row (the collapsed preview);
   *  expanded, it shows `sourceRows`. */
  context?: boolean;
  canEdit: boolean;
  canAcceptReject: boolean;
  /** The main editor is in Suggesting mode: edits here become suggestions too. */
  suggestionMode?: boolean;
  getActor: () => string;
  /** The file the row is about, for the pair header: its name (tooltip) and
   *  keyword ("This article", "This video" or "This lens"). */
  targetName: string;
  targetKeyword: string;
  /** Expanded or not: the panel holds it, for "Expand all". */
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** Open for editing on mount, cursor at the end (a row just added). */
  autoEdit?: boolean;
  onAutoEdited?: () => void;
  /** Context rows: add a row for the opened file, prefilled with this one's text. */
  onAddForLens?: () => void;
  /** The button's text for `onAddForLens` (default "Add for this lens too"). */
  addLabel?: string;
  /** On a lens: the concept's rows about the lens's sources, shown read-only
   *  under the lens row (or alone, for `context`). On an article or video:
   *  its rows about the lenses that use the file, drawn by `renderSourceRow`. */
  sourceRows?: SourceRows[];
  /** Draws one of `sourceRows`' rows itself (an editable card), instead of
   *  the read-only block. */
  renderSourceRow?: (source: SourceRows, row: RowEntry) => ReactNode;
  /** Collapsed, show this instead of the row's first line. */
  summary?: string;
  /** A row about a related file, nested in its concept's card: the header
   *  names that file ("Lens: <name>", a link) instead of the concept. */
  label?: { kind: string; docId: string; name: string };
}

type CardState = 'idle' | 'connecting' | 'live' | 'error';

/** The panel sits inside the main editor, whose theme (`.ͼx .cm-content`:
 *  page padding, column width, scrolling) also matches these nested editors.
 *  Undo it here with selectors that outrank it. */
const rowEditorTheme = EditorView.theme({
  '&.cm-editor .cm-content': { padding: '0', maxWidth: 'none', margin: '0' },
  '&.cm-editor .cm-scroller': { overflow: 'visible', fontFamily: 'inherit', lineHeight: '1.5' },
  '&.cm-editor': { fontSize: 'inherit', background: 'transparent' },
  '&.cm-editor.cm-focused': { outline: 'none' },
});

/** A keyword in a small bordered box, with the full name in its tooltip. */
function Chip({ children, name }: { children: string; name: string }) {
  return (
    <span className="concept-row-chip shrink-0 rounded border border-gray-300 px-1 leading-4 text-gray-500" title={name}>
      {children}
    </span>
  );
}

/**
 * "[Concept] × [This article]" over an expanded row: the row belongs to the
 * pair, not to either side. Keywords rather than names (real file names run
 * to 160 characters); each name is in its chip's tooltip. An article block
 * on a lens also says which article (`label`, cut with an ellipsis).
 */
function PairHeader({ concept, file, keyword, label }: {
  concept: string;
  file: string;
  keyword: string;
  label?: string;
}) {
  return (
    <div className="concept-row-pair ml-5 mt-1 flex min-w-0 items-center gap-1 text-[11px] text-gray-400">
      <Chip name={concept}>Concept</Chip>
      <span className="shrink-0">×</span>
      <Chip name={file}>{keyword}</Chip>
      {label && <span className="ml-1 min-w-0 truncate" title={label}>{label}</span>}
    </div>
  );
}

/** A read-only rendering of `text`, as embeds render (live preview). */
function RowPreview({ text }: { text: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  useEffect(() => {
    // The live preview shows the cursor's line raw: park it on a line of its own.
    // CodeMirror turns \r\n into one line break, so the end is the state's
    // doc length, not the text's (else: "Selection points outside of document").
    const created = EditorState.create({
      doc: `${text}\n`,
      extensions: [...embedViewExtensions(false), rowEditorTheme, EditorState.readOnly.of(true), EditorView.editable.of(false)],
    });
    const state = created.update({ selection: { anchor: created.doc.length } }).state;
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
  const toggleRef = useRef<HTMLButtonElement>(null);
  const suggestionMode = !!props.suggestionMode;
  const suggestionModeRef = useRef(suggestionMode);
  /** Escape ended the edit: give the keyboard back to the row's toggle. */
  const refocusToggle = useRef(false);
  const live = useRef<{ view: EditorView; detach: () => void; onOutside: (e: MouseEvent) => void } | null>(null);
  const unmounted = useRef(false);
  // A row in \r\n lines is edited in its concept file (rowHasCR).
  const crlf = !!entry.crlf || entry.body.includes('\r');
  const editable = canEdit && !context && !crlf;
  const fullId = `${RELAY_ID}-${entry.conceptId}`;

  const ended = useCallback(() => {
    const current = live.current;
    live.current = null;
    if (current) {
      document.removeEventListener('mousedown', current.onOutside, true);
      current.detach();
      current.view.destroy();
    }
    if (unmounted.current) return;
    setState('idle');
    if (refocusToggle.current) {
      refocusToggle.current = false;
      requestAnimationFrame(() => toggleRef.current?.focus());
    }
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
    const liveRow = () => findLiveRow(
      rowsAbout(ytext.toString(), entry.conceptPath, target, metadata, section), ytext.toString(), entry);
    const row = liveRow();
    // An empty row right before the next heading (or at the end of its own
    // heading line, at the end of the file) gets a line of its own with the
    // first edit, so nothing typed here can run into a heading; opening it
    // and leaving writes nothing.
    const lineBreak = row ? bodyLineFix(row, ytext.length) : null;
    // Checked again on the live text: the file may have changed since.
    if (!row || rowHasCR(ytext.toString(), row)) {
      detach();
      closeLive(owner);
      setState('error');
      return;
    }
    const body = ytext.toString().slice(row.bodyFrom, row.bodyTo);
    const view = new EditorView({
      parent: liveHost.current,
      state: EditorState.create({
        doc: body,
        extensions: [
          ...embedViewExtensions(canAcceptReject),
          rowEditorTheme,
          keymap.of([{ key: 'Escape', run: () => { refocusToggle.current = true; closeLive(owner); return true; } }]),
          ySectionUndoManagerKeymap,
          keymap.of(defaultKeymap),
          ySectionSync(ytext, row.bodyFrom, row.bodyTo, { lineBreakOnFirstEdit: lineBreak ?? undefined, endExclusive: true }),
          EditorView.contentAttributes.of({ 'aria-label': `Notes on ${entry.conceptName}` }),
        ],
      }),
    });
    const onOutside = (e: MouseEvent) => {
      if (!cardRef.current?.contains(e.target as Node)) closeLive(owner);
    };
    document.addEventListener('mousedown', onOutside, true);
    // Follow the main editor's Suggesting toggle, as note embeds do.
    if (suggestionModeRef.current) view.dispatch({ effects: toggleSuggestionMode.of(true) });
    live.current = { view, detach, onOutside };
    setState('live');
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    // The host shows once React has rendered the live state.
    requestAnimationFrame(() => view.focus());
  }, [editable, owner, fullId, ended, getActor, entry, target, metadata, section, canAcceptReject, onExpandedChange]);

  // ...also when it is switched while the row is open.
  useEffect(() => {
    suggestionModeRef.current = suggestionMode;
    live.current?.view.dispatch({ effects: toggleSuggestionMode.of(suggestionMode) });
  }, [suggestionMode]);

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

  const preview = props.summary ?? rowPreview(entry.body);
  // Opening or editing keeps the row open; a failed open does not.
  const showBody = expanded || state === 'connecting' || state === 'live';
  const sourceRows = props.sourceRows ?? [];
  const nestedCount = sourceRows.reduce((sum, src) => sum + src.rows.length, 0);
  /** Expand or collapse (finishing an edit first): the triangle, or a click
   *  anywhere on the header bar but the concept link and its own buttons. */
  const toggle = () => {
    if (state === 'error') setState('idle');
    else if (state !== 'idle') closeLive(owner);
    onExpandedChange(!showBody);
  };

  return (
    <div
      ref={cardRef}
      className={`concept-row group rounded px-2 py-1 ${context ? 'text-gray-400' : 'text-gray-700'} ${state === 'live' ? 'bg-white ring-1 ring-blue-200' : 'hover:bg-white'}`}
      data-state={state}
      data-concept={entry.conceptName}
    >
      <div
        className="concept-row-header flex min-w-0 cursor-pointer items-baseline gap-2"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('a, button')) return;
          toggle();
        }}
      >
        {/* 24px hit box around a small triangle */}
        <button
          ref={toggleRef}
          type="button"
          onClick={toggle}
          className="-my-1 -ml-1.5 -mr-1 flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center self-center rounded text-xs text-gray-400 hover:bg-gray-100"
          aria-label={showBody ? 'Collapse row' : 'Expand row'}
          aria-expanded={showBody}
        >
          {showBody ? '▾' : '▸'}
        </button>
        {props.label ? (
          <span
            className={`concept-row-label min-w-0 shrink-0 truncate text-gray-500 ${showBody ? '' : 'max-w-[50%]'}`}
            title={`${props.label.kind}: ${props.label.name}`}
          >
            {props.label.kind}:{' '}
            <DocLink docId={props.label.docId} className="font-medium text-indigo-700 hover:underline">
              {props.label.name}
            </DocLink>
          </span>
        ) : (
          <DocLink
            docId={entry.conceptId}
            // Collapsed, the name leaves at least half the line to the preview.
            className={`min-w-0 shrink-0 truncate font-medium hover:underline ${showBody ? '' : 'max-w-[50%]'} ${context ? 'text-gray-500' : 'text-indigo-700'}`}
            title={entry.conceptName}
          >
            {entry.conceptName}
          </DocLink>
        )}
        {!showBody && (
          <span className={`min-w-0 flex-1 truncate ${preview ? '' : 'italic text-gray-400'}`}>
            {preview || 'No notes yet'}
          </span>
        )}
        {!showBody && !context && props.renderSourceRow && nestedCount > 0 && (
          <span className="concept-row-nested-hint shrink-0 text-xs text-gray-400">
            +{nestedCount} lens row{nestedCount === 1 ? '' : 's'}
          </span>
        )}
        <span className="ml-auto shrink-0 text-xs text-gray-400">
          {state === 'connecting' && 'Opening…'}
          {state === 'live' && 'Editing · Esc to finish'}
          {state === 'error' && (
            <span className="text-red-700">
              Could not open ·{' '}
              <button type="button" onClick={() => void startEdit()} className="cursor-pointer underline">Retry</button>
            </span>
          )}
        </span>
        {props.onAddForLens && (
          <button
            type="button"
            onClick={props.onAddForLens}
            className="shrink-0 text-xs text-indigo-600 hover:underline cursor-pointer"
          >
            {props.addLabel ?? 'Add for this lens too'}
          </button>
        )}
      </div>
      {showBody && !context && (
        <PairHeader concept={entry.conceptName} file={props.targetName} keyword={props.targetKeyword} />
      )}
      {expanded && (state === 'idle' || state === 'error') && !context && (
        <div
          className={`concept-row-body ml-5 mt-1 ${editable ? 'cursor-text rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-300' : ''}`}
          title={editable ? 'Click or press Enter to edit' : undefined}
          // Keyboard: Tab reaches the text, Enter or Space edits it.
          {...(editable ? { tabIndex: 0, role: 'button', 'aria-label': `Edit notes on ${entry.conceptName}` } : {})}
          onKeyDown={(e) => {
            if (!editable || e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
            e.preventDefault();
            void startEdit();
          }}
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
          {crlf && canEdit && !context && (
            <div className="mt-0.5 text-xs text-gray-400">Windows line endings: edit this row in the concept file.</div>
          )}
        </div>
      )}
      {/* Always mounted: the editor goes in as soon as the connection is up. */}
      <div ref={liveHost} className="concept-row-body ml-5 mt-1" hidden={state !== 'connecting' && state !== 'live'} />
      {showBody && props.renderSourceRow && sourceRows.map((src) => (
        <div key={src.sourceId} className="ml-4 mt-1" data-testid="concept-row-source">
          {src.rows.map((row) => props.renderSourceRow!(src, row))}
        </div>
      ))}
      {showBody && !props.renderSourceRow && sourceRows.map((src, i) => (
        <div key={src.sourceId} className={`${context && i === 0 ? 'mt-1' : 'mt-2'} text-gray-400`} data-testid="concept-row-source">
          <PairHeader
            concept={entry.conceptName}
            file={src.sourceName}
            keyword={src.kind}
            label={`${src.kind}: ${src.sourceName}`}
          />
          {src.rows.map((row) => (
            <div key={row.index} className="concept-row-body ml-5 mt-0.5">
              {row.body ? <RowPreview text={row.body} /> : <div className="italic">No notes yet</div>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
