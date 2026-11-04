import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';
import type { EditorView } from '@codemirror/view';
import { useDisplayName } from '../../contexts/DisplayNameContext';
import { useMobile } from '../../contexts/MobileContext';
import type { FolderMetadata } from '../../hooks/useFolderMetadata';
import { RELAY_ID } from '../../lib/constants';
import { urlForDoc } from '../../lib/url-utils';
import { useYDoc, useYjsProvider } from '../../lib/ydoc-provider';
import {
  BAR_TOP_PX,
  CARET_GAP_PX,
  ONE_CLICK_LIMIT,
  barOffset,
  estimateMinutes,
  formatEstimate,
  type BarModel,
  type RowStep,
  type SourceRow,
} from './bar-model';
import { swapLinksInEditor, type LibraryHit } from './localSwap';
import type { SourceLinksSession } from './source-links-session';
import type { SourceLinkMenuTarget } from './sourceLinkMenu';
import { useSourceLinks } from './useSourceLinks';

const FOCUS_RING = 'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-600';
const BUTTON = `inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded px-1.5 py-1 text-[13px] font-medium disabled:cursor-default disabled:opacity-50 pointer-coarse:min-h-10 ${FOCUS_RING}`;
const PRIMARY = `${BUTTON} bg-blue-600 text-white hover:bg-blue-700`;
const QUIET = `${BUTTON} text-blue-800 hover:bg-blue-100`;
const HIDE = `inline-flex shrink-0 cursor-pointer items-center justify-center rounded px-1 py-1 text-base leading-none text-blue-800 hover:bg-blue-100 pointer-coarse:min-h-10 pointer-coarse:min-w-10 ${FOCUS_RING}`;

const PLACE_BAR = { key: 'source-links-bar' };
/** The phone's edit toolbar, fixed over the bottom of the page. */
const TOOLBAR_PX = 52;

/** Where the page stops being on screen, so the bar's buttons stay reachable. */
function visibleBottom(view: EditorView): number {
  const viewport = window.visualViewport;
  const screen = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
  const toolbar = window.matchMedia('(pointer: coarse)').matches ? TOOLBAR_PX : 0;
  return Math.min(view.scrollDOM.getBoundingClientRect().bottom, screen - toolbar);
}

const STEP_TEXT: Record<RowStep, string> = {
  starting: 'Starting',
  queued: 'Queued',
  importing: 'Importing',
  linking: 'Linking',
};

function rowStateText(row: SourceRow): string {
  if (row.state === 'failed') return 'Failed';
  if (row.state === 'done') return 'Linked';
  return row.step ? STEP_TEXT[row.step] : '';
}

/** Where a row's Open goes: the library copy in the editor, else the source. */
function openHref(row: SourceRow, metadata: FolderMetadata | undefined): string {
  const copy = row.state === 'library' && row.libraryPath ? metadata?.[`/${row.libraryPath}`] : undefined;
  return copy ? urlForDoc(`${RELAY_ID}-${copy.id}`, metadata!) : row.url;
}

function OpenLink({ row, href }: { row: SourceRow; href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={href === row.url ? `Open ${row.label}` : `Open the library copy of ${row.label}`}
      className={`shrink-0 rounded text-xs text-blue-700 underline pointer-coarse:px-1 pointer-coarse:py-2 ${FOCUS_RING}`}
    >
      Open
    </a>
  );
}

function RowTag({ row }: { row: SourceRow }) {
  const tag = row.state === 'library' ? 'In library' : row.kind === 'video' ? 'Video' : null;
  if (!tag) return null;
  return <span className="shrink-0 rounded bg-blue-100 px-1.5 text-xs text-blue-800">{tag}</span>;
}

const ROW = 'flex min-w-0 items-center gap-2 px-3 py-1 text-gray-800 pointer-coarse:min-h-10';

function ChooseRow({ row, href, ticked, onToggle }: { row: SourceRow; href: string; ticked: boolean; onToggle: () => void }) {
  /** A click on a label would hand the keyboard to its tick box. */
  const toggleFromLabel = (event: MouseEvent) => {
    if (event.target instanceof HTMLInputElement) return;
    event.preventDefault();
    onToggle();
  };
  return (
    <li className={ROW}>
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2" onClick={toggleFromLabel}>
        <input type="checkbox" checked={ticked} onChange={onToggle} className="shrink-0 accent-blue-600" />
        <span className="truncate" title={row.url}>{row.label}</span>
        <RowTag row={row} />
      </label>
      <OpenLink row={row} href={href} />
    </li>
  );
}

