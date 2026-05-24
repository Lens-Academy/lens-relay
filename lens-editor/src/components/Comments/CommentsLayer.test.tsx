import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useRef } from 'react';
import * as Y from 'yjs';
import { CommentsLayer } from './CommentsLayer';

function makeYDoc(initialText: string) {
  const doc = new Y.Doc();
  const yt = doc.getText('contents');
  yt.insert(0, initialText);
  return { doc, yt };
}

// Renders CommentsLayer with a real scroll-container div so the layer's
// scroll/resize effect doesn't early-return (which would silently disable
// the layout pipeline). Tests can override `scrollTop`/`scrollHeight` on
// the element to exercise the edge-clamp.
function Harness(props: {
  yt: Y.Text;
  resolveAnchorY: (offset: number) => number | null;
  viewport?: { top: number; height: number };
}) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} style={{ height: 800 }}>
      <CommentsLayer
        yText={props.yt}
        resolveAnchorY={props.resolveAnchorY}
        getViewportRect={() => props.viewport ?? { top: 0, height: 800 }}
        scrollContainerRef={ref}
        currentUserName="Bob"
      />
    </div>
  );
}

describe('CommentsLayer', () => {
  beforeEach(() => {
    // Default no-op stub; individual tests can replace if they need callbacks.
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  it('renders the empty-state message when the Y.Text has no comments', () => {
    const { yt } = makeYDoc('Just plain prose.');
    const { container } = render(<Harness yt={yt} resolveAnchorY={() => 0} />);
    expect(container.querySelectorAll('[data-comment-thread]')).toHaveLength(0);
    expect(screen.getByText(/no comments yet/i)).toBeInTheDocument();
  });

  it('renders a card for each comment with the resolver-supplied y', () => {
    const meta = JSON.stringify({ author: 'Alice', timestamp: 1700000000000 });
    const { yt } = makeYDoc(`Hello {>>{${meta}}@@first<<} world.`);
    const { container } = render(<Harness yt={yt} resolveAnchorY={() => 222} />);

    const wrappers = container.querySelectorAll('[data-comment-thread]');
    expect(wrappers.length).toBe(1);
    // Layer fills its parent (top:0 in viewport), so layoutY=222 → top=222px.
    expect((wrappers[0] as HTMLElement).style.top).toBe('222px');
  });
});
