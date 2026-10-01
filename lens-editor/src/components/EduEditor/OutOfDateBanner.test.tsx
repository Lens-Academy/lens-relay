/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { OutOfDateBanner } from './OutOfDateBanner';

describe('OutOfDateBanner', () => {
  it('warns that the Course Editor is out of date and links to the File Editor', () => {
    render(
      <MemoryRouter>
        <OutOfDateBanner fileEditorUrl="/c0000001/Lens-Edu/modules/Demo-Module.md" />
      </MemoryRouter>
    );
    const alert = screen.getByRole('note');
    expect(alert.textContent).toContain('out of date');
    expect(alert.textContent).toContain('can break course files');
    expect(screen.getByRole('link', { name: 'in the File Editor' }).getAttribute('href')).toBe('/c0000001/Lens-Edu/modules/Demo-Module.md');
  });
});
