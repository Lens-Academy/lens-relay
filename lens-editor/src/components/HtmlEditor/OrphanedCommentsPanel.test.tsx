// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { OrphanedCommentsPanel } from './OrphanedCommentsPanel';

describe('OrphanedCommentsPanel', () => {
  it('lists each orphan by body and author', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(
      0,
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"first"}-->' +
        '<!--lens-comment {"id":"c2","author":"b","ts":"t","body":"second"}-->',
    );

    render(<OrphanedCommentsPanel ytext={ytext} orphanedIds={['c1', 'c2']} onJumpToSource={() => {}} />);

    expect(screen.getByText('a')).toBeInTheDocument();
    expect(screen.getByText(/first/)).toBeInTheDocument();
    expect(screen.getByText('b')).toBeInTheDocument();
    expect(screen.getByText(/second/)).toBeInTheDocument();
  });

  it('calls onJumpToSource with the orphan id', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    const onJumpToSource = vi.fn();
    ytext.insert(0, '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"first"}-->');

    render(<OrphanedCommentsPanel ytext={ytext} orphanedIds={['c1']} onJumpToSource={onJumpToSource} />);

    await userEvent.click(screen.getByRole('button', { name: /find in source/i }));

    expect(onJumpToSource).toHaveBeenCalledWith('c1');
  });

  it('renders nothing when there are no orphans', () => {
    const doc = new Y.Doc();
    const { container } = render(
      <OrphanedCommentsPanel ytext={doc.getText('contents')} orphanedIds={[]} onJumpToSource={() => {}} />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
