/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { WorkflowMenu } from './WorkflowMenu';
import { AuthProvider, type UserRole } from '../../contexts/AuthContext';
import { EDU_FOLDER_ID } from '../../lib/constants';

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderMenu(initialEntry = '/') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <WorkflowMenu />
      <LocationProbe />
    </MemoryRouter>
  );
}

describe('WorkflowMenu', () => {
  afterEach(() => {
    cleanup();
  });

  it('opens workflow links from the top menu', async () => {
    const user = userEvent.setup();
    renderMenu();

    expect(screen.queryByText('Workflows')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /open workflows menu/i }));

    expect(screen.queryByText('Workflows')).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /review suggestions/i })).toBeInTheDocument();
    // One importer for articles and videos; the Add Video page is gone.
    expect(screen.queryByRole('menuitem', { name: /add video/i })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /add source/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /promote to production/i })).toBeInTheDocument();
  });

  it('routes to the selected workflow and closes the menu', async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole('button', { name: /open workflows menu/i }));
    await user.click(screen.getByRole('menuitem', { name: /add source/i }));

    expect(screen.getByTestId('location')).toHaveTextContent('/add-article');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('marks the current workflow route as active', async () => {
    const user = userEvent.setup();
    renderMenu('/promote');

    await user.click(screen.getByRole('button', { name: /open workflows menu/i }));

    expect(screen.getByRole('menuitem', { name: /promote to production/i })).toHaveAttribute('aria-current', 'page');
  });

  it('closes when Escape is pressed', async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole('button', { name: /open workflows menu/i }));
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  async function openMenuAs(role: UserRole, folderUuid: string | null, isAllFolders: boolean) {
    const user = userEvent.setup();
    render(
      <AuthProvider role={role} folderUuid={folderUuid} isAllFolders={isAllFolders}>
        <MemoryRouter initialEntries={['/']}>
          <WorkflowMenu />
        </MemoryRouter>
      </AuthProvider>
    );
    await user.click(screen.getByRole('button', { name: /open workflows menu/i }));
    return screen.getAllByRole('menuitem').map(item => item.querySelector('.font-medium')?.textContent);
  }

  it('offers view and suggest links only the pages they can use', async () => {
    expect(await openMenuAs('view', null, true)).toEqual(['Recent Changes']);
    cleanup();
    expect(await openMenuAs('suggest', EDU_FOLDER_ID, false)).toEqual(['Recent Changes']);
  });

  it('offers Lens Edu workflows only to edit links that include Lens Edu', async () => {
    expect(await openMenuAs('edit', 'some-other-folder', false)).toEqual(['Review Suggestions', 'Recent Changes']);
    cleanup();
    expect(await openMenuAs('edit', EDU_FOLDER_ID, false)).toEqual([
      'Review Suggestions', 'Recent Changes', 'Add Source', 'Promote to Production',
    ]);
  });
});
