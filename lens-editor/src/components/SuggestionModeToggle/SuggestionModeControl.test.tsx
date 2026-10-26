/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AuthProvider } from '../../contexts/AuthContext';
import { SuggestionModeControl } from './SuggestionModeControl';

function renderWithRole(role: 'edit' | 'suggest' | 'view', ui: React.ReactNode) {
  return render(
    <AuthProvider role={role} folderUuid={null} isAllFolders>
      {ui}
    </AuthProvider>
  );
}

describe('SuggestionModeControl', () => {
  it('shows the mode, and switches it from its menu, for edit users', () => {
    const onChange = vi.fn();
    renderWithRole('edit', (
      <SuggestionModeControl
        isSuggestionMode={false}
        onChange={onChange}
      />
    ));

    fireEvent.click(screen.getByRole('button', { name: 'Mode: Editing' }));
    expect(screen.getByRole('menuitemradio', { name: /Editing/ })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Suggesting/ }));

    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('renders the shared locked suggest badge for suggest-only users', () => {
    renderWithRole('suggest', (
      <SuggestionModeControl
        isSuggestionMode
        onChange={vi.fn()}
      />
    ));

    expect(screen.getByTitle('Suggest + Comment Only')).toHaveTextContent('Suggesting');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders the shared locked read-only badge for view-only users', () => {
    renderWithRole('view', (
      <SuggestionModeControl
        isSuggestionMode={false}
        onChange={vi.fn()}
      />
    ));

    expect(screen.getByTitle('Read-Only')).toHaveTextContent('Viewing');
  });
});
