/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SourceModeToggle } from './SourceModeToggle';

describe('SourceModeToggle', () => {
  it('labels the source and preview options with text', () => {
    render(
      <SourceModeToggle
        editorView={null}
        isSourceMode={false}
        onSourceModeChange={vi.fn()}
      />
    );

    expect(screen.getByText('Source')).toBeInTheDocument();
    expect(screen.getByText('Preview')).toBeInTheDocument();
  });
});