function DetailRow({ row, href }: { row: SourceRow; href: string }) {
  return (
    <li className="px-3 py-1">
      <div className={`${ROW} !p-0`}>
        <span className="min-w-0 flex-1 truncate" title={row.url}>{row.label}</span>
        <RowTag row={row} />
        <span className="shrink-0 text-xs text-gray-600">{rowStateText(row)}</span>
        <OpenLink row={row} href={href} />
      </div>
      {row.error && <p className="text-xs break-words text-red-700">{row.error}</p>}
    </li>
  );
}

interface ChooseFooterProps {
  model: BarModel;
  ticked: SourceRow[];
  allTicked: boolean;
  onToggleAll: () => void;
  onAccept: () => void;
}

function ChooseFooter({ model, ticked, allTicked, onToggleAll, onAccept }: ChooseFooterProps) {
  const toImport = ticked.filter((row) => row.state === 'new').length;
  const linksOnly = ticked.length > 0 && toImport === 0;
  const minutes = toImport > 0 && model.queue ? estimateMinutes(toImport, model.queue) : null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-blue-200 px-3 py-1.5">
      <button type="button" className={PRIMARY} disabled={ticked.length === 0} onClick={onAccept}>
        {linksOnly
          ? `Use ${ticked.length} library ${ticked.length === 1 ? 'copy' : 'copies'}`
          : `Import and link ${ticked.length}`}
      </button>
      {minutes !== null && <span className="text-xs text-gray-600">{formatEstimate(minutes)}</span>}
      {model.rows.length > ONE_CLICK_LIMIT && (
        <button type="button" className={`${QUIET} ml-auto`} onClick={onToggleAll}>
          {allTicked ? 'Untick all' : 'Tick all'}
        </button>
      )}
    </div>
  );
}

interface BarProps {
  model: BarModel;
  session: SourceLinksSession;
  isMobile: boolean;
  editorView: EditorView | null;
  metadata: FolderMetadata | undefined;
  /** Gives the keyboard back to the page. */
  returnFocus: () => void;
  /** Where the bar leaves a way to be told the caret moved. */
  placeRef: RefObject<(() => void) | null>;
  /** How much of the top of the page the bar covers, for the editor's scrolling. */
  marginRef: RefObject<number>;
}

