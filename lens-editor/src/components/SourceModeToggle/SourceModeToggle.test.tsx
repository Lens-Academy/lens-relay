/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SourceModeChip, SourceModeToggle } from './SourceModeToggle';

describe('SourceModeToggle', () => {
  it('is a switch in the page menu, on in source mode', () => {
    const { rerender } = render(
      <SourceModeToggle editorView={null} isSourceMode={false} onSourceModeChange={vi.fn()} />
    );
    expect(screen.getByRole('menuitemcheckbox', { name: /Source mode/ })).toHaveAttribute('aria-checked', 'false');

    rerender(<SourceModeToggle editorView={null} isSourceMode onSourceModeChange={vi.fn()} />);
    expect(screen.getByRole('menuitemcheckbox', { name: /Source mode/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('has a chip for the top bar that leads back to the live preview', () => {
    render(<SourceModeChip editorView={null} onSourceModeChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Source/ })).toHaveAttribute('title', 'Back to the live preview');
  });
});
