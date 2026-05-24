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
  it('renders the shared editing/suggesting segmented control for edit users', () => {
    const onChange = vi.fn();
    renderWithRole('edit', (
      <SuggestionModeControl
        isSuggestionMode={false}
        onChange={onChange}
      />
    ));

    fireEvent.click(screen.getByRole('button', { name: 'Suggesting' }));

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('renders the shared locked suggest badge for suggest-only users', () => {
    renderWithRole('suggest', (
      <SuggestionModeControl
        isSuggestionMode
        onChange={vi.fn()}
      />
    ));

    expect(screen.getByTitle('Suggest + Comment Only')).toHaveTextContent('Suggest + Comment Only');
  });

  it('renders the shared locked read-only badge for view-only users', () => {
    renderWithRole('view', (
      <SuggestionModeControl
        isSuggestionMode={false}
        onChange={vi.fn()}
      />
    ));

    expect(screen.getByTitle('Read-Only')).toHaveTextContent('Read-Only');
  });
});
