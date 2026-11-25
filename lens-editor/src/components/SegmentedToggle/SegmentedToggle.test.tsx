// src/components/SegmentedToggle/SegmentedToggle.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SegmentedToggle } from './SegmentedToggle';

describe('SegmentedToggle', () => {
  const defaultProps = {
    leftLabel: 'Left',
    rightLabel: 'Right',
    value: 'left' as const,
    onChange: vi.fn(),
  };

  it('renders both labels', () => {
    render(<SegmentedToggle {...defaultProps} />);

    expect(screen.getByText('Left')).toBeInTheDocument();
    expect(screen.getByText('Right')).toBeInTheDocument();
  });

  it('highlights the left option when value is left', () => {
    render(<SegmentedToggle {...defaultProps} value="left" />);

    const leftButton = screen.getByText('Left').closest('button');
    const rightButton = screen.getByText('Right').closest('button');

    expect(leftButton).toHaveAttribute('aria-pressed', 'true');
    expect(leftButton).toHaveClass('is-active');
    expect(rightButton).toHaveAttribute('aria-pressed', 'false');
    expect(rightButton).not.toHaveClass('is-active');
  });

  it('highlights the right option when value is right', () => {
    render(<SegmentedToggle {...defaultProps} value="right" />);

    const leftButton = screen.getByText('Left').closest('button');
    const rightButton = screen.getByText('Right').closest('button');

    expect(rightButton).toHaveAttribute('aria-pressed', 'true');
    expect(rightButton).toHaveClass('is-active');
    expect(leftButton).toHaveAttribute('aria-pressed', 'false');
    expect(leftButton).not.toHaveClass('is-active');
  });

  it('calls onChange with "right" when clicking right option', async () => {
    const onChange = vi.fn();
    render(<SegmentedToggle {...defaultProps} value="left" onChange={onChange} />);

    await userEvent.click(screen.getByText('Right'));

    expect(onChange).toHaveBeenCalledWith('right');
  });

  it('calls onChange with "left" when clicking left option', async () => {
    const onChange = vi.fn();
    render(<SegmentedToggle {...defaultProps} value="right" onChange={onChange} />);

    await userEvent.click(screen.getByText('Left'));

    expect(onChange).toHaveBeenCalledWith('left');
  });

  it('does not call onChange when clicking the already-selected option', async () => {
    const onChange = vi.fn();
    render(<SegmentedToggle {...defaultProps} value="left" onChange={onChange} />);

    await userEvent.click(screen.getByText('Left'));

    expect(onChange).not.toHaveBeenCalled();
  });

  it('is disabled when disabled prop is true', () => {
    render(<SegmentedToggle {...defaultProps} disabled />);

    const leftButton = screen.getByText('Left').closest('button');
    const rightButton = screen.getByText('Right').closest('button');

    expect(leftButton).toBeDisabled();
    expect(rightButton).toBeDisabled();
  });

  it('renders with aria-label when provided', () => {
    render(<SegmentedToggle {...defaultProps} ariaLabel="Toggle mode" />);

    expect(screen.getByRole('group')).toHaveAttribute('aria-label', 'Toggle mode');
  });
});
