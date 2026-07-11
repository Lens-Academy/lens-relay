import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AuthProvider, type UserRole } from '../../contexts/AuthContext';
import { PromotionRoute } from './PromotionRoute';

vi.mock('./PromotionPage', () => ({
  PromotionPage: () => <div data-testid="promotion-page" />,
}));

function renderRoute(role: UserRole, folderUuid: string | null, isAllFolders: boolean) {
  return render(
    <MemoryRouter>
      <AuthProvider role={role} folderUuid={folderUuid} isAllFolders={isAllFolders}>
        <PromotionRoute />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('PromotionRoute', () => {
  it('explains that an edit user needs an admin token', () => {
    renderRoute('edit', null, true);

    expect(screen.getByRole('heading', { name: 'Admin access required' })).toBeInTheDocument();
    expect(screen.getByText('You need an admin access token to use production promotion.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Return to editor' })).toHaveAttribute('href', '/');
  });

  it('rejects an admin token scoped outside Lens Edu', () => {
    renderRoute('admin', 'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e', false);

    expect(screen.getByRole('heading', { name: 'Admin access required' })).toBeInTheDocument();
  });

  it('renders promotion for an eligible admin', () => {
    renderRoute('admin', null, true);

    expect(screen.getByTestId('promotion-page')).toBeInTheDocument();
  });
});
