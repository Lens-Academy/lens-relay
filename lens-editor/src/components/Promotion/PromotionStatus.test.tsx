/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PromotionStatus } from './PromotionStatus';
import type { PromotionStatusResponse } from '../../lib/promotion-api';

const baseStatus: PromotionStatusResponse = {
  path: '/Lens/Notes.md',
  oldPath: null,
  status: 'identical',
  additions: 0,
  deletions: 0,
  isBinary: false,
  mainSha: 'main-sha',
};

describe('PromotionStatus', () => {
  it('shows identical status without the action menu', () => {
    render(
      <PromotionStatus
        filePath="/Lens/Notes.md"
        canPromote
        status={baseStatus}
        onRefresh={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: /identical to production/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /promote to production/i })).not.toBeInTheDocument();
  });

  it('offers this-file and multiple-files actions for modified files', async () => {
    const user = userEvent.setup();
    const onPromoteFile = vi.fn();
    const onPromoteMultiple = vi.fn();

    render(
      <PromotionStatus
        filePath="/Lens/Notes.md"
        canPromote
        status={{ ...baseStatus, status: 'modified', additions: 3, deletions: 1 }}
        onRefresh={vi.fn()}
        onPromoteFile={onPromoteFile}
        onPromoteMultiple={onPromoteMultiple}
      />
    );

    await user.click(screen.getByRole('button', { name: /promote to production/i }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /this file/i }));

    expect(onPromoteFile).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /this file/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /promote to production/i }));
    expect(screen.getByRole('menu')).toHaveClass('z-[1000]');
    await user.click(screen.getByRole('button', { name: /multiple files/i }));

    expect(onPromoteMultiple).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /multiple files/i })).not.toBeInTheDocument();
  });

  it('labels loading and error states', () => {
    const { rerender } = render(
      <PromotionStatus
        filePath="/Lens/Notes.md"
        canPromote
        status={null}
        loading
        onRefresh={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: /checking production/i })).toBeInTheDocument();

    rerender(
      <PromotionStatus
        filePath="/Lens/Notes.md"
        canPromote
        status={null}
        error="Network error"
        onRefresh={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: /unable to check production/i })).toBeInTheDocument();
  });

  it('refreshes from the non-actionable status button', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();

    render(
      <PromotionStatus
        filePath="/Lens/Notes.md"
        canPromote={false}
        status={{ ...baseStatus, status: 'modified' }}
        onRefresh={onRefresh}
      />
    );

    await user.click(screen.getByRole('button', { name: /different from production/i }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
