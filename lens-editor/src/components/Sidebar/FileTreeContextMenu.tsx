import * as ContextMenu from '@radix-ui/react-context-menu';
import type { ReactNode } from 'react';

interface FileTreeContextMenuProps {
  children: ReactNode;
  onRename: () => void;
  onDelete: () => void;
  isFolder: boolean;
}

export function FileTreeContextMenu({
  children,
  onRename,
  onDelete,
  isFolder,
}: FileTreeContextMenuProps) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="bg-white rounded shadow-lg py-1 min-w-[160px] z-50"
        >
          <ContextMenu.Item
            className="px-3 py-1.5 text-sm hover:bg-gray-100 cursor-pointer outline-none"
            onSelect={onRename}
          >
            Rename
          </ContextMenu.Item>
          <ContextMenu.Separator className="h-px bg-gray-200 my-1" />
          <ContextMenu.Item
            className="px-3 py-1.5 text-sm text-red-600 hover:bg-gray-100 cursor-pointer outline-none"
            onSelect={onDelete}
          >
            {isFolder ? 'Delete Folder' : 'Delete'}
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
