/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { WorkflowMenu } from './WorkflowMenu';

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
    expect(screen.getByRole('menuitem', { name: /add video/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /add article/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /promote to production/i })).toBeInTheDocument();
  });

  it('routes to the selected workflow and closes the menu', async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole('button', { name: /open workflows menu/i }));
    await user.click(screen.getByRole('menuitem', { name: /add article/i }));

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
});