function Bar({ model, session, isMobile, editorView, metadata, returnFocus, placeRef, marginRef }: BarProps) {
  const regionRef = useRef<HTMLElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef(returnFocus);
  useEffect(() => {
    returnFocusRef.current = returnFocus;
  }, [returnFocus]);

  // Which list is open: Choose belongs to the offer and Details to the work, so
  // accepting closes one and never opens the other
  const [openList, setOpenList] = useState<'choose' | 'details' | null>(null);
  /** Choose's tick boxes, by row. A row with none, one that arrived while the list
   *  was open, is unticked. */
  const [ticks, setTicks] = useState<ReadonlyMap<string, boolean>>(new Map());

  const list = model.kind === 'offer' ? (model.canChoose ? 'choose' : null)
    : model.kind === 'working' || model.kind === 'failed' ? 'details' : null;
  // Leaving the state that had it open closes it for good: rows coming back
  // later must not bring a list up over the page by themselves
  if (openList !== null && openList !== list) setOpenList(null);
  const expanded = list !== null && openList === list;

  const [offset, setOffset] = useState(0);
  // Open, the list stays where it opened: it doesn't jump away from the pointer
  // choosing in it, even if that means covering the caret
  const expandedRef = useRef(expanded);
  useLayoutEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);
  const place = useCallback(() => {
    if (expandedRef.current) return;
    editorView?.requestMeasure({
      ...PLACE_BAR,
      read: (view) => {
        const card = cardRef.current?.getBoundingClientRect();
        const region = regionRef.current?.getBoundingClientRect();
        if (!card || !region) return null;
        // The editor keeps the caret this far down when it scrolls to it
        marginRef.current = BAR_TOP_PX + card.height + CARET_GAP_PX;
        const caret = view.hasFocus ? view.coordsAtPos(view.state.selection.main.head) : null;
        return caret ? barOffset(caret, region.top + BAR_TOP_PX, card.height, visibleBottom(view)) : 0;
      },
      write: (next) => {
        if (next !== null && !expandedRef.current) setOffset(next);
      },
    });
  }, [editorView, marginRef]);
  useLayoutEffect(() => {
    placeRef.current = place;
    place();
    return () => {
      placeRef.current = null;
    };
  }, [place, placeRef, model.text, expanded]);
  useLayoutEffect(
    () => () => {
      marginRef.current = 0;
    },
    [marginRef],
  );
  // Scrolling can bring the caret's line up under the bar
  useEffect(() => {
    const scroller = editorView?.scrollDOM;
    scroller?.addEventListener('scroll', place, { passive: true });
    return () => scroller?.removeEventListener('scroll', place);
  }, [editorView, place]);

  // The bar can leave with the keyboard on it (Done clearing, the last link
  // going): the keyboard then belongs to the page, not to nothing
  useLayoutEffect(() => {
    const region = regionRef.current;
    return () => {
      if (region?.contains(document.activeElement)) returnFocusRef.current();
    };
  }, []);

  // On the document: a click on Choose leaves the keyboard in the page. A key the
  // editor used (closing autocomplete, say) is not for this list.
  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (panelRef.current?.contains(document.activeElement)) toggleRef.current?.focus();
      setOpenList(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [expanded]);

  /** A mouse anywhere on the bar leaves the keyboard in the page, which its tick
   *  boxes and buttons don't need; keyboard users Tab in. */
  const keepEditorFocus = (event: MouseEvent) => event.preventDefault();

  const onRegionKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !expanded) returnFocus();
  };

  /** Runs an action that replaces the buttons, one of which may hold the keyboard. */
  const act = (action: () => void) => () => {
    if (regionRef.current?.contains(document.activeElement)) returnFocus();
    action();
  };

  const tickedRows = model.rows.filter((row) => ticks.get(row.key) === true);
  const untickedRows = model.rows.filter((row) => ticks.get(row.key) !== true);
  const acceptTicked = act(() => {
    session.accept(tickedRows.flatMap((row) => row.urls));
    // Left unticked is this person's answer, and nobody else's
    if (untickedRows.length > 0) session.setAside(untickedRows.flatMap((row) => row.urls));
  });
  const toggleRow = (key: string) => setTicks((current) => new Map(current).set(key, current.get(key) !== true));
  const toggleAll = () =>
    setTicks(new Map(model.rows.map((row) => [row.key, untickedRows.length > 0])));
  /** A short list starts ticked; a long one starts unticked, so 400 imports are
   *  never one click away. Rows already decided keep their ticks. */
  const openChoose = () =>
    setTicks((current) => {
      const next = new Map(current);
      const start = model.rows.length <= ONE_CLICK_LIMIT;
      for (const row of model.rows) if (!next.has(row.key)) next.set(row.key, start);
      return next;
    });

  const buttonSize = isMobile ? 'min-h-10 flex-1' : '';
  const dismiss = model.dismissUrls && (
    <button type="button" className={`${QUIET} ${buttonSize}`} onClick={act(() => session.dismiss(model.dismissUrls ?? []))}>
      Dismiss
    </button>
  );
  const toggle = list && (
    <button
      ref={toggleRef}
      type="button"
      aria-expanded={expanded}
      aria-controls={expanded ? 'source-links-list' : undefined}
      className={`${!model.primary && model.kind === 'offer' ? PRIMARY : QUIET} ${buttonSize}`}
      onClick={() => {
        if (!expanded && list === 'choose') openChoose();
        setOpenList(expanded ? null : list);
      }}
    >
      {list === 'choose' ? 'Choose' : 'Details'}
    </button>
  );

  // For this person, this visit; Dismiss is the answer for everyone. On a phone
  // it sits on the sentence's line, so the buttons below keep the full width.
  const hide = (
    <button
      type="button"
      aria-label="Hide"
      title="Hide for now"
      className={`${HIDE} ${isMobile ? 'order-2 -mr-1 min-h-10 min-w-10 self-start' : ''}`}
      onClick={act(session.hide)}
    >
      ×
    </button>
  );

  let actions: ReactNode = null;
  if (model.kind === 'offer') {
    const { primary } = model;
    actions = (
      <>
        {primary && (
          <button type="button" className={`${PRIMARY} ${buttonSize}`} onClick={act(() => session.accept(primary.urls))}>
            {primary.label}
          </button>
        )}
        {toggle}
        {dismiss}
      </>
    );
  } else if (model.kind === 'working') {
    actions = (
      <>
        {toggle}
        {model.canStop && (
          <button type="button" className={`${QUIET} ${buttonSize}`} onClick={act(() => void session.stopImports())}>
            Stop
          </button>
        )}
      </>
    );
  } else if (model.kind === 'failed') {
    actions = (
      <>
        <button type="button" className={`${PRIMARY} ${buttonSize}`} onClick={act(session.retry)}>
          Retry
        </button>
        {toggle}
        {dismiss}
      </>
    );
  }

  let panel: ReactNode = null;
  if (expanded) {
    panel = (
      <div ref={panelRef} id="source-links-list" className="border-t border-blue-200">
        <ul className="max-h-[40vh] overflow-y-auto py-1">
          {model.rows.map((row) =>
            list === 'choose'
              ? <ChooseRow key={row.key} row={row} href={openHref(row, metadata)} ticked={ticks.get(row.key) === true} onToggle={() => toggleRow(row.key)} />
              : <DetailRow key={row.key} row={row} href={openHref(row, metadata)} />,
          )}
        </ul>
        {list === 'choose' && (
          <ChooseFooter
            model={model}
            ticked={tickedRows}
            allTicked={untickedRows.length === 0}
            onToggleAll={toggleAll}
            onAccept={acceptTicked}
          />
        )}
      </div>
    );
  }

  return (
    <section
      ref={regionRef}
      aria-label="Sources on this page"
      style={{ paddingTop: BAR_TOP_PX }}
      className={`pointer-events-none mx-auto w-full max-w-[760px] ${isMobile ? 'px-3' : 'px-6'}`}
      onKeyDown={onRegionKeyDown}
    >
      <div
        ref={cardRef}
        style={offset ? { transform: `translateY(${offset}px)` } : undefined}
        className="pointer-events-auto rounded-md border border-blue-200 bg-blue-50 text-[13px] text-blue-900 shadow-[var(--lens-popover-shadow)]"
        onMouseDown={keepEditorFocus}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5">
          <p className={`min-w-0 flex-1 break-words ${isMobile ? 'order-1 basis-0' : 'basis-64'}`}>{model.text}</p>
          {actions && (
            <div className={`flex items-center gap-1 ${isMobile ? 'order-3 basis-full' : 'shrink-0'}`}>
              {actions}
              {!isMobile && hide}
            </div>
          )}
          {(isMobile || !actions) && hide}
        </div>
        {panel}
      </div>
    </section>
  );
}

