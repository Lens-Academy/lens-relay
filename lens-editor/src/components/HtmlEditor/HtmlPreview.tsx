import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { BRIDGE_SOURCE } from 'virtual:bridge-bundle';
import { NewCommentCard } from '../CommentMargin/NewCommentCard';
import { CommentThread } from './CommentThread';
import { addComment, parseComments } from './comment-store';
import { scoreCandidates, verifyByProbe, type Candidate, type ProbeRunner } from './position-finder';
import {
  makeNonce,
  validateEnvelope,
  type BridgeToParent,
  type CommentSummary,
  type Envelope,
  type Fingerprint,
  type ParentToBridge,
  type PreviewScrollState,
} from './bridge/protocol';

interface HtmlPreviewProps {
  ytext: Y.Text;
  currentUser?: string;
  origin?: unknown;
  debounceMs?: number;
  onOrphanedChange?: (orphanedIds: string[]) => void;
  isCommentMode?: boolean;
  onPlaceComplete?: (commentId: string) => void;
  onManualPlacement?: (candidates: Candidate[]) => void;
  probeRunner?: ProbeRunner;
  readOnly?: boolean;
}

type Rect = { x: number; y: number; w: number; h: number };
type PreviewPoint = { x: number; y: number };
type PreviewScroll = { x: number; y: number };
type PreviewPlacementTrigger = 'contextmenu' | 'selection' | 'toolbar';
type ProbeViewportSize = { width: number; height: number };
type ProbeViewportSizeGetter = () => ProbeViewportSize;
type CommentsRenderedPayload = { found: string[]; orphaned: string[] };
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
  return parseComments(source).map(cluster => ({
    id: cluster.comment.id,
    body: cluster.comment.body,
    replies: cluster.replies.length,
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
  return isObject(value)
    && typeof value.x === 'number'
    && typeof value.y === 'number'
    && typeof value.scrollWidth === 'number'
    && typeof value.clientWidth === 'number'
    && typeof value.scrollHeight === 'number'
    && typeof value.clientHeight === 'number';
}

function isPlacementTrigger(value: unknown): value is PreviewPlacementTrigger {
  return value === 'contextmenu' || value === 'selection' || value === 'toolbar';
}

function isCommentsRenderedPayload(value: unknown): value is CommentsRenderedPayload {
  return isObject(value)
    && Array.isArray(value.found)
    && Array.isArray(value.orphaned);
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

function injectBridge(source: string): string {
  const script = `<script>${BRIDGE_SOURCE}</script>`;
  const headMatch = /<head\b[^>]*>/i.exec(source);
  if (!headMatch || headMatch.index === undefined) {
    return `${script}\n${source}`;
  }

  const insertAt = headMatch.index + headMatch[0].length;
  return `${source.slice(0, insertAt)}${script}${source.slice(insertAt)}`;
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

        frame.srcdoc = `<script>${BRIDGE_SOURCE}</script>${sourceWithProbe}`;
        return probeResult;
      },
      dispose() {
        for (const token of Array.from(pendingRef.current.keys())) settle(token, null);
      },
    };
  }, [getViewportSize, nonce]);

  useEffect(() => () => runner.dispose(), [runner]);

  return runner;
}

