import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { BRIDGE_SOURCE } from 'virtual:bridge-bundle';
import { NewCommentCard } from './NewCommentCard';
import { addComment, parseComments } from './comment-store';
import { scoreCandidates, verifyByProbe, type Candidate, type ProbeRunner } from './position-finder';
import {
  makeNonce,
  validateEnvelope,
  type BridgeToParent,
  type CommentSummary,
  type CommentsRenderedPayload,
  type Envelope,
  type Fingerprint,
  type PageProblem,
  type ParentToBridge,
  type StorageOp,
  type PreviewScrollState,
  type PreviewUiState,
} from './bridge/protocol';
import { buildSrcDoc } from './runtime/page-runtime';

interface HtmlPreviewProps {
  ytext: Y.Text;
  currentUser?: string;
  origin?: unknown;
  debounceMs?: number;
  isCommentMode?: boolean;
  onPlaceComplete?: (commentId: string) => void;
  onManualPlacement?: (candidates: Candidate[]) => void;
  probeRunner?: ProbeRunner;
  readOnly?: boolean;
  /** Called when the bridge reports a dot click. Parent owns the focus state. */
  onDotClicked?: (id: string) => void;
  /** Called after a comment is successfully added from the placement flow. */
  onCommentAdded?: (id: string) => void;
  /** Raw bridge comments-rendered payload — parent uses it to update AnchorState. */
  onCommentsRendered?: (payload: CommentsRenderedPayload) => void;
  /** Raw bridge scroll-state payload (with layoutVersion). */
  onScrollState?: (payload: PreviewScrollState) => void;
  /** When this changes, HtmlPreview posts set-focused-comment to the bridge. */
  focusedCommentId?: string | null;
  /** Stable per-document key under which the page's localStorage is kept for
   *  this viewer. Without it the page's storage lasts only until the next render. */
  storageKey?: string;
  /** Problems reported by the currently shown page (errors, blocked resources). */
  onPageProblems?: (problems: PageProblem[]) => void;
}

type Rect = { x: number; y: number; w: number; h: number };
type PreviewPoint = { x: number; y: number };
type PreviewScroll = { x: number; y: number };
type PreviewPlacementTrigger = 'contextmenu' | 'selection' | 'toolbar';
type ProbeViewportSize = { width: number; height: number };
type ProbeViewportSizeGetter = () => ProbeViewportSize;
interface PendingPreviewComment {
  position: number;
  point: PreviewPoint;
  scroll: PreviewScroll;
  source: string;
}
interface PendingPlacementMenu {
  fingerprint: Fingerprint;
  point: PreviewPoint;
  scroll: PreviewScroll;
  source: string;
}
interface PlacementError {
  point: PreviewPoint;
  message: string;
}
interface PreviewFrame {
  id: number;
  srcDoc: string;
  state: 'active' | 'loading' | 'settling';
}
type PendingProbe = {
  frame: HTMLIFrameElement;
  resolve: (rect: Rect | null) => void;
  listener: (event: MessageEvent) => void;
  readyTimer: ReturnType<typeof setTimeout>;
  probeTimer: ReturnType<typeof setTimeout> | null;
};

const DEFAULT_PROBE_VIEWPORT_SIZE: ProbeViewportSize = { width: 1024, height: 768 };

