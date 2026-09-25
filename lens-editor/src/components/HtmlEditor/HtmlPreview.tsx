import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { BRIDGE_SOURCE } from 'virtual:bridge-bundle';
import {
  makeNonce,
  validateEnvelope,
  type AnchorCapture,
  type BridgeToParent,
  type Envelope,
  type PageProblem,
  type ParentToBridge,
  type Rect,
  type StorageOp,
  type PreviewScrollState,
  type PreviewUiState,
  type ThreadMark,
  type ThreadsResolvedPayload,
} from './bridge/protocol';
import { buildSrcDoc } from './runtime/page-runtime';
import { readAnchor, type HtmlAnchor } from './anchoring/types';
import { withoutLegacyTextAnchors } from './comments/legacy';

export interface HtmlPreviewProps {
  ytext: Y.Text;
  debounceMs?: number;
  /** Threads to place and draw in the page. */
  threads?: ThreadMark[];
  /** The anchor of the comment being written, highlighted while composing. */
  draft?: HtmlAnchor | null;
  focusedThreadId?: string | null;
  commentMode?: boolean;
  onThreadsResolved?: (payload: ThreadsResolvedPayload) => void;
  onScrollState?: (payload: PreviewScrollState) => void;
  onThreadClicked?: (id: string) => void;
  onAnchorCaptured?: (capture: AnchorCapture) => void;
  onCommentModeExit?: () => void;
  /** The Comment-mode shortcut (C) pressed while focus was inside the page. */
  onShortcut?: () => void;
  /** A text selection in the page (viewport rect of the frame), or null when cleared. */
  onSelectionChanged?: (rect: Rect | null) => void;
  onLegacyDescribed?: (anchors: Record<string, HtmlAnchor | null>) => void;
  onCurrentDescribed?: (id: string, anchor: HtmlAnchor | null) => void;
  /** Stable per-document key under which the page's localStorage is kept for
   *  this viewer. Without it the page's storage lasts only until the next render. */
  storageKey?: string;
  /** Problems reported by the currently shown page (errors, blocked resources). */
  onPageProblems?: (problems: PageProblem[]) => void;
}

export interface HtmlPreviewHandle {
  /** Turn the page's current text selection into an anchor (anchor-captured). */
  captureSelection(): void;
  /** Describe where the given legacy inline comments render (legacy-described). */
  describeLegacy(ids: string[]): void;
  /** Describe the current target of a thread afresh (current-described). */
  describeCurrent(id: string): void;
  /** Scroll the page so the thread's target is in view. */
  revealThread(id: string): void;
  /** The visible frame, for mapping its viewport coordinates. */
  frameElement(): HTMLIFrameElement | null;
}

type PreviewScroll = { x: number; y: number };
interface PreviewFrame {
  id: number;
  srcDoc: string;
  state: 'active' | 'loading' | 'settling';
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isReadyMessage(data: unknown): boolean {
  if (!isObject(data) || !isObject(data.message)) return false;
  if (data.nonce !== '') return false;
  const message = data.message;
  return message.type === 'ready' && isObject(message.payload);
}

function postToBridge(iframe: HTMLIFrameElement | null, nonce: string, message: ParentToBridge): void {
  iframe?.contentWindow?.postMessage({ nonce, message } satisfies Envelope<ParentToBridge>, '*');
}

function isPreviewScrollState(value: unknown): value is PreviewScrollState {
  if (!isObject(value)) return false;
  return typeof value.x === 'number'
    && typeof value.y === 'number'
    && typeof value.scrollWidth === 'number'
    && typeof value.clientWidth === 'number'
    && typeof value.scrollHeight === 'number'
    && typeof value.clientHeight === 'number';
}

/** Normalise a PreviewScrollState so layoutVersion is always a number. */
function normalizeScrollState(value: PreviewScrollState): PreviewScrollState {
  return {
    ...value,
    layoutVersion: typeof value.layoutVersion === 'number' ? value.layoutVersion : 0,
  };
}

function isPreviewUiState(value: unknown): value is PreviewUiState {
  if (!isObject(value) || !Array.isArray(value.details)) return false;
  return value.details.every(item => (
    isObject(item)
    && Array.isArray(item.path)
    && item.path.every(Number.isInteger)
    && typeof item.open === 'boolean'
  ));
}

function isCloseScroll(actual: PreviewScroll, expected: PreviewScroll): boolean {
  return Math.abs(actual.x - expected.x) < 2 && Math.abs(actual.y - expected.y) < 2;
}

function isClampedCloseScroll(actual: PreviewScrollState, expected: PreviewScroll): boolean {
  const maxX = Math.max(0, actual.scrollWidth - actual.clientWidth);
  const maxY = Math.max(0, actual.scrollHeight - actual.clientHeight);
  return isCloseScroll(actual, {
    x: Math.max(0, Math.min(maxX, expected.x)),
    y: Math.max(0, Math.min(maxY, expected.y)),
  });
}

/** Sandbox for the visible preview. Links may open new tabs (unsandboxed),
 *  pages may offer downloads, and forms fire submit events (the bridge keeps
 *  the submission from navigating). Modals stay off: the preview re-renders
 *  while you type and an alert() would fire on every render. */
const PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads';

const PAGE_STORAGE_PREFIX = 'lens-html-page-storage:';
/** Per-document cap on a page's stored characters (keys + values). */
const PAGE_STORAGE_MAX_CHARS = 200_000;
/** Cap across all pages, so pages can never crowd out the editor's own storage. */
const PAGE_STORAGE_TOTAL_MAX_CHARS = 1_000_000;

interface StoredPage {
  at: number;
  items: Record<string, string>;
}

function readStoredPage(raw: string | null): StoredPage | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed) || typeof parsed.at !== 'number' || !isStringRecord(parsed.items)) return null;
    return { at: parsed.at, items: parsed.items };
  } catch {
    return null;
  }
}

