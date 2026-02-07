// src/components/Editor/ContextMenu.test.tsx
/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ContextMenu } from './ContextMenu';
import type { ContextMenuItem } from './extensions/criticmarkup-context-menu';

describe('ContextMenu Component', () => {
  afterEach(() => {
    cleanup();
  });

  const mockItems: ContextMenuItem[] = [
    { label: 'Accept Change', action: vi.fn(), shortcut: 'Ctrl+Enter' },
    { label: 'Reject Change', action: vi.fn(), shortcut: 'Ctrl+Backspace' },
  ];

  it('renders menu items', () => {
    render(
      <ContextMenu
        items={mockItems}
        position={{ x: 100, y: 100 }}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText('Accept Change')).toBeInTheDocument();
    expect(screen.getByText('Reject Change')).toBeInTheDocument();
  });

  it('shows keyboard shortcuts', () => {
    render(
      <ContextMenu
        items={mockItems}
        position={{ x: 100, y: 100 }}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText('Ctrl+Enter')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+Backspace')).toBeInTheDocument();
  });

  it('calls action and onClose when item clicked', () => {
    const onClose = vi.fn();
    render(
      <ContextMenu
        items={mockItems}
        position={{ x: 100, y: 100 }}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByText('Accept Change'));

    expect(mockItems[0].action).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('is positioned at specified coordinates', () => {
    const { container } = render(
      <ContextMenu
        items={mockItems}
        position={{ x: 150, y: 200 }}
        onClose={vi.fn()}
      />
    );

    const menu = container.firstChild as HTMLElement;
    expect(menu.style.left).toBe('150px');
    expect(menu.style.top).toBe('200px');
  });

  it('does not render when items array is empty', () => {
    const { container } = render(
      <ContextMenu
        items={[]}
        position={{ x: 100, y: 100 }}
        onClose={vi.fn()}
      />
    );

    expect(container.firstChild).toBeNull();
  });
});