export interface SourceLinksBarProps {
  docId: string;
  /** The open file's editor path. */
  path: string | undefined;
  /** `workflowAccess(...).addSource`. */
  canImport: boolean;
  /** The page is in Suggesting mode. */
  suggesting?: boolean;
  /** The folder metadata: a link swapped here needs its target in it. */
  metadata?: FolderMetadata;
  editorView: EditorView | null;
  /** Lets the editor reach this page's sources. */
  menuTargetRef?: RefObject<SourceLinkMenuTarget | null>;
}

/**
 * Offers to import a page's external sources into the library and swap their
 * links for wikilinks. One line above the page, never a dialog, and it never
 * takes the keyboard: see the "Editor" section of
 * docs/plans/2026-11-02-import-and-link-sources.md.
 */
export function SourceLinksBar({
  docId,
  path,
  canImport,
  suggesting,
  metadata,
  editorView,
  menuTargetRef,
}: SourceLinksBarProps) {
  const doc = useYDoc();
  const { displayName } = useDisplayName();
  const { isMobile } = useMobile();
  const swapInPage = useCallback(
    (hits: LibraryHit[]) => {
      if (!editorView || !metadata || !path) return [];
      return swapLinksInEditor(editorView, doc.getText('contents').length, metadata, path, hits);
    },
    [doc, editorView, metadata, path],
  );
  const { model, session } = useSourceLinks({ doc, docId, path, displayName, canImport, suggesting, swapInPage });

  const { awareness } = useYjsProvider();
  const placeRef = useRef<(() => void) | null>(null);
  const marginRef = useRef(0);
  useEffect(() => {
    if (!session) return;
    session.setAwareness(awareness);
    if (editorView) session.setCaret(editorView.state.selection.main.head);
    if (!menuTargetRef) return;
    menuTargetRef.current = {
      canImport: session.canImport,
      importSource: session.importSource,
      editorChanged: (view) => {
        session.setCaret(view.state.selection.main.head);
        placeRef.current?.();
      },
      scrollMargin: () => marginRef.current,
    };
    return () => {
      menuTargetRef.current = null;
      session.setAwareness(null);
    };
  }, [menuTargetRef, session, editorView, awareness]);

  if (!session) return null;
  return (
    <>
      {/* Always mounted: a live region only speaks of changes to what it held */}
      <div role="status" aria-live="polite" className="sr-only">{model.announce}</div>
      {model.kind !== 'hidden' && (
        <Bar
          key={docId}
          model={model}
          session={session}
          isMobile={isMobile}
          editorView={editorView}
          metadata={metadata}
          returnFocus={() => editorView?.focus()}
          placeRef={placeRef}
          marginRef={marginRef}
        />
      )}
    </>
  );
}
