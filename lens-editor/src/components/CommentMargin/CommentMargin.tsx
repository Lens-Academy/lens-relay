import { useState, useEffect, useRef, useCallback } from 'react';
import type { EditorView } from '@codemirror/view';
import { useComments } from '../CommentsPanel/useComments';
import { CommentCard } from './CommentCard';
import { NewCommentCard } from './NewCommentCard';
import { insertCommentAt, scrollToPosition } from '../../lib/comment-utils';
import { focusedThreadField, focusCommentThread } from '../Editor/extensions/criticmarkup';
import {
  resolveOverlaps,
  computeSharedHeight,
  mapThreadPositions,
  type PositionMapper,
  type LayoutItem,
} from '../../lib/comment-layout';

interface CommentMarginProps {
  view: EditorView;
  stateVersion: number;
  addCommentTrigger?: number;
  positionMapper?: PositionMapper;
}

const DEFAULT_CARD_HEIGHT = 80;
const CARD_GAP = 4;

export function CommentMargin({
  view,
  stateVersion,
  addCommentTrigger = 0,
  positionMapper,
}: CommentMarginProps) {
  const mapper: PositionMapper = positionMapper ?? ((pos) => view.lineBlockAt(pos).top);

  const threads = useComments(view);
  const focusedThreadFrom = view.state.field(focusedThreadField);
  const [showNewComment, setShowNewComment] = useState(false);
  const [newCommentY, setNewCommentY] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const cardHeightsRef = useRef<Map<number, number>>(new Map());
  const cardElsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const observerRef = useRef<ResizeObserver | null>(null);
  const [cardHeightsVersion, setCardHeightsVersion] = useState(0);
  const prevTriggerRef = useRef(addCommentTrigger);

  // Trigger re-render (stateVersion and cardHeightsVersion changes)
  void stateVersion;
  void cardHeightsVersion;

  // Show new comment card when trigger increments
  useEffect(() => {
    if (addCommentTrigger > prevTriggerRef.current) {
      const cursorPos = view.state.selection.main.head;
      setNewCommentY(mapper(cursorPos));
      setShowNewComment(true);
    }
    prevTriggerRef.current = addCommentTrigger;
  }, [addCommentTrigger, view, mapper]);

  // Scroll sync: mirror editor's scrollTop
  useEffect(() => {
    const scrollDOM = view.scrollDOM;
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      container.scrollTop = scrollDOM.scrollTop;
    };

    scrollDOM.addEventListener('scroll', handleScroll);
    // Sync initial position
    container.scrollTop = scrollDOM.scrollTop;

    return () => {
      scrollDOM.removeEventListener('scroll', handleScroll);
    };
  }, [view]);

  // Map threads to positions
  const mappedThreads = mapThreadPositions(threads, mapper);

  // Build layout items with measured or estimated heights
  const layoutItems: LayoutItem[] = mappedThreads.map(({ thread }) => ({
    targetY: mapper(thread.from),
    height: cardHeightsRef.current.get(thread.from) ?? DEFAULT_CARD_HEIGHT,
  }));

  const layoutResults = resolveOverlaps(layoutItems, CARD_GAP);

  // Compute shared height
  const lastBottom = layoutResults.length > 0
    ? layoutResults[layoutResults.length - 1].layoutY + (layoutItems[layoutItems.length - 1]?.height ?? 0)
    : 0;
  const editorScrollHeight = view.scrollDOM.scrollHeight;
  const sharedHeight = computeSharedHeight(editorScrollHeight, lastBottom);

  // ResizeObserver to track card height changes (replies, form open/close)
  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const el = entry.target as HTMLDivElement;
        const threadFrom = Number(el.dataset.threadFrom);
        if (isNaN(threadFrom)) continue;
        const newHeight = el.getBoundingClientRect().height;
        if (newHeight > 0 && cardHeightsRef.current.get(threadFrom) !== newHeight) {
          cardHeightsRef.current.set(threadFrom, newHeight);
          changed = true;
        }
      }
      if (changed) setCardHeightsVersion(v => v + 1);
    });
    observerRef.current = observer;
    return () => observer.disconnect();
  }, []);

  // Ref callback: observe/unobserve card elements for resize tracking
  const measureCard = useCallback((threadFrom: number, el: HTMLDivElement | null) => {
    const observer = observerRef.current;
    if (!observer) return;
    const prev = cardElsRef.current.get(threadFrom);
    if (prev && prev !== el) {
      observer.unobserve(prev);
      cardElsRef.current.delete(threadFrom);
    }
    if (el) {
      el.dataset.threadFrom = String(threadFrom);
      observer.observe(el);
      cardElsRef.current.set(threadFrom, el);
    }
  }, []);

  const handleNewCommentSubmit = (content: string) => {
    const cursorPos = view.state.selection.main.head;
    insertCommentAt(view, content, cursorPos);
    setShowNewComment(false);
  };

  const handleReply = (threadTo: number, content: string) => {
    insertCommentAt(view, content, threadTo);
  };

  return (
    <div
      className="comment-margin h-full"
      ref={containerRef}
      style={{ overflow: 'hidden', position: 'relative' }}
    >
      <div
        ref={innerRef}
        style={{ height: sharedHeight, position: 'relative' }}
      >
        {mappedThreads.map(({ thread, badgeNumber }, index) => {
          const layoutY = layoutResults[index]?.layoutY ?? 0;
          return (
            <CommentCard
              key={`thread-${thread.from}`}
              ref={(el) => measureCard(thread.from, el)}
              thread={thread}
              badgeNumber={badgeNumber}
              focused={focusedThreadFrom === thread.from}
              onFocus={() => {
                const current = view.state.field(focusedThreadField);
                view.dispatch({ effects: focusCommentThread.of(current === thread.from ? null : thread.from) });
              }}
              onReply={(content) => handleReply(thread.to, content)}
              onScrollToComment={() => scrollToPosition(view, thread.comments[0].contentFrom)}
              style={{ position: 'absolute', top: layoutY, left: 6, right: 6 }}
            />
          );
        })}

        {showNewComment && (
          <NewCommentCard
            onSubmit={handleNewCommentSubmit}
            onCancel={() => setShowNewComment(false)}
            style={{ position: 'absolute', top: newCommentY, left: 6, right: 6 }}
          />
        )}
      </div>
    </div>
  );
}
