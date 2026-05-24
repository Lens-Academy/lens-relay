import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { OrphanCommentAnchors } from './OrphanCommentAnchors';

describe('OrphanCommentAnchors', () => {
  it('emits one data-comment-from anchor per offset', () => {
    const { container } = render(<OrphanCommentAnchors offsets={[110, 240]} />);
    expect(container.querySelector('[data-comment-from="110"]')).toBeInTheDocument();
    expect(container.querySelector('[data-comment-from="240"]')).toBeInTheDocument();
  });

  it('emits nothing when given an empty list', () => {
    const { container } = render(<OrphanCommentAnchors offsets={[]} />);
    expect(container.querySelector('[data-comment-from]')).toBeNull();
  });
});