export function HtmlPreview({
  ytext,
  currentUser = 'Anonymous',
  origin,
  debounceMs = 300,
  onOrphanedChange,
  isCommentMode = false,
  onPlaceComplete,
  onManualPlacement,
  probeRunner,
  readOnly = false,
}: HtmlPreviewProps) {
  const [content, setContent] = useState(() => ytext.toString());
  const [debounced, setDebounced] = useState(content);
  const [frames, setFrames] = useState<PreviewFrame[]>(() => [{
    id: 1,
    srcDoc: injectBridge(content),
    state: 'active',
  }]);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [pendingComment, setPendingComment] = useState<PendingPreviewComment | null>(null);
  const [pendingPlacementMenu, setPendingPlacementMenu] = useState<PendingPlacementMenu | null>(null);
  const [nonce] = useState(() => makeNonce());
  const frameRefs = useRef(new Map<number, HTMLIFrameElement>());
  const nextFrameIdRef = useRef(2);
  const framesRef = useRef(frames);
  const activeFrameIdRef = useRef(1);
  const observedSourceRef = useRef(content);
  const mountedRef = useRef(true);
  const isCommentModeRef = useRef(isCommentMode);
  const readOnlyRef = useRef(readOnly);
  const placementGenerationRef = useRef(0);
  const pendingRestoreScrollRef = useRef<PreviewScroll | null>(null);
  const lastKnownScrollRef = useRef<PreviewScrollState>({
    x: 0,
    y: 0,
    scrollWidth: 0,
    clientWidth: 0,
    scrollHeight: 0,
    clientHeight: 0,
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
  const defaultProbeRunner = useHiddenProbeRunner(nonce, getProbeViewportSize);
  const activeProbeRunner = probeRunner ?? defaultProbeRunner;

  useEffect(() => {
    framesRef.current = frames;
    activeFrameIdRef.current = frames.find(frame => frame.state === 'active')?.id ?? frames[0]?.id ?? 1;
    const liveFrameIds = new Set(frames.map(frame => frame.id));
    for (const frameId of Array.from(pendingCommentsRenderedRef.current.keys())) {
      if (!liveFrameIds.has(frameId)) pendingCommentsRenderedRef.current.delete(frameId);
    }
  }, [frames]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      placementGenerationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    isCommentModeRef.current = isCommentMode;
    placementGenerationRef.current += 1;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Comment-mode changes intentionally invalidate any in-progress composer before it can submit at a stale placement.
    setPendingComment(null);
  }, [isCommentMode]);

  useEffect(() => {
    readOnlyRef.current = readOnly;
    if (readOnly) {
      placementGenerationRef.current += 1;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Entering read-only must synchronously remove UI that could mutate source.
      setPendingComment(null);
      setPendingPlacementMenu(null);
    }
  }, [readOnly]);

  useEffect(() => {
    const sync = () => {
      const nextSource = ytext.toString();
      if (observedSourceRef.current !== nextSource) {
        observedSourceRef.current = nextSource;
        placementGenerationRef.current += 1;
        setPendingComment(null);
        setPendingPlacementMenu(null);
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
    const nextSrcDoc = injectBridge(debounced);
    setFrames(currentFrames => {
      const activeFrame = currentFrames.find(frame => frame.state === 'active') ?? currentFrames[0];
      if (activeFrame?.srcDoc === nextSrcDoc) {
        restoringFrameIdRef.current = null;
        restoringScrollRef.current = null;
        postActivationRestoreRef.current = null;
        pendingRestoreScrollRef.current = null;
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
  }, [debounced]);

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
      onResolved(candidates[0].position, source);
      return;
    }

    void verifyByProbe(source, candidates, fingerprint, activeProbeRunner).then(result => {
      if (!shouldStayCurrent()) return;
      if (result.kind === 'placed') {
        onResolved(result.position, source);
      } else {
        onManualPlacement?.(result.candidates);
      }
    }).catch(() => {
      if (!shouldStayCurrent()) return;
    });
  }, [activeProbeRunner, onManualPlacement, ytext]);

  const handleCreateCommentFromMenu = useCallback(() => {
    if (!pendingPlacementMenu || readOnly) return;
    const placement = pendingPlacementMenu;
    setPendingPlacementMenu(null);

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

  const postToFrame = useCallback((frameId: number, message: ParentToBridge): void => {
    postToBridge(frameRefs.current.get(frameId) ?? null, nonce, message);
  }, [nonce]);

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

  const applyCommentsRendered = useCallback((payload: CommentsRenderedPayload): void => {
    onOrphanedChange?.(payload.orphaned.filter((id): id is string => typeof id === 'string'));
  }, [onOrphanedChange]);

  const activateRestoredFrame = useCallback((frameId: number): void => {
    restoringFrameIdRef.current = null;
    restoringScrollRef.current = null;
    postActivationRestoreRef.current = null;
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
  }, [postToFrame, ytext]);

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
        if (frame.state === 'active') {
          lastKnownScrollRef.current = message.payload;
        }
        if (restoringFrameIdRef.current === frame.id) {
          const intended = restoringScrollRef.current?.frameId === frame.id
            ? restoringScrollRef.current.scroll
            : { x: lastKnownScrollRef.current.x, y: lastKnownScrollRef.current.y };
          if (isCloseScroll(message.payload, intended)) activateRestoredFrame(frame.id);
          else settleRestoredFrame(frame.id);
        } else if (frame.state === 'settling') {
          const intended = restoringScrollRef.current?.frameId === frame.id
            ? restoringScrollRef.current.scroll
            : { x: lastKnownScrollRef.current.x, y: lastKnownScrollRef.current.y };
          if (isClampedCloseScroll(message.payload, intended)) activateRestoredFrame(frame.id);
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
          setOpenThreadId(message.payload.id);
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
    findFrameIdByWindow,
    initializeFrame,
    isCommentMode,
    nonce,
    onOrphanedChange,
    origin,
    openComposer,
    readOnly,
    resolvePlacementForAction,
    settleRestoredFrame,
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
          sandbox="allow-scripts"
          srcDoc={frame.srcDoc}
          data-preview-frame-state={frame.state}
          className={[
            'absolute inset-0 h-full w-full border-0 bg-white',
            frame.state === 'loading' || frame.state === 'settling' ? 'pointer-events-none opacity-0' : '',
          ].join(' ')}
        />
      ))}
      {pendingPlacementMenu && (
        <div
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
            setOpenThreadId(id);
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
      {openThreadId && (
        <div className="absolute right-4 top-4 z-10">
          <CommentThread
            ytext={ytext}
            origin={origin}
            threadId={openThreadId}
            currentUser={currentUser}
            readOnly={readOnly}
            onClose={() => setOpenThreadId(null)}
          />
        </div>
      )}
    </div>
  );
}