function readPageStorage(storageKey: string | undefined): Record<string, string> | null {
  if (!storageKey) return null;
  try {
    return readStoredPage(localStorage.getItem(PAGE_STORAGE_PREFIX + storageKey))?.items ?? null;
  } catch {
    return null;
  }
}

function storedChars(items: Record<string, string>): number {
  let n = 0;
  for (const [k, v] of Object.entries(items)) n += k.length + v.length;
  return n;
}

/** Drop the least recently written pages until the total fits the budget. */
function evictPageStorage(keepKey: string): void {
  const entries: Array<{ key: string; at: number; size: number }> = [];
  let total = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(PAGE_STORAGE_PREFIX)) continue;
    const raw = localStorage.getItem(key) ?? '';
    const page = readStoredPage(raw);
    entries.push({ key, at: page?.at ?? 0, size: raw.length });
    total += raw.length;
  }
  entries.sort((a, b) => a.at - b.at);
  for (const entry of entries) {
    if (total <= PAGE_STORAGE_TOTAL_MAX_CHARS) break;
    if (entry.key === keepKey) continue;
    localStorage.removeItem(entry.key);
    total -= entry.size;
  }
}

/** Apply a page's storage changes to the viewer's stored copy. Returns false
 *  when the result would exceed the per-page cap (nothing is written). */
function applyPageStorageOps(storageKey: string, ops: StorageOp[]): boolean {
  const key = PAGE_STORAGE_PREFIX + storageKey;
  try {
    const items = { ...(readStoredPage(localStorage.getItem(key))?.items ?? {}) };
    for (const op of ops) {
      if (op.op === 'set') items[op.key] = op.value;
      else if (op.op === 'remove') delete items[op.key];
      else for (const k of Object.keys(items)) delete items[k];
    }
    if (Object.keys(items).length === 0) {
      localStorage.removeItem(key);
      return true;
    }
    if (storedChars(items) > PAGE_STORAGE_MAX_CHARS) return false;
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), items } satisfies StoredPage));
    evictPageStorage(key);
    return true;
  } catch {
    // Storage full or blocked: the page keeps working with in-memory state.
    return true;
  }
}

function isStorageOpList(value: unknown): value is StorageOp[] {
  return Array.isArray(value) && value.length <= 10_000 && value.every(op => (
    isObject(op) && (
      (op.op === 'set' && typeof op.key === 'string' && typeof op.value === 'string')
      || (op.op === 'remove' && typeof op.key === 'string')
      || op.op === 'clear'
    )
  ));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value).every(v => typeof v === 'string');
}

const MAX_PAGE_PROBLEMS = 25;
/** How long an answer to a request (capture the selection, describe
 *  comments) is awaited. */
