/**
 * @vitest-environment happy-dom
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TreeApi, NodeApi } from 'react-arborist';
import type { TreeNode } from '../../lib/tree-utils';
import { FileTreeProvider } from './FileTreeContext';
import { StickyScrollOverlay } from './StickyScrollOverlay';

function makeTreeApi() {
  const scrollEl = document.createElement('div');
  scrollEl.scrollTop = 28;
  Object.defineProperty(scrollEl, 'offsetWidth', { value: 200 });
  Object.defineProperty(scrollEl, 'clientWidth', { value: 190 });

  const toggle = vi.fn();
  const root = {
    id: 'root',
    data: { id: 'root', name: 'Lens', path: '/Lens', isFolder: true, children: [] },
    level: 0,
    isInternal: true,
    isOpen: true,
    parent: null,
    rowIndex: 0,
    toggle,
  } as unknown as NodeApi<TreeNode>;

  const child = {
    id: 'welcome',
    data: { id: 'welcome', name: 'Welcome.md', path: '/Lens/Welcome.md', docId: 'welcome', isFolder: false },
    level: 1,
    isInternal: false,
    isOpen: false,
    parent: root,
    rowIndex: 1,
  } as unknown as NodeApi<TreeNode>;

  return {
    treeApi: {
      visibleNodes: [root, child],
      listEl: { current: scrollEl },
      get: (id: string) => id === 'root' ? root : undefined,
      scrollTo: vi.fn(),
    } as unknown as TreeApi<TreeNode>,
    toggle,
  };
}

function renderOverlay(treeApi: TreeApi<TreeNode>, callbacks: {
  onCreateDocument?: (path: string) => void;
  onCreateFolder?: (path: string) => void;
}) {
  render(
    <FileTreeProvider
      value={{
        editingPath: null,
        onEditingChange: vi.fn(),
        ...callbacks,
      }}
    >
      <StickyScrollOverlay treeApi={treeApi} />
    </FileTreeProvider>
  );
}

describe('StickyScrollOverlay', () => {
  it('creates a document from a sticky folder header without toggling the folder', async () => {
    const user = userEvent.setup();
    const { treeApi, toggle } = makeTreeApi();
    const onCreateDocument = vi.fn();
    renderOverlay(treeApi, { onCreateDocument });

    const createButton = await screen.findByRole('button', { name: /create in lens/i });
    await user.click(createButton);
    expect(toggle).not.toHaveBeenCalled();

    await user.click(await screen.findByRole('button', { name: /new file/i }));

    expect(onCreateDocument).toHaveBeenCalledWith('/Lens');
    expect(toggle).not.toHaveBeenCalled();
  });

  it('keeps the folder path that opened the sticky create menu', async () => {
    const user = userEvent.setup();
    const { treeApi } = makeTreeApi();
    const onCreateDocument = vi.fn();
    renderOverlay(treeApi, { onCreateDocument });

    const createButton = await screen.findByRole('button', { name: /create in lens/i });
    await user.click(createButton);

    const row = createButton.closest('[data-node-path]') as HTMLElement;
    row.dataset.nodePath = '/Lens Edu';

    await user.click(await screen.findByRole('button', { name: /new file/i }));

    expect(onCreateDocument).toHaveBeenCalledWith('/Lens');
  });

  it('creates a folder from a sticky folder header', async () => {
    const user = userEvent.setup();
    const { treeApi } = makeTreeApi();
    const onCreateFolder = vi.fn();
    renderOverlay(treeApi, { onCreateFolder });

    await user.click(await screen.findByRole('button', { name: /create in lens/i }));
    await user.click(await screen.findByRole('button', { name: /new folder/i }));

    expect(onCreateFolder).toHaveBeenCalledWith('/Lens');
  });

  it('does not render sticky create controls before the folder row scrolls away', async () => {
    const { treeApi } = makeTreeApi();
    const scrollEl = treeApi.listEl.current!;
    scrollEl.scrollTop = 0;

    renderOverlay(treeApi, { onCreateDocument: vi.fn() });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /create in lens/i })).not.toBeInTheDocument();
    });
  });
});
