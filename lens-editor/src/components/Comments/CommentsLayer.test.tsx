import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import * as Y from 'yjs';
import { CommentsLayer } from './CommentsLayer';

function makeYDoc(initialText: string) {
  const doc = new Y.Doc();
  const yt = doc.getText('contents');
  yt.insert(0, initialText);
  return { doc, yt };
}

describe('CommentsLayer', () => {
  beforeEach(() => {
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  it('renders nothing when the Y.Text has no comments', () => {
    const { yt } = makeYDoc('Just plain prose.');
    const { container } = render(
      <CommentsLayer
        yText={yt}
        resolveAnchorY={() => 0}
        getViewportRect={() => ({ top: 0, height: 800 })}
        scrollContainerRef={{ current: null }}
        currentUserName="Bob"
      />,
    );
    expect(container.querySelectorAll('[data-thread-from]')).toHaveLength(0);
    expect(screen.getByText(/no comments yet/i)).toBeInTheDocument();
  });

  it('renders a card for each comment with the resolver-supplied y', async () => {
    const meta = JSON.stringify({ author: 'Alice', timestamp: 1700000000000 });
    const { yt } = makeYDoc(`Hello {>>{${meta}}@@first<<} world.`);

    const { container } = render(
      <CommentsLayer
        yText={yt}
        resolveAnchorY={(_offset) => 222}
        getViewportRect={() => ({ top: 0, height: 800 })}
        scrollContainerRef={{ current: null }}
        currentUserName="Bob"
      />,
    );

    const wrappers = container.querySelectorAll('[data-comment-thread]');
    expect(wrappers.length).toBe(1);
    expect((wrappers[0] as HTMLElement).style.top).toBe('222px');
  });
});
