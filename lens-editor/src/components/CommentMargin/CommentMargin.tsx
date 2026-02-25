import { useState, useEffect, useRef, useCallback } from 'react';
import type { EditorView } from '@codemirror/view';
import { useComments } from '../CommentsPanel/useComments';
import { CommentCard } from './CommentCard';
import { NewCommentCard } from './NewCommentCard';
import { insertCommentAt, scrollToPosition } from '../../lib/comment-utils';
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
  const [focusedThreadFrom, setFocusedThreadFrom] = useState<number | null>(null);
  const [showNewComment, setShowNewComment] = useState(false);
  const [newCommentY, setNewCommentY] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const cardHeightsRef = useRef<Map<number, number>>(new Map());
  const prevTriggerRef = useRef(addCommentTrigger);

  // Trigger re-render (stateVersion changes handled by parent)
  void stateVersion;

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

  // Measure card heights via ref callbacks
  const measureCard = useCallback((threadFrom: number, el: HTMLDivElement | null) => {
    if (el) {
      const height = el.getBoundingClientRect().height;
      if (height > 0) {
        cardHeightsRef.current.set(threadFrom, height);
      }
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
              onFocus={() => setFocusedThreadFrom(thread.from)}
              onReply={(content) => handleReply(thread.to, content)}
              onScrollToComment={() => scrollToPosition(view, thread.comments[0].contentFrom)}
              style={{ position: 'absolute', top: layoutY, width: '100%' }}
            />
          );
        })}

        {showNewComment && (
          <NewCommentCard
            onSubmit={handleNewCommentSubmit}
            onCancel={() => setShowNewComment(false)}
            style={{ position: 'absolute', top: newCommentY, width: '100%' }}
          />
        )}
      </div>
    </div>
  );
}
