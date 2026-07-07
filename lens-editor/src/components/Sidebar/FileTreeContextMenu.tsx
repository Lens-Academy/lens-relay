import * as ContextMenu from '@radix-ui/react-context-menu';
import type { ReactNode } from 'react';

// On touch devices the context-menu lifecycle leaks clicks onto the file row
// underneath: the long-press release can synthesize a click while the menu is
// open, and picking a menu item (pointerup) synthesizes one right after it
// closes. Either click would activate the row — navigating away and killing
// the rename/move/delete state. Suppress row clicks while the menu is open
// and briefly after it closes. Shared with FileTreeNode.
let suppressTreeClicksUntil = 0;

export function shouldSuppressTreeClick(): boolean {
  return Date.now() < suppressTreeClicksUntil;
}

interface FileTreeContextMenuProps {
  children: ReactNode;
  onRename: () => void;
  onDelete: () => void;
  onMove: () => void;
  isFolder: boolean;
  isSharedFolderRoot?: boolean;
}

export function FileTreeContextMenu({
  children,
  onRename,
  onDelete,
  onMove,
  isFolder,
  isSharedFolderRoot = false,
}: FileTreeContextMenuProps) {
  return (
    <ContextMenu.Root
      onOpenChange={(open) => {
        suppressTreeClicksUntil = open ? Number.POSITIVE_INFINITY : Date.now() + 500;
      }}
    >
      <ContextMenu.Trigger asChild>
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="bg-white rounded shadow-lg py-1 min-w-[160px] z-50"
          // The portal is a React child of the tree row, so item clicks bubble
          // through the React tree to react-arborist's row onClick — which
          // selects the row and navigates, killing the rename/move/delete
          // state. Contain them here.
          onClick={(e) => e.stopPropagation()}
        >
          {!isSharedFolderRoot && (
            <ContextMenu.Item
              className="px-3 py-1.5 text-sm hover:bg-gray-100 cursor-pointer outline-none"
              onSelect={onRename}
            >
              Rename
            </ContextMenu.Item>
          )}
          {!isFolder && (
            <ContextMenu.Item
              className="px-3 py-1.5 text-sm hover:bg-gray-100 cursor-pointer outline-none"
              onSelect={onMove}
            >
              Move to...
            </ContextMenu.Item>
          )}
          {!isSharedFolderRoot && (
            <>
              <ContextMenu.Separator className="h-px bg-gray-200 my-1" />
              <ContextMenu.Item
                className="px-3 py-1.5 text-sm text-red-600 hover:bg-gray-100 cursor-pointer outline-none"
                onSelect={onDelete}
              >
                {isFolder ? 'Delete Folder' : 'Delete'}
              </ContextMenu.Item>
            </>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
