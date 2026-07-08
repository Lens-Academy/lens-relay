/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DiffViewer } from './DiffViewer';

describe('DiffViewer', () => {
  it('renders added, removed, and hunk lines from a unified diff', () => {
    render(
      <DiffViewer
        diff={[
          'diff --git a/Lens/Notes.md b/Lens/Notes.md',
          '@@ -1,2 +1,2 @@',
          ' context',
          '-old line',
          '+new line',
        ].join('\n')}
      />
    );

    expect(screen.getByText('diff --git a/Lens/Notes.md b/Lens/Notes.md')).toHaveAttribute('data-line-kind', 'header');
    expect(screen.getByText('@@ -1,2 +1,2 @@')).toHaveAttribute('data-line-kind', 'hunk');
    expect(screen.getByText('-old line')).toHaveAttribute('data-line-kind', 'removed');
    expect(screen.getByText('+new line')).toHaveAttribute('data-line-kind', 'added');
  });

  it('renders an empty diff message', () => {
    render(<DiffViewer diff="" />);

    expect(screen.getByText('No text diff available.')).toBeInTheDocument();
  });

  it('renders binary blob summaries', () => {
    render(
      <DiffViewer
        diff=""
        isBinary
        beforeBlob={{ oid: 'abc123456789', size: 12 }}
        afterBlob={{ oid: 'def987654321', size: 34 }}
      />
    );

    expect(screen.getByText('Binary file changed.')).toBeInTheDocument();
    expect(screen.getByText(/Before/)).toHaveTextContent('abc123456789');
    expect(screen.getByText(/Before/)).toHaveTextContent('12 bytes');
    expect(screen.getByText(/After/)).toHaveTextContent('def987654321');
    expect(screen.getByText(/After/)).toHaveTextContent('34 bytes');
  });
});
