/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HeaderActionsProvider, useHeaderActions, useHeaderCommentsControl } from './HeaderActionsContext';

function RegisteredCommentsControl({
  isOpen,
  onToggle,
}: {
  isOpen: boolean;
  onToggle: () => void;
}) {
  useHeaderCommentsControl({
    isOpen,
    onToggle,
    title: isOpen ? 'Hide comments' : 'Show comments',
  });
  return null;
}

function HeaderCommentsButton() {
  const { commentsControl } = useHeaderActions();
  return (
    <button type="button" onClick={commentsControl?.onToggle}>
      {commentsControl?.title ?? 'No comments control'}
    </button>
  );
}

describe('HeaderActionsContext', () => {
  it('lets the active editor register the global comments control', () => {
    const onToggle = vi.fn();
    render(
      <HeaderActionsProvider>
        <RegisteredCommentsControl isOpen={false} onToggle={onToggle} />
        <HeaderCommentsButton />
      </HeaderActionsProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show comments' }));

    expect(onToggle).toHaveBeenCalledOnce();
  });
});