const REPLY_WINDOW_MS = 5_000;
/** A page that keeps navigating itself away is reloaded at most this often. */
const MAX_NAVIGATION_RELOADS = 3;
const NAVIGATED_PROBLEM: PageProblem = {
  kind: 'error',
  message: 'The page navigated away from itself (location.href, or a link or form with target="_self"), so the preview reloaded it. Open other pages with a normal link; links open in a new tab.',
  count: 1,
};

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The page can forge these messages, so bound what it can put in the editor UI. */
function sanitizePageProblems(problems: PageProblem[]): PageProblem[] {
  return problems.slice(0, MAX_PAGE_PROBLEMS).map(p => ({
    kind: p.kind,
    message: clip(p.message, 300),
    ...(p.source !== undefined ? { source: clip(p.source, 200) } : {}),
    count: Math.max(1, Math.min(Math.floor(p.count), 9999)),
  }));
}

function isPageProblemList(value: unknown): value is PageProblem[] {
  return Array.isArray(value) && value.every(p => (
    typeof p === 'object' && p !== null
    && (p.kind === 'error' || p.kind === 'blocked' || p.kind === 'load-failed' || p.kind === 'overflow')
    && typeof p.message === 'string'
    && (p.source === undefined || typeof p.source === 'string')
    && typeof p.count === 'number'
  ));
}

function previewSrcDoc(source: string, storageKey: string | undefined): string {
  return buildSrcDoc(withoutLegacyTextAnchors(source), {
    bridgeSource: BRIDGE_SOURCE,
    storageSeed: readPageStorage(storageKey),
  });
}

function isRect(value: unknown): value is Rect {
  return isObject(value)
    && Number.isFinite(value.x) && Number.isFinite(value.y)
    && Number.isFinite(value.w) && Number.isFinite(value.h);
}

const ANCHOR_STATES = new Set(['anchored', 'guessed', 'hidden', 'orphaned']);

/** The page can forge bridge messages, so every placement is re-validated. */
function readThreadsResolved(value: unknown): ThreadsResolvedPayload | null {
  if (!isObject(value) || !Array.isArray(value.placements)) return null;
  const readPlacement = (p: unknown) => {
    if (!isObject(p) || typeof p.id !== 'string' || !ANCHOR_STATES.has(p.state as string)) return null;
    const refreshed = p.refreshed === undefined ? null : readAnchor(p.refreshed);
    return {
      id: p.id,
      state: p.state as ThreadsResolvedPayload['placements'][number]['state'],
      rect: isRect(p.rect) ? p.rect : null,
      textOffset: typeof p.textOffset === 'number' && Number.isFinite(p.textOffset) ? p.textOffset : null,
      ...(typeof p.currentQuote === 'string' ? { currentQuote: p.currentQuote.slice(0, 2000) } : {}),
      ...(refreshed ? { refreshed } : {}),
    };
  };
  const placements = value.placements.slice(0, 2000).map(readPlacement).filter(p => p !== null);
  return {
    placements,
    draft: value.draft === null || value.draft === undefined ? null : readPlacement(value.draft),
    baselineScrollY: typeof value.baselineScrollY === 'number' ? value.baselineScrollY : 0,
    layoutVersion: typeof value.layoutVersion === 'number' ? value.layoutVersion : 0,
    settled: value.settled === true,
  };
}

function readAnchorCapture(value: unknown): AnchorCapture | null {
  if (!isObject(value) || !isRect(value.rect)) return null;
  const anchor = readAnchor(value.anchor);
  if (!anchor) return null;
  const via = value.via === 'selection' || value.via === 'element' ? value.via : 'click';
  return {
    anchor,
    rect: value.rect,
    via,
    ...(typeof value.warning === 'string' ? { warning: value.warning.slice(0, 400) } : {}),
  };
}

function hasDetailsElementMarkup(source: string): boolean {
  return /<details\b/i.test(source);
}

