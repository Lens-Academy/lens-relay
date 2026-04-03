import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SourceSuggestionBanner } from './SourceSuggestionBanner';
import { AuthProvider } from '../../contexts/AuthContext';

function renderBanner(role: 'edit' | 'suggest' | 'view', handlers = { onSwitchToPreview: vi.fn(), onSwitchToEditing: vi.fn() }) {
  return render(
    <AuthProvider role={role} folderUuid={null} isAllFolders={true}>
      <SourceSuggestionBanner {...handlers} />
    </AuthProvider>
  );
}

describe('SourceSuggestionBanner', () => {
  it('shows Live Preview button for all roles', () => {
    renderBanner('suggest');
    expect(screen.getByText('Live Preview')).toBeInTheDocument();
  });

  it('shows Switch to Editing button for edit role', () => {
    renderBanner('edit');
    expect(screen.getByText('Switch to Editing')).toBeInTheDocument();
  });

  it('does NOT show Switch to Editing button for suggest role', () => {
    renderBanner('suggest');
    expect(screen.queryByText('Switch to Editing')).not.toBeInTheDocument();
  });

  it('calls onSwitchToPreview when Live Preview clicked', async () => {
    const handlers = { onSwitchToPreview: vi.fn(), onSwitchToEditing: vi.fn() };
    renderBanner('edit', handlers);
    await userEvent.click(screen.getByText('Live Preview'));
    expect(handlers.onSwitchToPreview).toHaveBeenCalledOnce();
  });

  it('calls onSwitchToEditing when Switch to Editing clicked', async () => {
    const handlers = { onSwitchToPreview: vi.fn(), onSwitchToEditing: vi.fn() };
    renderBanner('edit', handlers);
    await userEvent.click(screen.getByText('Switch to Editing'));
    expect(handlers.onSwitchToEditing).toHaveBeenCalledOnce();
  });
});
