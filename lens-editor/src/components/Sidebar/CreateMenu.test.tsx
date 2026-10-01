/**
 * @vitest-environment happy-dom
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CreateMenu } from './CreateMenu';

const template = { path: '/Lens Edu/Lenses/Lens Template.md', name: 'Lens Template', docId: 't1' };

describe('CreateMenu', () => {
  it('lists templates under "New from template" and creates from the chosen one', async () => {
    const user = userEvent.setup();
    const onCreateFromTemplate = vi.fn();
    render(
      <CreateMenu
        folderName="Lenses"
        onCreateDocument={vi.fn()}
        getTemplates={() => [template]}
        onCreateFromTemplate={onCreateFromTemplate}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Create in Lenses' }));
    expect(screen.queryByRole('button', { name: 'Lens Template' })).toBeNull();
    await user.click(screen.getByRole('button', { name: /new from template/i }));
    await user.click(screen.getByRole('button', { name: 'Lens Template' }));

    expect(onCreateFromTemplate).toHaveBeenCalledWith(template);
    expect(screen.queryByRole('button', { name: 'New File' })).toBeNull();
  });

  it('leaves out "New from template" when there are no templates', async () => {
    const user = userEvent.setup();
    render(
      <CreateMenu
        folderName="Notes"
        onCreateDocument={vi.fn()}
        getTemplates={() => []}
        onCreateFromTemplate={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Create in Notes' }));
    expect(screen.getByRole('button', { name: 'New File' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /new from template/i })).toBeNull();
  });
});