export const HtmlPreview = forwardRef<HtmlPreviewHandle, HtmlPreviewProps>(function HtmlPreview({
  ytext,
  debounceMs = 300,
  threads,
  draft = null,
  focusedThreadId = null,
  commentMode = false,
  onThreadsResolved,
  onScrollState,
  onThreadClicked,
  onAnchorCaptured,
  onCommentModeExit,
  onShortcut,
  onSelectionChanged,
  onLegacyDescribed,
  onCurrentDescribed,
  storageKey,
  onPageProblems,
}, handleRef) {
  const [content, setContent] = useState(() => ytext.toString());
  const [debounced, setDebounced] = useState(content);
  const [frames, setFrames] = useState<PreviewFrame[]>(() => [{
    id: 1,
    srcDoc: previewSrcDoc(content, storageKey),
    state: 'active',
  }]);
  const [nonce] = useState(() => makeNonce());
  const frameRefs = useRef(new Map<number, HTMLIFrameElement>());
  const problemsByFrameRef = useRef(new Map<number, PageProblem[]>());
  // Loads per frame: a srcdoc frame loads once, so any later load means the
  // page navigated itself to another document.
  const frameLoadsRef = useRef(new Map<number, number>());
  const reloadingFramesRef = useRef(new Set<number>());
  const navigatedFramesRef = useRef(new Map<number, number>());
  const [problemsVersion, setProblemsVersion] = useState(0);
  const nextFrameIdRef = useRef(2);
  const framesRef = useRef(frames);
  const activeFrameIdRef = useRef(1);
  const mountedRef = useRef(true);
  const pendingRestoreScrollRef = useRef<PreviewScroll | null>(null);
  const lastUiStateRef = useRef<PreviewUiState | null>(null);
  const pendingUiStateRestoreRef = useRef<PreviewUiState | null>(null);
  const pendingUiStateCaptureRef = useRef(false);
  const deferredRestoreFrameIdRef = useRef<number | null>(null);
  const uiStateCaptureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastKnownScrollRef = useRef<PreviewScrollState>({
    x: 0,
    y: 0,
    scrollWidth: 0,
    clientWidth: 0,
    scrollHeight: 0,
    clientHeight: 0,
    layoutVersion: 0,
  });
  const restoringFrameIdRef = useRef<number | null>(null);
  const restoringScrollRef = useRef<{ frameId: number; scroll: PreviewScroll } | null>(null);
  const postActivationRestoreRef = useRef<{ frameId: number; scroll: PreviewScroll } | null>(null);
  // Placements measured by a frame that is still loading; applied when it
  // becomes the visible one.
  const pendingResolvedRef = useRef(new Map<number, ThreadsResolvedPayload>());

  // The latest comment state, read when a new frame initialises.
  const threadsRef = useRef<ThreadMark[]>(threads ?? []);
  const draftRef = useRef<HtmlAnchor | null>(draft);
  const focusedRef = useRef<string | null>(focusedThreadId);
  const commentModeRef = useRef(commentMode);

  const postToFrame = useCallback((frameId: number, message: ParentToBridge): void => {
    postToBridge(frameRefs.current.get(frameId) ?? null, nonce, message);
  }, [nonce]);

  const postToAllFrames = useCallback((message: ParentToBridge): void => {
    for (const frame of framesRef.current) postToFrame(frame.id, message);
  }, [postToFrame]);

  const postToActiveFrame = useCallback((message: ParentToBridge): void => {
    postToFrame(activeFrameIdRef.current, message);
  }, [postToFrame]);

  // Replies the page may send only because we asked. The page can forge any
  // bridge message, so an unrequested capture or description is ignored.
  const pendingRef = useRef({ selectionAt: 0, legacyAt: 0, current: new Set<string>() });

  useImperativeHandle(handleRef, () => ({
    captureSelection: () => {
      pendingRef.current.selectionAt = Date.now();
      postToActiveFrame({ type: 'capture-selection', payload: {} });
    },
    describeLegacy: ids => {
      pendingRef.current.legacyAt = Date.now();
      postToActiveFrame({ type: 'describe-legacy', payload: { ids } });
    },
    describeCurrent: id => {
      pendingRef.current.current.add(id);
      postToActiveFrame({ type: 'describe-current', payload: { id } });
    },
    revealThread: id => postToActiveFrame({ type: 'set-focused-thread', payload: { id, reveal: true } }),
    frameElement: () => frameRefs.current.get(activeFrameIdRef.current) ?? null,
  }), [postToActiveFrame]);

  const restoreFrameLayout = useCallback((frame: PreviewFrame): void => {
    const uiState = pendingUiStateRestoreRef.current ?? lastUiStateRef.current;
    if (uiState) {
      postToFrame(frame.id, { type: 'restore-ui-state', payload: uiState });
    }
    if (frame.state === 'loading') {
      restoringFrameIdRef.current = frame.id;
      const pendingScroll = pendingRestoreScrollRef.current;
      const scroll = pendingScroll ?? lastKnownScrollRef.current;
      const restoreScroll = { x: scroll.x, y: scroll.y };
      restoringScrollRef.current = { frameId: frame.id, scroll: restoreScroll };
      postToFrame(frame.id, { type: 'restore-scroll', payload: restoreScroll });
      pendingRestoreScrollRef.current = null;
    } else {
      const scroll = pendingRestoreScrollRef.current ?? lastKnownScrollRef.current;
      postToFrame(frame.id, { type: 'restore-scroll', payload: { x: scroll.x, y: scroll.y } });
    }
  }, [postToFrame]);

  const clearUiStateCaptureTimer = useCallback((): void => {
    if (uiStateCaptureTimerRef.current === null) return;
    clearTimeout(uiStateCaptureTimerRef.current);
    uiStateCaptureTimerRef.current = null;
  }, []);

  useEffect(() => {
    framesRef.current = frames;
    activeFrameIdRef.current = frames.find(frame => frame.state === 'active')?.id ?? frames[0]?.id ?? 1;
    const liveFrameIds = new Set(frames.map(frame => frame.id));
    for (const frameId of Array.from(pendingResolvedRef.current.keys())) {
      if (!liveFrameIds.has(frameId)) pendingResolvedRef.current.delete(frameId);
    }
  }, [frames]);

  // null, not '[]': a remounted preview must report its (possibly empty) list
  // even if the last report before unmount was non-empty.
  const lastReportedProblemsRef = useRef<string | null>(null);
  const onPageProblemsRef = useRef(onPageProblems);
  useEffect(() => { onPageProblemsRef.current = onPageProblems; }, [onPageProblems]);
  useEffect(() => () => onPageProblemsRef.current?.([]), []);
  useEffect(() => {
    const liveFrameIds = new Set(frames.map(frame => frame.id));
    for (const frameId of Array.from(problemsByFrameRef.current.keys())) {
      if (!liveFrameIds.has(frameId)) problemsByFrameRef.current.delete(frameId);
    }
    for (const map of [frameLoadsRef.current, navigatedFramesRef.current]) {
      for (const frameId of Array.from(map.keys())) {
        if (!liveFrameIds.has(frameId)) map.delete(frameId);
      }
    }
    const activeId = frames.find(frame => frame.state === 'active')?.id ?? frames[0]?.id;
    const reported = activeId === undefined ? [] : problemsByFrameRef.current.get(activeId) ?? [];
    const navigated = activeId !== undefined && navigatedFramesRef.current.has(activeId);
    const problems = navigated
      ? [...reported, { ...NAVIGATED_PROBLEM, count: navigatedFramesRef.current.get(activeId) ?? 1 }]
      : reported;
    const serialized = JSON.stringify(problems);
    if (serialized === lastReportedProblemsRef.current) return;
    lastReportedProblemsRef.current = serialized;
    onPageProblems?.(problems);
  }, [frames, problemsVersion, onPageProblems]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearUiStateCaptureTimer();
    };
  }, [clearUiStateCaptureTimer]);

  useEffect(() => {
    const sync = () => setContent(ytext.toString());
    sync();
    ytext.observe(sync);
    return () => ytext.unobserve(sync);
  }, [ytext]);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(content), debounceMs);
    return () => clearTimeout(handle);
  }, [content, debounceMs]);

  useEffect(() => {
    const nextSrcDoc = previewSrcDoc(debounced, storageKey);
    const activeFrame = framesRef.current.find(frame => frame.state === 'active') ?? framesRef.current[0];
    const shouldCaptureUiState = activeFrame?.srcDoc !== nextSrcDoc
      && (hasDetailsElementMarkup(activeFrame?.srcDoc ?? '') || hasDetailsElementMarkup(nextSrcDoc));
    if (shouldCaptureUiState) {
      pendingUiStateCaptureRef.current = true;
      clearUiStateCaptureTimer();
      postToBridge(frameRefs.current.get(activeFrameIdRef.current) ?? null, nonce, {
        type: 'capture-ui-state',
        payload: {},
      });
      uiStateCaptureTimerRef.current = setTimeout(() => {
        uiStateCaptureTimerRef.current = null;
        pendingUiStateCaptureRef.current = false;
        const frameId = deferredRestoreFrameIdRef.current;
        if (frameId === null) return;
        deferredRestoreFrameIdRef.current = null;
        const frame = framesRef.current.find(candidate => candidate.id === frameId);
        if (frame) restoreFrameLayout(frame);
      }, 100);
    } else {
      pendingUiStateCaptureRef.current = false;
      deferredRestoreFrameIdRef.current = null;
      clearUiStateCaptureTimer();
    }
    setFrames(currentFrames => {
      const activeFrame = currentFrames.find(frame => frame.state === 'active') ?? currentFrames[0];
      if (activeFrame?.srcDoc === nextSrcDoc) {
        restoringFrameIdRef.current = null;
        restoringScrollRef.current = null;
        postActivationRestoreRef.current = null;
        pendingRestoreScrollRef.current = null;
        pendingUiStateRestoreRef.current = null;
        pendingUiStateCaptureRef.current = false;
        deferredRestoreFrameIdRef.current = null;
        clearUiStateCaptureTimer();
        return activeFrame.state === 'active' && currentFrames.length === 1
          ? currentFrames
          : [{ ...activeFrame, state: 'active' }];
      }
      const existingLoadingFrame = currentFrames.find(frame => (
        frame.state === 'loading' && frame.srcDoc === nextSrcDoc
      ));
      if (existingLoadingFrame) {
        return [
          ...(activeFrame ? [activeFrame] : []),
          existingLoadingFrame,
        ];
      }
      return [
        ...(activeFrame ? [activeFrame] : []),
        {
          id: nextFrameIdRef.current++,
          srcDoc: nextSrcDoc,
          state: 'loading',
        },
      ];
    });
  }, [clearUiStateCaptureTimer, debounced, nonce, restoreFrameLayout, storageKey]);

  useEffect(() => {
    const pending = postActivationRestoreRef.current;
    if (!pending) return;
    const pendingFrame = frames.find(frame => frame.id === pending.frameId);
    if (pendingFrame?.state !== 'settling') return;
    postActivationRestoreRef.current = null;
    requestAnimationFrame(() => {
      if (!mountedRef.current) return;
      if (framesRef.current.find(frame => frame.id === pending.frameId)?.state !== 'settling') return;
      postToFrame(pending.frameId, { type: 'restore-scroll', payload: pending.scroll });
    });
  }, [frames, postToFrame]);

  const findFrameIdByWindow = useCallback((source: MessageEventSource | null): number | null => {
    for (const [frameId, iframe] of frameRefs.current) {
      if (iframe.contentWindow === source) return frameId;
    }
    return null;
  }, []);

  const handleFrameLoad = useCallback((frame: PreviewFrame): void => {
    const loads = (frameLoadsRef.current.get(frame.id) ?? 0) + 1;
    frameLoadsRef.current.set(frame.id, loads);
    if (loads === 1) return;
    if (reloadingFramesRef.current.delete(frame.id)) return; // our own reload below
    const times = (navigatedFramesRef.current.get(frame.id) ?? 0) + 1;
    navigatedFramesRef.current.set(frame.id, times);
    setProblemsVersion(version => version + 1);
    if (times > MAX_NAVIGATION_RELOADS) return;
    const iframe = frameRefs.current.get(frame.id);
    if (!iframe) return;
    reloadingFramesRef.current.add(frame.id);
    // Re-setting srcdoc navigates the frame back to the page.
    iframe.srcdoc = frame.srcDoc;
  }, []);

  const onThreadsResolvedRef = useRef(onThreadsResolved);
  useEffect(() => { onThreadsResolvedRef.current = onThreadsResolved; }, [onThreadsResolved]);

  const activateRestoredFrame = useCallback((frameId: number): void => {
    restoringFrameIdRef.current = null;
    restoringScrollRef.current = null;
    postActivationRestoreRef.current = null;
    pendingUiStateRestoreRef.current = null;
    deferredRestoreFrameIdRef.current = null;
    const pendingResolved = pendingResolvedRef.current.get(frameId);
    if (pendingResolved) {
      pendingResolvedRef.current.delete(frameId);
      onThreadsResolvedRef.current?.(pendingResolved);
    }
    setFrames(currentFrames => {
      const target = currentFrames.find(frame => frame.id === frameId);
      if (!target) return currentFrames;
      return [{ ...target, state: 'active' }];
    });
  }, []);

  const settleRestoredFrame = useCallback((frameId: number): void => {
    const intendedScroll = restoringScrollRef.current?.frameId === frameId
      ? restoringScrollRef.current.scroll
      : { x: lastKnownScrollRef.current.x, y: lastKnownScrollRef.current.y };
    postActivationRestoreRef.current = {
      frameId,
      scroll: intendedScroll,
    };
    restoringFrameIdRef.current = null;
    setFrames(currentFrames => {
      const activeFrame = currentFrames.find(frame => frame.state === 'active') ?? currentFrames[0];
      const target = currentFrames.find(frame => frame.id === frameId);
      if (!target) return currentFrames;
      return [
        ...(activeFrame && activeFrame.id !== frameId ? [activeFrame] : []),
        { ...target, state: 'settling' },
      ];
    });
  }, []);

  const initializeFrame = useCallback((frame: PreviewFrame): void => {
    postToFrame(frame.id, { type: 'init', payload: {} });
    postToFrame(frame.id, { type: 'set-threads', payload: { threads: threadsRef.current } });
    postToFrame(frame.id, { type: 'set-draft', payload: { anchor: draftRef.current } });
    postToFrame(frame.id, { type: 'set-focused-thread', payload: { id: focusedRef.current, reveal: false } });
    postToFrame(frame.id, { type: 'set-comment-mode', payload: { on: commentModeRef.current } });
    if (frame.state === 'loading' && pendingUiStateCaptureRef.current) {
      deferredRestoreFrameIdRef.current = frame.id;
      return;
    }
    restoreFrameLayout(frame);
  }, [postToFrame, restoreFrameLayout]);

  const callbacksRef = useRef({
    onScrollState, onThreadClicked, onAnchorCaptured, onCommentModeExit, onShortcut, onSelectionChanged,
    onLegacyDescribed, onCurrentDescribed,
  });
  useEffect(() => {
    callbacksRef.current = {
      onScrollState, onThreadClicked, onAnchorCaptured, onCommentModeExit, onShortcut, onSelectionChanged,
      onLegacyDescribed, onCurrentDescribed,
    };
  });

  useEffect(() => {
    function handleMessage(message: BridgeToParent, frame: PreviewFrame) {
      const callbacks = callbacksRef.current;
      if (message.type === 'scroll-state') {
        if (!isPreviewScrollState(message.payload)) return;
        const scrollPayload = normalizeScrollState(message.payload);
        if (frame.state === 'active') {
          lastKnownScrollRef.current = scrollPayload;
          callbacks.onScrollState?.(scrollPayload);
        }
        if (restoringFrameIdRef.current === frame.id) {
          const intended = restoringScrollRef.current?.frameId === frame.id
            ? restoringScrollRef.current.scroll
            : { x: lastKnownScrollRef.current.x, y: lastKnownScrollRef.current.y };
          if (isCloseScroll(scrollPayload, intended)) activateRestoredFrame(frame.id);
          else settleRestoredFrame(frame.id);
        } else if (frame.state === 'settling') {
          const intended = restoringScrollRef.current?.frameId === frame.id
            ? restoringScrollRef.current.scroll
            : { x: lastKnownScrollRef.current.x, y: lastKnownScrollRef.current.y };
          if (isClampedCloseScroll(scrollPayload, intended)) activateRestoredFrame(frame.id);
        }
        return;
      }

      if (message.type === 'ui-state') {
        if (frame.state !== 'active') return;
        if (!isPreviewUiState(message.payload)) return;
        pendingUiStateCaptureRef.current = false;
        clearUiStateCaptureTimer();
        lastUiStateRef.current = message.payload;
        pendingUiStateRestoreRef.current = message.payload;
        const deferredFrameId = deferredRestoreFrameIdRef.current;
        if (deferredFrameId !== null) {
          deferredRestoreFrameIdRef.current = null;
          const deferredFrame = framesRef.current.find(candidate => candidate.id === deferredFrameId);
          if (deferredFrame) restoreFrameLayout(deferredFrame);
        }
        return;
      }

      if (message.type === 'page-problems') {
        if (!isObject(message.payload) || !isPageProblemList(message.payload.problems)) return;
        problemsByFrameRef.current.set(frame.id, sanitizePageProblems(message.payload.problems));
        setProblemsVersion(version => version + 1);
        return;
      }

      if (message.type === 'storage-ops') {
        if (!storageKey) return;
        if (!isObject(message.payload) || !isStorageOpList(message.payload.ops)) return;
        if (!applyPageStorageOps(storageKey, message.payload.ops)) {
          const list = problemsByFrameRef.current.get(frame.id) ?? [];
          const text = `localStorage is over ${PAGE_STORAGE_MAX_CHARS.toLocaleString('en')} characters, so changes are not kept between visits`;
          if (!list.some(p => p.message === text)) {
            problemsByFrameRef.current.set(frame.id, [...list, { kind: 'error', message: text, count: 1 }]);
            setProblemsVersion(version => version + 1);
          }
        }
        return;
      }

      if (message.type === 'threads-resolved') {
        const payload = readThreadsResolved(message.payload);
        if (!payload) return;
        if (frame.state === 'active') {
          pendingResolvedRef.current.delete(frame.id);
          onThreadsResolvedRef.current?.(payload);
        } else {
          pendingResolvedRef.current.set(frame.id, payload);
        }
        return;
      }

      if (frame.state !== 'active') return;

      switch (message.type) {
        case 'thread-clicked':
          if (!isObject(message.payload) || typeof message.payload.id !== 'string') return;
          callbacks.onThreadClicked?.(message.payload.id);
          break;
        case 'anchor-captured': {
          const capture = readAnchorCapture(message.payload);
          // Only while the user is commenting, or right after they asked to
          // comment on their selection: the page cannot open a composer.
          const pending = pendingRef.current;
          const requested = Date.now() - pending.selectionAt < REPLY_WINDOW_MS;
          if (capture && (commentModeRef.current || requested)) {
            pending.selectionAt = 0;
            callbacks.onAnchorCaptured?.(capture);
          }
          break;
        }
        case 'comment-mode-exit':
          callbacks.onCommentModeExit?.();
          break;
        case 'shortcut':
          callbacks.onShortcut?.();
          break;
        case 'selection-changed':
          if (!isObject(message.payload)) return;
          callbacks.onSelectionChanged?.(isRect(message.payload.rect) ? message.payload.rect : null);
          break;
        case 'legacy-described': {
          if (Date.now() - pendingRef.current.legacyAt > REPLY_WINDOW_MS) return;
          pendingRef.current.legacyAt = 0;
          if (!isObject(message.payload) || !isObject(message.payload.anchors)) return;
          const anchors: Record<string, HtmlAnchor | null> = {};
          for (const [id, value] of Object.entries(message.payload.anchors)) anchors[id] = readAnchor(value);
          callbacks.onLegacyDescribed?.(anchors);
          break;
        }
        case 'current-described':
          if (!isObject(message.payload) || typeof message.payload.id !== 'string') return;
          if (!pendingRef.current.current.delete(message.payload.id)) return;
          callbacks.onCurrentDescribed?.(message.payload.id, readAnchor(message.payload.anchor));
          break;
        default:
          break;
      }
    }

    function onMessage(event: MessageEvent) {
      const frameId = findFrameIdByWindow(event.source);
      if (frameId === null) return;
      const frame = framesRef.current.find(candidate => candidate.id === frameId);
      if (!frame) return;

      if (isReadyMessage(event.data)) {
        initializeFrame(frame);
        return;
      }

      const message = validateEnvelope<BridgeToParent>(event.data, nonce);
      if (!message || typeof message.type !== 'string') return;
      handleMessage(message, frame);
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [
    activateRestoredFrame,
    clearUiStateCaptureTimer,
    findFrameIdByWindow,
    initializeFrame,
    nonce,
    restoreFrameLayout,
    settleRestoredFrame,
    storageKey,
  ]);

  useEffect(() => {
    threadsRef.current = threads ?? [];
    postToAllFrames({ type: 'set-threads', payload: { threads: threads ?? [] } });
  }, [threads, postToAllFrames]);

  useEffect(() => {
    draftRef.current = draft;
    postToAllFrames({ type: 'set-draft', payload: { anchor: draft } });
  }, [draft, postToAllFrames]);

  useEffect(() => {
    focusedRef.current = focusedThreadId;
    postToAllFrames({ type: 'set-focused-thread', payload: { id: focusedThreadId, reveal: false } });
  }, [focusedThreadId, postToAllFrames]);

  useEffect(() => {
    commentModeRef.current = commentMode;
    postToAllFrames({ type: 'set-comment-mode', payload: { on: commentMode } });
  }, [commentMode, postToAllFrames]);

  return (
    <div className="relative h-full w-full">
      {frames.map(frame => (
        <iframe
          key={frame.id}
          ref={(node) => {
            if (node) frameRefs.current.set(frame.id, node);
            else frameRefs.current.delete(frame.id);
          }}
          title="HTML preview"
          sandbox={PREVIEW_SANDBOX}
          allow="clipboard-write; fullscreen"
          srcDoc={frame.srcDoc}
          onLoad={() => handleFrameLoad(frame)}
          data-preview-frame-state={frame.state}
          className={[
            'absolute inset-0 h-full w-full border-0 bg-white',
            frame.state === 'loading' || frame.state === 'settling' ? 'pointer-events-none opacity-0' : '',
          ].join(' ')}
        />
      ))}
    </div>
  );
});