function summarizeComments(source: string): CommentSummary[] {
  return parseComments(source).map((cluster, i) => ({
    id: cluster.comment.id,
    body: cluster.comment.body,
    replies: cluster.replies.length,
    order: i + 1,
  }));
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

function isRect(value: unknown): value is Rect {
  if (!isObject(value)) return false;
  return typeof value.x === 'number'
    && typeof value.y === 'number'
    && typeof value.w === 'number'
    && typeof value.h === 'number';
}

function isFingerprint(value: unknown): value is Fingerprint {
  if (!isObject(value)) return false;
  if (
    typeof value.before !== 'string'
    || typeof value.after !== 'string'
    || typeof value.tag !== 'string'
    || !Array.isArray(value.ancestorPath)
    || !isRect(value.clickRect)
  ) {
    return false;
  }
  return value.ancestorPath.every(frame => (
    isObject(frame)
    && typeof frame.tag === 'string'
    && typeof frame.index === 'number'
  ));
}

function isPoint(value: unknown): value is PreviewPoint {
  return isObject(value) && typeof value.x === 'number' && typeof value.y === 'number';
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

function isPlacementTrigger(value: unknown): value is PreviewPlacementTrigger {
  return value === 'contextmenu' || value === 'selection' || value === 'toolbar';
}

function isCommentsRenderedPayload(value: unknown): value is CommentsRenderedPayload {
  if (!isObject(value)) return false;
  if (!Array.isArray(value.found) || !Array.isArray(value.orphaned)) return false;
  // rects, baselineScrollY, layoutVersion are present in modern bridge payloads.
  // Default to empty/zero for older bridge versions so the guard stays forward-compatible.
  return true;
}

/** Normalise a CommentsRenderedPayload so callers always get the full shape. */
function normalizeCommentsRendered(payload: CommentsRenderedPayload): CommentsRenderedPayload {
  const onlyStrings = (xs: unknown): string[] =>
    Array.isArray(xs) ? xs.filter((x): x is string => typeof x === 'string') : [];
  return {
    found: onlyStrings(payload.found),
    orphaned: onlyStrings(payload.orphaned),
    rects: Array.isArray(payload.rects) ? payload.rects : [],
    baselineScrollY: typeof payload.baselineScrollY === 'number' ? payload.baselineScrollY : 0,
    layoutVersion: typeof payload.layoutVersion === 'number' ? payload.layoutVersion : 0,
  };
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

function isPlacementRequestPayload(
  value: unknown
): value is {
  trigger: PreviewPlacementTrigger;
  fingerprint: Fingerprint;
  point: PreviewPoint;
  scroll: PreviewScroll;
} {
  if (!isObject(value)) return false;
  return isPlacementTrigger(value.trigger)
    && isFingerprint(value.fingerprint)
    && isPoint(value.point)
    && isPoint(value.scroll);
}

function makeCommentId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function makeDiagnosticMarker(index: number): string {
  return `[[@${index}]]`;
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
  return buildSrcDoc(source, { bridgeSource: BRIDGE_SOURCE, storageSeed: readPageStorage(storageKey) });
}

function hasDetailsElementMarkup(source: string): boolean {
  return /<details\b/i.test(source);
}

function normalizeProbeViewportSize(size?: ProbeViewportSize): ProbeViewportSize {
  const width = size?.width;
  const height = size?.height;
  return {
    width: typeof width === 'number' && Number.isFinite(width) && width > 0
      ? width
      : DEFAULT_PROBE_VIEWPORT_SIZE.width,
    height: typeof height === 'number' && Number.isFinite(height) && height > 0
      ? height
      : DEFAULT_PROBE_VIEWPORT_SIZE.height,
  };
}

// Exported for the parent-side probe lifecycle tests and for future reuse by callers
// that need the same hidden-iframe ProbeRunner contract outside HtmlPreview.
// eslint-disable-next-line react-refresh/only-export-components
export function useHiddenProbeRunner(
  nonce: string,
  getViewportSize?: ProbeViewportSizeGetter,
  /** The visible frame's storage seed: a probe must render the same state
   *  (saved tab, collapsed section) or its rects won't match the click. */
  getStorageSeed?: () => Record<string, string> | null,
): ProbeRunner {
  const pendingRef = useRef(new Map<string, PendingProbe>());

  const runner = useMemo<ProbeRunner>(() => {
    function createIframe(): HTMLIFrameElement {
      const iframe = document.createElement('iframe');
      const { width, height } = normalizeProbeViewportSize(getViewportSize?.());
      iframe.setAttribute('sandbox', 'allow-scripts');
      iframe.style.cssText = `position:fixed;left:-9999px;top:-9999px;width:${width}px;height:${height}px;visibility:hidden;`;
      document.body.appendChild(iframe);
      return iframe;
    }

    function settle(token: string, rect: Rect | null): void {
      const pendingProbe = pendingRef.current.get(token);
      if (!pendingProbe) return;
      pendingRef.current.delete(token);
      clearTimeout(pendingProbe.readyTimer);
      if (pendingProbe.probeTimer) clearTimeout(pendingProbe.probeTimer);
      window.removeEventListener('message', pendingProbe.listener);
      pendingProbe.frame.remove();
      pendingProbe.resolve(rect);
    }

    function startProbe(token: string, pendingProbe: PendingProbe): void {
      if (pendingProbe.probeTimer) return;
      postToBridge(pendingProbe.frame, nonce, { type: 'init', payload: { comments: [] } });
      pendingProbe.probeTimer = setTimeout(() => settle(token, null), 2000);
      postToBridge(pendingProbe.frame, nonce, { type: 'find-probe', payload: { token } });
    }

    return {
      async run(sourceWithProbe, token) {
        settle(token, null);
        const frame = createIframe();

        const probeResult = new Promise<Rect | null>(resolve => {
          const listener = (event: MessageEvent) => {
            if (event.source !== frame.contentWindow) return;

            if (isReadyMessage(event.data)) {
              const pendingProbe = pendingRef.current.get(token);
              if (!pendingProbe) return;
              clearTimeout(pendingProbe.readyTimer);
              startProbe(token, pendingProbe);
              return;
            }

            const message = validateEnvelope<BridgeToParent>(event.data, nonce);
            if (!message || message.type !== 'probe-found') return;
            if (!isObject(message.payload) || message.payload.token !== token) return;
            settle(token, isRect(message.payload.rect) ? message.payload.rect : null);
          };

          const readyTimer = setTimeout(() => settle(token, null), 1000);
          pendingRef.current.set(token, {
            frame,
            resolve,
            listener,
            readyTimer,
            probeTimer: null,
          });
          window.addEventListener('message', listener);
        });

        frame.srcdoc = buildSrcDoc(sourceWithProbe, {
          bridgeSource: BRIDGE_SOURCE,
          storageSeed: getStorageSeed?.() ?? null,
        });
        return probeResult;
      },
      dispose() {
        for (const token of Array.from(pendingRef.current.keys())) settle(token, null);
      },
    };
  }, [getStorageSeed, getViewportSize, nonce]);

  useEffect(() => () => runner.dispose(), [runner]);

  return runner;
}

export function HtmlPreview({
  ytext,
  currentUser = 'Anonymous',
  origin,
  debounceMs = 300,
  isCommentMode = false,
  onPlaceComplete,
  onManualPlacement,
  probeRunner,
  readOnly = false,
  onDotClicked,
  onCommentAdded,
  onCommentsRendered,
  onScrollState,
  focusedCommentId,
  storageKey,
  onPageProblems,
}: HtmlPreviewProps) {
  const [content, setContent] = useState(() => ytext.toString());
  const [debounced, setDebounced] = useState(content);
  const [frames, setFrames] = useState<PreviewFrame[]>(() => [{
    id: 1,
    srcDoc: previewSrcDoc(content, storageKey),
    state: 'active',
  }]);
  const [pendingComment, setPendingComment] = useState<PendingPreviewComment | null>(null);
  const [pendingPlacementMenu, setPendingPlacementMenu] = useState<PendingPlacementMenu | null>(null);
  const placementMenuRef = useRef<HTMLDivElement | null>(null);
  const [placementError, setPlacementError] = useState<PlacementError | null>(null);
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
  const observedSourceRef = useRef(content);
  const mountedRef = useRef(true);
  const isCommentModeRef = useRef(isCommentMode);
  const readOnlyRef = useRef(readOnly);
  const placementGenerationRef = useRef(0);
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
  const pendingCommentsRenderedRef = useRef(new Map<number, CommentsRenderedPayload>());
  const diagnosticMarkerIndexRef = useRef(1);
  const getActiveIframe = useCallback(() => {
    return frameRefs.current.get(activeFrameIdRef.current) ?? null;
  }, []);
  const getProbeViewportSize = useCallback(() => {
    const iframe = getActiveIframe();
    return normalizeProbeViewportSize({
      width: iframe?.clientWidth ?? 0,
      height: iframe?.clientHeight ?? 0,
    });
  }, [getActiveIframe]);
  const getStorageSeed = useCallback(() => readPageStorage(storageKey), [storageKey]);
  const defaultProbeRunner = useHiddenProbeRunner(nonce, getProbeViewportSize, getStorageSeed);
  const activeProbeRunner = probeRunner ?? defaultProbeRunner;

  const postToFrame = useCallback((frameId: number, message: ParentToBridge): void => {
    postToBridge(frameRefs.current.get(frameId) ?? null, nonce, message);
  }, [nonce]);

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
    for (const frameId of Array.from(pendingCommentsRenderedRef.current.keys())) {
      if (!liveFrameIds.has(frameId)) pendingCommentsRenderedRef.current.delete(frameId);
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
      placementGenerationRef.current += 1;
      clearUiStateCaptureTimer();
    };
  }, [clearUiStateCaptureTimer]);

  useEffect(() => {
    isCommentModeRef.current = isCommentMode;
    placementGenerationRef.current += 1;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Comment-mode changes intentionally invalidate any in-progress composer before it can submit at a stale placement.
    setPendingComment(null);
    setPlacementError(null);
  }, [isCommentMode]);

  useEffect(() => {
    readOnlyRef.current = readOnly;
    if (readOnly) {
      placementGenerationRef.current += 1;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Entering read-only must synchronously remove UI that could mutate source.
      setPendingComment(null);
      setPendingPlacementMenu(null);
      setPlacementError(null);
    }
  }, [readOnly]);

  useEffect(() => {
    if (!pendingPlacementMenu) return;
    const dismiss = () => setPendingPlacementMenu(null);
    const handleMouseDown = (event: MouseEvent) => {
      const menu = placementMenuRef.current;
      if (menu && event.target instanceof Node && menu.contains(event.target)) return;
      dismiss();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [pendingPlacementMenu]);

  useEffect(() => {
    const sync = () => {
      const nextSource = ytext.toString();
      if (observedSourceRef.current !== nextSource) {
        observedSourceRef.current = nextSource;
        placementGenerationRef.current += 1;
        setPendingComment(null);
        setPendingPlacementMenu(null);
        setPlacementError(null);
      }
      setContent(nextSource);
    };
    sync();
    ytext.observe(sync);
    return () => ytext.unobserve(sync);
  }, [ytext]);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(content), debounceMs);
    return () => clearTimeout(handle);
  }, [content, debounceMs]);

  const comments = useMemo(() => summarizeComments(debounced), [debounced]);

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

  const openComposer = useCallback((
    position: number,
    point: PreviewPoint,
    scroll: PreviewScroll,
    source: string
  ) => {
    setPendingComment({ position, point, scroll, source });
  }, []);

  const resolvePlacementForAction = useCallback((
    fingerprint: Fingerprint,
    point: PreviewPoint,
    scroll: PreviewScroll,
    shouldStayCurrent: () => boolean,
    onResolved: (position: number, source: string) => void,
  ) => {
    const source = ytext.toString();
    const candidates = scoreCandidates(source, fingerprint);
    if (candidates.length === 1) {
      if (!shouldStayCurrent()) return;
      setPlacementError(null);
      onResolved(candidates[0].position, source);
      return;
    }

    void verifyByProbe(source, candidates, fingerprint, activeProbeRunner).then(result => {
      if (!shouldStayCurrent()) return;
      if (result.kind === 'placed') {
        setPlacementError(null);
        onResolved(result.position, source);
      } else {
        onManualPlacement?.(result.candidates);
        setPlacementError({
          point,
          message: "Couldn't find the matching source location. Try a shorter selection or place the marker closer to plain text.",
        });
      }
    }).catch(() => {
      if (!shouldStayCurrent()) return;
      setPlacementError({
        point,
        message: "Couldn't verify the source location. Try again near plain text.",
      });
    });
  }, [activeProbeRunner, onManualPlacement, ytext]);

  const handleCreateCommentFromMenu = useCallback(() => {
    if (!pendingPlacementMenu || readOnly) return;
    const placement = pendingPlacementMenu;
    setPendingPlacementMenu(null);
    setPlacementError(null);

    const generation = placementGenerationRef.current + 1;
    placementGenerationRef.current = generation;
    const isStillCurrent = () => (
      mountedRef.current
      && !readOnlyRef.current
      && placementGenerationRef.current === generation
      && placement.source === ytext.toString()
    );

    resolvePlacementForAction(
      placement.fingerprint,
      placement.point,
      placement.scroll,
      isStillCurrent,
      (position, source) => openComposer(position, placement.point, placement.scroll, source),
    );
  }, [openComposer, pendingPlacementMenu, readOnly, resolvePlacementForAction, ytext]);

  const handleAddMarkerFromMenu = useCallback(() => {
    if (!pendingPlacementMenu || readOnly) return;
    const placement = pendingPlacementMenu;
    setPendingPlacementMenu(null);
    setPlacementError(null);

    const generation = placementGenerationRef.current + 1;
    placementGenerationRef.current = generation;
    const isStillCurrent = () => (
      mountedRef.current
      && !readOnlyRef.current
      && placementGenerationRef.current === generation
      && placement.source === ytext.toString()
    );

    resolvePlacementForAction(
      placement.fingerprint,
      placement.point,
      placement.scroll,
      isStillCurrent,
      (position, source) => {
        if (source !== ytext.toString()) return;
        const marker = makeDiagnosticMarker(diagnosticMarkerIndexRef.current);
        diagnosticMarkerIndexRef.current += 1;
        ytext.insert(position, marker);
      },
    );
  }, [pendingPlacementMenu, readOnly, resolvePlacementForAction, ytext]);

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

  const postToAllFrames = useCallback((message: ParentToBridge): void => {
    for (const frame of framesRef.current) postToFrame(frame.id, message);
  }, [postToFrame]);

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

  const applyCommentsRendered = useCallback((payload: CommentsRenderedPayload): void => {
    onCommentsRendered?.(normalizeCommentsRendered(payload));
  }, [onCommentsRendered]);

  const activateRestoredFrame = useCallback((frameId: number): void => {
    restoringFrameIdRef.current = null;
    restoringScrollRef.current = null;
    postActivationRestoreRef.current = null;
    pendingUiStateRestoreRef.current = null;
    deferredRestoreFrameIdRef.current = null;
    const pendingCommentsRendered = pendingCommentsRenderedRef.current.get(frameId);
    if (pendingCommentsRendered) {
      pendingCommentsRenderedRef.current.delete(frameId);
      applyCommentsRendered(pendingCommentsRendered);
    }
    setFrames(currentFrames => {
      const target = currentFrames.find(frame => frame.id === frameId);
      if (!target) return currentFrames;
      return [{ ...target, state: 'active' }];
    });
  }, [applyCommentsRendered]);

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
    postToFrame(frame.id, {
      type: 'init',
      payload: { comments: summarizeComments(ytext.toString()) },
    });
    postToFrame(frame.id, {
      type: isCommentModeRef.current ? 'enable-click-to-place' : 'disable-click-to-place',
      payload: {},
    });
    if (frame.state === 'loading' && pendingUiStateCaptureRef.current) {
      deferredRestoreFrameIdRef.current = frame.id;
      return;
    }
    restoreFrameLayout(frame);
  }, [postToFrame, restoreFrameLayout, ytext]);

  useEffect(() => {
    function resolveCommentPlacement(
      fingerprint: Fingerprint,
      point: PreviewPoint,
      scroll: PreviewScroll,
      shouldStayCurrent: () => boolean
    ) {
      resolvePlacementForAction(
        fingerprint,
        point,
        scroll,
        shouldStayCurrent,
        (position, source) => openComposer(position, point, scroll, source),
      );
    }

    function handleClickCaptured(payload: unknown) {
      if (readOnly) return;
      if (!isCommentMode) return;
      if (!isObject(payload) || !isFingerprint(payload.fingerprint)) return;

      const generation = placementGenerationRef.current + 1;
      placementGenerationRef.current = generation;
      const isStillCurrent = () => (
        mountedRef.current
        && isCommentModeRef.current
        && !readOnlyRef.current
        && placementGenerationRef.current === generation
      );
      const fallbackPoint = { x: payload.fingerprint.clickRect.x, y: payload.fingerprint.clickRect.y };
      const fallbackScroll = { x: 0, y: 0 };

      resolveCommentPlacement(payload.fingerprint, fallbackPoint, fallbackScroll, isStillCurrent);
    }

    function handlePlacementRequested(payload: unknown) {
      if (readOnly) return;
      if (!isPlacementRequestPayload(payload)) return;

      placementGenerationRef.current += 1;
      setPendingComment(null);
      setPlacementError(null);
      setPendingPlacementMenu({
        fingerprint: payload.fingerprint,
        point: payload.point,
        scroll: payload.scroll,
        source: ytext.toString(),
      });
    }

    function handleMessage(message: BridgeToParent, frame: PreviewFrame) {
      if (message.type === 'scroll-state') {
        if (!isPreviewScrollState(message.payload)) return;
        const scrollPayload = normalizeScrollState(message.payload);
        if (frame.state === 'active') {
          lastKnownScrollRef.current = scrollPayload;
          onScrollState?.(scrollPayload);
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

      if (message.type === 'comments-rendered') {
        if (!isCommentsRenderedPayload(message.payload)) return;
        if (frame.state === 'active') {
          pendingCommentsRenderedRef.current.delete(frame.id);
          applyCommentsRendered(message.payload);
        } else {
          pendingCommentsRenderedRef.current.set(frame.id, message.payload);
        }
        return;
      }

      if (frame.state !== 'active') return;

      switch (message.type) {
        case 'dot-clicked':
          if (!isObject(message.payload) || typeof message.payload.id !== 'string') return;
          onDotClicked?.(message.payload.id);
          break;
        case 'click-captured':
          handleClickCaptured(message.payload);
          break;
        case 'placement-requested':
          handlePlacementRequested(message.payload);
          break;
        case 'probe-found':
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
    currentUser,
    activateRestoredFrame,
    applyCommentsRendered,
    clearUiStateCaptureTimer,
    findFrameIdByWindow,
    initializeFrame,
    isCommentMode,
    nonce,
    onDotClicked,
    onScrollState,
    origin,
    openComposer,
    readOnly,
    resolvePlacementForAction,
    restoreFrameLayout,
    settleRestoredFrame,
    storageKey,
    ytext,
  ]);

  useEffect(() => {
    postToAllFrames({
      type: 'set-comments',
      payload: { comments },
    });
  }, [comments, postToAllFrames]);

  useEffect(() => {
    postToAllFrames({
      type: isCommentMode ? 'enable-click-to-place' : 'disable-click-to-place',
      payload: {},
    });
  }, [isCommentMode, postToAllFrames]);

  useEffect(() => {
    postToAllFrames({
      type: 'set-focused-comment',
      payload: { id: focusedCommentId ?? null },
    });
  }, [focusedCommentId, postToAllFrames]);

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
      {pendingPlacementMenu && (
        <>
          <div
            aria-hidden="true"
            className="absolute inset-0"
            style={{ zIndex: 19 }}
            onMouseDown={() => setPendingPlacementMenu(null)}
          />
          <div
            ref={placementMenuRef}
            className="absolute min-w-40 rounded-md border border-gray-200 bg-white py-1 shadow-lg"
            style={{
              left: Math.max(8, pendingPlacementMenu.point.x),
              top: Math.max(8, pendingPlacementMenu.point.y),
              zIndex: 20,
            }}
          >
            <button
              type="button"
              className="block w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
              onClick={handleCreateCommentFromMenu}
            >
              Create comment
            </button>
            <button
              type="button"
              className="block w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
              onClick={handleAddMarkerFromMenu}
            >
              Add marker
            </button>
          </div>
        </>
      )}
      {placementError && (
        <div
          role="alert"
          className="absolute max-w-72 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 shadow"
          style={{
            left: Math.max(8, placementError.point.x),
            top: Math.max(8, placementError.point.y),
            zIndex: 20,
          }}
        >
          {placementError.message}
        </div>
      )}
      {pendingComment && (
        <NewCommentCard
          onSubmit={(body) => {
            if (readOnly) {
              setPendingComment(null);
              return;
            }
            if (pendingComment.source !== ytext.toString()) {
              setPendingComment(null);
              return;
            }
            const id = makeCommentId();
            pendingRestoreScrollRef.current = pendingComment.scroll;
            addComment(ytext, origin, {
              id,
              author: currentUser,
              ts: new Date().toISOString(),
              body,
              position: pendingComment.position,
            });
            setPendingComment(null);
            onCommentAdded?.(id);
            onPlaceComplete?.(id);
          }}
          onCancel={() => setPendingComment(null)}
          style={{
            position: 'absolute',
            left: Math.max(8, pendingComment.point.x),
            top: Math.max(8, pendingComment.point.y),
            width: 320,
            zIndex: 20,
          }}
        />
      )}
    </div>
  );
}
