import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { OrphanCommentAnchors } from './OrphanCommentAnchors';

describe('OrphanCommentAnchors', () => {
  it('emits one data-comment-from element per anchor', () => {
    const { container } = render(
      <OrphanCommentAnchors anchors={[{ absFrom: 110 }, { absFrom: 240 }]} />,
    );
    expect(container.querySelector('[data-comment-from="110"]')).toBeInTheDocument();
    expect(container.querySelector('[data-comment-from="240"]')).toBeInTheDocument();
  });

  it('renders nothing when given an empty list', () => {
    const { container } = render(<OrphanCommentAnchors anchors={[]} />);
    expect(container.querySelector('[data-comment-from]')).toBeNull();
  });

  it('shows the badge number as visible text when provided', () => {
    const { container } = render(
      <OrphanCommentAnchors anchors={[{ absFrom: 110, badgeNumber: 7 }]} />,
    );
    const badge = container.querySelector('[data-comment-from="110"]') as HTMLElement;
    expect(badge.textContent).toBe('7');
  });

  it('calls onCommentClick with the absolute offset when a badge is clicked', () => {
    const onCommentClick = vi.fn();
    const { container } = render(
      <OrphanCommentAnchors
        anchors={[{ absFrom: 110, badgeNumber: 1 }]}
        onCommentClick={onCommentClick}
      />,
    );
    const badge = container.querySelector('[data-comment-from="110"]') as HTMLElement;
    fireEvent.click(badge);
    expect(onCommentClick).toHaveBeenCalledWith(110);
  });
});
