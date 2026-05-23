/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TextRenderer } from './TextRenderer';

describe('TextRenderer', () => {
  it('opens the editor when an inline suggestion is clicked', () => {
    const onStartEdit = vi.fn();
    render(
      <TextRenderer
        content="Before {++added++} after."
        onStartEdit={onStartEdit}
        enableCriticMarkup
        onClickCriticRange={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText('added'));

    expect(onStartEdit).toHaveBeenCalledOnce();
  });

  it('does not open the editor when a comment anchor is clicked', () => {
    const onStartEdit = vi.fn();
    const onClickCriticRange = vi.fn();
    const { container } = render(
      <TextRenderer
        content="Before {>>note<<} after."
        onStartEdit={onStartEdit}
        enableCriticMarkup
        onClickCriticRange={onClickCriticRange}
      />
    );

    fireEvent.click(container.querySelector('.cm-comment-anchor')!);

    expect(onStartEdit).not.toHaveBeenCalled();
    expect(onClickCriticRange).toHaveBeenCalledOnce();
  });
});
