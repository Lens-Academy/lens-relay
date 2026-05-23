import { useEffect, useMemo, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { BRIDGE_SOURCE } from 'virtual:bridge-bundle';
import { CommentThread } from './CommentThread';
import { parseComments } from './comment-store';
import {
  makeNonce,
  validateEnvelope,
  type BridgeToParent,
  type CommentSummary,
  type Envelope,
  type ParentToBridge,
} from './bridge/protocol';

interface HtmlPreviewProps {
  ytext: Y.Text;
  currentUser?: string;
  origin?: unknown;
  debounceMs?: number;
  onOrphanedChange?: (orphanedIds: string[]) => void;
}

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

function injectBridge(source: string): string {
  const script = `<script>${BRIDGE_SOURCE}</script>`;
  const headMatch = /<head\b[^>]*>/i.exec(source);
  if (!headMatch || headMatch.index === undefined) {
    return `${script}\n${source}`;
  }

  const insertAt = headMatch.index + headMatch[0].length;
  return `${source.slice(0, insertAt)}${script}${source.slice(insertAt)}`;
}

export function HtmlPreview({
  ytext,
  currentUser = 'Anonymous',
  origin,
  debounceMs = 300,
  onOrphanedChange,
}: HtmlPreviewProps) {
  const [content, setContent] = useState(() => ytext.toString());
  const [debounced, setDebounced] = useState(content);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [nonce] = useState(() => makeNonce());
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

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

  const comments = useMemo(() => summarizeComments(debounced), [debounced]);
  const srcDoc = useMemo(() => injectBridge(debounced), [debounced]);

  useEffect(() => {
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
  }, [nonce, onOrphanedChange, ytext]);

  useEffect(() => {
    postToBridge(iframeRef.current, nonce, {
      type: 'set-comments',
      payload: { comments },
    });
  }, [comments, nonce]);

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
            onClose={() => setOpenThreadId(null)}
          />
        </div>
      )}
    </div>
  );
}
