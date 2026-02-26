/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { CommentMargin } from './CommentMargin';
import { createCriticMarkupEditor } from '../../test/codemirror-helpers';
import type { PositionMapper } from '../../lib/comment-layout';

describe('CommentMargin', () => {
  let editorCleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup();
    if (editorCleanup) editorCleanup();
  });

  const syntheticMapper: PositionMapper = (pos) => pos * 20;

  it('renders nothing when no comments', () => {
    const { view, cleanup: c } = createCriticMarkupEditor('hello world', 0);
    editorCleanup = c;

    const { container } = render(
      <CommentMargin
        view={view}
        stateVersion={1}
        positionMapper={syntheticMapper}
      />
    );

    const cards = container.querySelectorAll('.comment-card');
    expect(cards.length).toBe(0);
  });

  it('renders a card for each comment thread', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello {>>first<<} middle {>>second<<} end',
      0
    );
    editorCleanup = c;

    const { container } = render(
      <CommentMargin
        view={view}
        stateVersion={1}
        positionMapper={syntheticMapper}
      />
    );

    const cards = container.querySelectorAll('.comment-card');
    expect(cards.length).toBe(2);
  });

  it('positions cards absolutely with top set from layout', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello {>>comment<<} end',
      0
    );
    editorCleanup = c;

    const { container } = render(
      <CommentMargin
        view={view}
        stateVersion={1}
        positionMapper={syntheticMapper}
      />
    );

    const card = container.querySelector('.comment-card') as HTMLElement;
    expect(card).not.toBeNull();
    // Card should have position absolute with top style
    expect(card.style.position).toBe('absolute');
    // targetY = 6 * 20 = 120 (thread.from = 6)
    expect(card.style.top).toBe('120px');
  });

  it('renders single card for adjacent comments (thread)', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello {>>root<<}{>>reply<<} end',
      0
    );
    editorCleanup = c;

    const { container } = render(
      <CommentMargin
        view={view}
        stateVersion={1}
        positionMapper={syntheticMapper}
      />
    );

    const cards = container.querySelectorAll('.comment-card');
    expect(cards.length).toBe(1);
  });

  it('displays comment content in cards', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'text {>>my note<<} more',
      0
    );
    editorCleanup = c;

    const { container } = render(
      <CommentMargin
        view={view}
        stateVersion={1}
        positionMapper={syntheticMapper}
      />
    );

    expect(container.textContent).toContain('my note');
  });

  it('shows new comment card when addCommentTrigger increments', () => {
    const { view, cleanup: c } = createCriticMarkupEditor('hello world', 5);
    editorCleanup = c;

    const { container, rerender } = render(
      <CommentMargin
        view={view}
        stateVersion={1}
        positionMapper={syntheticMapper}
        addCommentTrigger={0}
      />
    );

    // No new comment card initially
    expect(container.querySelector('.comment-card-new')).toBeNull();

    // Trigger add comment
    rerender(
      <CommentMargin
        view={view}
        stateVersion={1}
        positionMapper={syntheticMapper}
        addCommentTrigger={1}
      />
    );

    expect(container.querySelector('.comment-card-new')).not.toBeNull();
  });

  it('has outer container with overflow hidden', () => {
    const { view, cleanup: c } = createCriticMarkupEditor('hello', 0);
    editorCleanup = c;

    const { container } = render(
      <CommentMargin
        view={view}
        stateVersion={1}
        positionMapper={syntheticMapper}
      />
    );

    const outer = container.querySelector('.comment-margin');
    expect(outer).not.toBeNull();
    expect((outer as HTMLElement).style.overflow).toBe('hidden');
  });
});
