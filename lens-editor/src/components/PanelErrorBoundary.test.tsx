import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PanelErrorBoundary } from './PanelErrorBoundary';

function Boom({ fail }: { fail: boolean }) {
  if (fail) throw new Error('boom');
  return <p>Panel body</p>;
}

describe('PanelErrorBoundary', () => {
  it('keeps a panel crash inside the panel, and tries again for another document', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = render(
      <div>
        <PanelErrorBoundary name="Concept relationships" resetKey="a"><Boom fail /></PanelErrorBoundary>
        <p>Editor</p>
      </div>,
    );
    expect(screen.getByText(/Concept relationships could not be shown\./)).toBeInTheDocument();
    // Retry renders the panel again (here it fails again).
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByText('Editor')).toBeInTheDocument();
    rerender(
      <div>
        <PanelErrorBoundary name="Concept relationships" resetKey="b"><Boom fail={false} /></PanelErrorBoundary>
        <p>Editor</p>
      </div>,
    );
    expect(screen.getByText('Panel body')).toBeInTheDocument();
    quiet.mockRestore();
  });
});
