import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { BRIDGE_SOURCE } from 'virtual:bridge-bundle';
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
type ProbeViewportSize = { width: number; height: number };
type ProbeViewportSizeGetter = () => ProbeViewportSize;
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
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [nonce] = useState(() => makeNonce());
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const observedSourceRef = useRef(content);
  const mountedRef = useRef(true);
  const isCommentModeRef = useRef(isCommentMode);
  const placementGenerationRef = useRef(0);
  const getProbeViewportSize = useCallback(() => {
    const iframe = iframeRef.current;
    return normalizeProbeViewportSize({
      width: iframe?.clientWidth ?? 0,
      height: iframe?.clientHeight ?? 0,
    });
  }, []);
  const defaultProbeRunner = useHiddenProbeRunner(nonce, getProbeViewportSize);
  const activeProbeRunner = probeRunner ?? defaultProbeRunner;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      placementGenerationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    isCommentModeRef.current = isCommentMode;
    if (!isCommentMode) placementGenerationRef.current += 1;
  }, [isCommentMode]);

  useEffect(() => {
    const sync = () => {
      const nextSource = ytext.toString();
      if (observedSourceRef.current !== nextSource) {
        observedSourceRef.current = nextSource;
        placementGenerationRef.current += 1;
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
  const srcDoc = useMemo(() => injectBridge(debounced), [debounced]);

  useEffect(() => {
    function placeAndOpen(position: number) {
      const id = makeCommentId();
      addComment(ytext, origin, {
        id,
        author: currentUser,
        ts: new Date().toISOString(),
        body: '',
        position,
      });
      setOpenThreadId(id);
      onPlaceComplete?.(id);
    }

    function handleClickCaptured(payload: unknown) {
      if (!isCommentMode) return;
      if (!isObject(payload) || !isFingerprint(payload.fingerprint)) return;

      const source = ytext.toString();
      const candidates = scoreCandidates(source, payload.fingerprint);
      if (candidates.length === 1) {
        placementGenerationRef.current += 1;
        placeAndOpen(candidates[0].position);
        return;
      }

      const generation = placementGenerationRef.current + 1;
      placementGenerationRef.current = generation;
      const isStillCurrent = () => (
        mountedRef.current
        && isCommentModeRef.current
        && placementGenerationRef.current === generation
      );

      void verifyByProbe(source, candidates, payload.fingerprint, activeProbeRunner).then(result => {
        if (!isStillCurrent()) return;
        if (result.kind === 'placed') {
          placeAndOpen(result.position);
        } else {
          onManualPlacement?.(result.candidates);
        }
      }).catch(() => {
        if (!isStillCurrent()) return;
      });
    }

    function handleMessage(message: BridgeToParent) {
      switch (message.type) {
        case 'dot-clicked':
          if (!isObject(message.payload) || typeof message.payload.id !== 'string') return;
          setOpenThreadId(message.payload.id);
          break;
        case 'comments-rendered':
          if (!isObject(message.payload) || !Array.isArray(message.payload.orphaned)) return;
          onOrphanedChange?.(message.payload.orphaned.filter((id): id is string => typeof id === 'string'));
          break;
        case 'click-captured':
          handleClickCaptured(message.payload);
          break;
        case 'probe-found':
          break;
        default:
          break;
      }
    }

    function onMessage(event: MessageEvent) {
      const iframe = iframeRef.current;
      if (!iframe || event.source !== iframe.contentWindow) return;

      if (isReadyMessage(event.data)) {
        postToBridge(iframe, nonce, {
          type: 'init',
          payload: { comments: summarizeComments(ytext.toString()) },
        });
        return;
      }

      const message = validateEnvelope<BridgeToParent>(event.data, nonce);
      if (!message || typeof message.type !== 'string') return;
      handleMessage(message);
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [
    activeProbeRunner,
    currentUser,
    isCommentMode,
    nonce,
    onManualPlacement,
    onOrphanedChange,
    onPlaceComplete,
    origin,
    ytext,
  ]);

  useEffect(() => {
    postToBridge(iframeRef.current, nonce, {
      type: 'set-comments',
      payload: { comments },
    });
  }, [comments, nonce]);

  useEffect(() => {
    postToBridge(iframeRef.current, nonce, {
      type: isCommentMode ? 'enable-click-to-place' : 'disable-click-to-place',
      payload: {},
    });
  }, [isCommentMode, nonce]);

  return (
    <div className="relative h-full w-full">
      <iframe
        ref={iframeRef}
        title="HTML preview"
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        className="w-full h-full border-0 bg-white"
      />
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
