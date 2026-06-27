/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PromoteFileDialog } from './PromoteFileDialog';
import type { PromotionStatusResponse } from '../../lib/promotion-api';
import { createPromotionPr, getPromotionDiff } from '../../lib/promotion-api';

vi.mock('../../lib/promotion-api', () => ({
  getPromotionDiff: vi.fn(),
  createPromotionPr: vi.fn(),
}));

const status: PromotionStatusResponse = {
  path: '/Lens/Notes.md',
  oldPath: null,
  status: 'modified',
  additions: 4,
  deletions: 2,
  isBinary: false,
  mainSha: 'main-sha',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('PromoteFileDialog', () => {
  beforeEach(() => {
    vi.mocked(getPromotionDiff).mockReset();
    vi.mocked(createPromotionPr).mockReset();
  });

  it('renders nothing when closed', () => {
    render(
      <PromoteFileDialog
        open={false}
        filePath="/Lens/Notes.md"
        status={status}
        onClose={vi.fn()}
      />
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('fetches and shows the diff only after View diff is clicked', async () => {
    const user = userEvent.setup();
    vi.mocked(getPromotionDiff).mockResolvedValue({
      path: '/Lens/Notes.md',
      mainSha: 'main-sha',
      status: 'modified',
      isBinary: false,
      beforeBlob: null,
      afterBlob: null,
      diff: '@@ -1 +1 @@\n-old\n+new',
    });

    render(
      <PromoteFileDialog
        open
        filePath="/Lens/Notes.md"
        status={status}
        onClose={vi.fn()}
      />
    );

    expect(getPromotionDiff).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /view diff/i }));

    expect(getPromotionDiff).toHaveBeenCalledWith('/Lens/Notes.md');
    expect(await screen.findByText(/@@ -1 \+1 @@/)).toBeInTheDocument();
    expect(screen.getByText(/\+new/)).toBeInTheDocument();
  });

  it('creates a single-file promotion PR and shows the result', async () => {
    const user = userEvent.setup();
    const onPromoted = vi.fn();
    vi.mocked(createPromotionPr).mockResolvedValue({
      branch: 'promotion/notes',
      prNumber: 42,
      prUrl: 'https://github.com/Lens-Academy/lens-relay/pull/42',
      mainSha: 'main-sha',
      autoMergeEnabled: true,
    });

    render(
      <PromoteFileDialog
        open
        filePath="/Lens/Notes.md"
        status={status}
        onClose={vi.fn()}
        onPromoted={onPromoted}
      />
    );

    await user.click(screen.getByRole('button', { name: /promote file/i }));

    await waitFor(() => {
      expect(createPromotionPr).toHaveBeenCalledWith({ paths: ['/Lens/Notes.md'] });
    });
    expect(await screen.findByRole('link', { name: /pull request #42/i })).toHaveAttribute(
      'href',
      'https://github.com/Lens-Academy/lens-relay/pull/42'
    );
    expect(screen.getByText(/promotion\/notes/)).toBeInTheDocument();
    expect(onPromoted).toHaveBeenCalledTimes(1);
  });

  it('clears a previous promotion result when reopened for another file', async () => {
    const user = userEvent.setup();
    vi.mocked(createPromotionPr).mockResolvedValue({
      branch: 'promotion/notes',
      prNumber: 42,
      prUrl: 'https://github.com/Lens-Academy/lens-relay/pull/42',
      mainSha: 'main-sha',
      autoMergeEnabled: true,
    });

    const { rerender } = render(
      <PromoteFileDialog
        open
        filePath="/Lens/Notes.md"
        status={status}
        onClose={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: /promote file/i }));
    expect(await screen.findByRole('link', { name: /pull request #42/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /promote file/i })).toBeDisabled();

    rerender(
      <PromoteFileDialog
        open={false}
        filePath="/Lens/Notes.md"
        status={status}
        onClose={vi.fn()}
      />
    );
    rerender(
      <PromoteFileDialog
        open
        filePath="/Lens/Other.md"
        status={{ ...status, path: '/Lens/Other.md', additions: 1, deletions: 0 }}
        onClose={vi.fn()}
      />
    );

    expect(screen.queryByRole('link', { name: /pull request #42/i })).not.toBeInTheDocument();
    expect(screen.getByText('/Lens/Other.md')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /promote file/i })).not.toBeDisabled();
  });

  it('keeps an in-flight promotion active when viewing diff concurrently', async () => {
    const user = userEvent.setup();
    const onPromoted = vi.fn();
    const promotion = deferred<Awaited<ReturnType<typeof createPromotionPr>>>();
    vi.mocked(createPromotionPr).mockReturnValue(promotion.promise);
    vi.mocked(getPromotionDiff).mockResolvedValue({
      path: '/Lens/Notes.md',
      mainSha: 'main-sha',
      status: 'modified',
      isBinary: false,
      beforeBlob: null,
      afterBlob: null,
      diff: '@@ -1 +1 @@\n-old\n+new',
    });

    render(
      <PromoteFileDialog
        open
        filePath="/Lens/Notes.md"
        status={status}
        onClose={vi.fn()}
        onPromoted={onPromoted}
      />
    );

    await user.click(screen.getByRole('button', { name: /promote file/i }));
    expect(screen.getByRole('button', { name: /promoting/i })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /view diff/i }));
    expect(await screen.findByText(/\+new/)).toBeInTheDocument();

    promotion.resolve({
      branch: 'promotion/notes',
      prNumber: 42,
      prUrl: 'https://github.com/Lens-Academy/lens-relay/pull/42',
      mainSha: 'main-sha',
      autoMergeEnabled: true,
    });

    expect(await screen.findByRole('link', { name: /pull request #42/i })).toBeInTheDocument();
    expect(screen.getByText(/promotion\/notes/)).toBeInTheDocument();
    expect(onPromoted).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /promoting/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /promote file/i })).toBeDisabled();
  });

  it('shows promotion failures', async () => {
    const user = userEvent.setup();
    vi.mocked(createPromotionPr).mockRejectedValue(new Error('Promotion failed'));

    render(
      <PromoteFileDialog
        open
        filePath="/Lens/Notes.md"
        status={status}
        onClose={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: /promote file/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Promotion failed');
  });
});
