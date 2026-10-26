import { useState, useRef, useEffect } from 'react';
import type { NodeRendererProps } from 'react-arborist';
import type { TreeNode } from '../../lib/tree-utils';
import { FileTreeContextMenu, shouldSuppressTreeClick } from './FileTreeContextMenu';
import { useFileTreeContext } from './FileTreeContext';
import { useDragTarget } from './FileTree';
import { CreateMenu } from './CreateMenu';
import { CHEVRON_SVG, FOLDER_ICON_SVG, MORE_SVG, PAGE_ICON_SVG, treeGuides, treeItemPadding } from './treeLayout';

/**
 * The folder just opened by a click, for a moment: its contents ease in
 * (index.css) as they first show, one after another
 */
let justOpened: string | null = null;
let justOpenedTimer = 0;
function markOpened(id: string) {
  justOpened = id;
  window.clearTimeout(justOpenedTimer);
  justOpenedTimer = window.setTimeout(() => {
    justOpened = null;
  }, 400);
}

export function FileTreeNode({
  node,
  style,
  dragHandle,
}: NodeRendererProps<TreeNode>) {
  const isFolder = node.data.isFolder;
  const depth = node.level;
  const isSharedFolderRoot = isFolder && depth === 0;
  const ctx = useFileTreeContext();
  const dragTargetPath = useDragTarget();
  const isDropTarget = isFolder && dragTargetPath === node.data.path;

  const isEditing = ctx.editingPath === node.data.path;

  // Check if this node is the active document
  // activeDocId is compound format: RELAY_ID-docUUID, node.data.docId is just UUID
  const isActive = !isFolder && node.data.docId && ctx.activeDocId?.endsWith(node.data.docId);

  const inputRef = useRef<HTMLInputElement>(null);
  const [editValue, setEditValue] = useState(node.data.name);
  // Guard: ignore blur events until the input has been properly focused
  const blurGuardRef = useRef(false);

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      blurGuardRef.current = true;
      // Delay focus+select so it happens after Radix menu close settles
      setTimeout(() => {
        if (!inputRef.current) return;
        inputRef.current.focus();
        // Select name without extension for markdown files
        const name = node.data.name;
        const dotIndex = name.lastIndexOf('.');
        if (dotIndex > 0) {
          inputRef.current.setSelectionRange(0, dotIndex);
        } else {
          inputRef.current.select();
        }
        blurGuardRef.current = false;
      }, 50);
    }
  }, [isEditing, node.data.name]);

  const handleRename = () => {
    if (!ctx.onRequestRename) return;
    blurGuardRef.current = true; // Arm guard before state change
    ctx.onRequestRename(node.data.path);
    ctx.onEditingChange(node.data.path);
    setEditValue(node.data.name);
  };

  const handleDelete = () => {
    ctx.onRequestDelete?.(node.data.path, node.data.name);
  };

  const handleMove = () => {
    if (node.data.docId) {
      ctx.onRequestMove?.(node.data.path, node.data.docId);
    }
  };

  const handleSubmitRename = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== node.data.name) {
      ctx.onRenameSubmit?.(node.data.path, trimmed, isFolder, node.data.docId);
    }
    ctx.onEditingChange(null);
  };

  const cancelledRef = useRef(false);

  const handleBlur = () => {
    if (blurGuardRef.current) return; // Ignore blur during edit mode transition
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return; // Escape was pressed — don't save
    }
    handleSubmitRename();
  };

  const handleCancelRename = () => {
    cancelledRef.current = true;
    ctx.onEditingChange(null);
    setEditValue(node.data.name);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Stop all keys from bubbling to react-arborist tree navigation
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelRename();
    }
  };

  // Notion's sidebar item (index.css): a page's or folder's icon in a fixed
  // slot before the name; a folder's icon opens as the folder does. The
  // shared folders at the top are section labels.
  const itemClass = `lens-tree-item${isSharedFolderRoot ? ' is-section' : ''}${isActive ? ' is-active' : ''}${isDropTarget ? ' is-drop-target' : ''}`;
  const entering = justOpened !== null && node.parent?.id === justOpened;
  // A faint line down from each folder the item is in
  const guides = treeGuides(depth);
  const guideStyle = guides.length > 0 ? {
    backgroundImage: guides.map(() => 'linear-gradient(var(--lens-tree-guide), var(--lens-tree-guide))').join(', '),
    backgroundSize: guides.map(() => '1px 100%').join(', '),
    backgroundPosition: guides.map((x) => `${x}px 0`).join(', '),
    backgroundRepeat: 'no-repeat',
  } : undefined;
  const hasMenu = !isSharedFolderRoot && !!(ctx.onRequestDelete || ctx.onRequestRename);

  const content = (
    <div
      ref={dragHandle}
      // Override react-arborist's padding, we handle it ourselves
      style={{ ...style, paddingLeft: 0, ...guideStyle, ...(entering && { '--i': Math.min(node.childIndex, 12) }) } as React.CSSProperties}
      className={`lens-tree-row cursor-pointer select-none${entering ? ' is-entering' : ''}`}
      onClick={(e) => {
        if (isEditing) return;
        // Ghost click after a touch long-press context menu closes — the tap
        // that picked the menu item must not also activate this row
        if (shouldSuppressTreeClick()) {
          e.stopPropagation();
          return;
        }
        if (isFolder) {
          if (!node.isOpen) markOpened(node.id);
          node.toggle();
        } else if ((e.ctrlKey || e.metaKey) && ctx.onOpenNewTab && node.data.docId) {
          ctx.onOpenNewTab(node.data.docId);
        } else {
          node.select();
        }
        e.stopPropagation();
      }}
      onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
      onAuxClick={(e) => {
        if (e.button === 1 && !isFolder && node.data.docId && ctx.onOpenNewTab) {
          e.preventDefault();
          ctx.onOpenNewTab(node.data.docId);
        }
      }}
      onDoubleClick={(e) => {
        if (!isFolder && !isEditing) {
          e.stopPropagation();
          handleRename();
        }
      }}
    >
      <div className={itemClass} style={{ paddingLeft: treeItemPadding(depth) }}>
        {!isSharedFolderRoot && (
          // A folder's icon gives way to Notion's chevron on hover
          <span className={`lens-tree-icon${isFolder ? ' is-folder' : ''}${isFolder && node.isOpen ? ' is-open' : ''}`}>
            <span className="lens-tree-glyph" dangerouslySetInnerHTML={{ __html: isFolder ? FOLDER_ICON_SVG : PAGE_ICON_SVG }} />
            {isFolder && <span className="lens-tree-chevron" dangerouslySetInnerHTML={{ __html: CHEVRON_SVG }} />}
          </span>
        )}

        {/* Name or edit input */}
        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            className="lens-tree-rename flex-1 min-w-0 outline-none"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="lens-tree-name truncate" title={node.data.path}>
            {/* Pages show their title, as in Notion: no .md */}
            {isFolder ? node.data.name : node.data.name.replace(/\.md$/i, '')}
          </span>
        )}
        {isSharedFolderRoot && (
          <span className={`lens-tree-section-chevron${node.isOpen ? ' is-open' : ''}`} dangerouslySetInnerHTML={{ __html: CHEVRON_SVG }} />
        )}

        {/* Create menu (new file / from template / new HTML file / new folder) for folders */}
        {isFolder && (ctx.onCreateDocument || ctx.onCreateHtmlDocument || ctx.onCreateFolder) && (
          <CreateMenu
            folderName={node.data.name}
            onCreateDocument={ctx.onCreateDocument ? () => ctx.onCreateDocument!(node.data.path) : undefined}
            onCreateHtmlDocument={ctx.onCreateHtmlDocument ? () => ctx.onCreateHtmlDocument!(node.data.path) : undefined}
            onCreateFolder={ctx.onCreateFolder ? () => ctx.onCreateFolder!(node.data.path) : undefined}
            getTemplates={ctx.getTemplates ? () => ctx.getTemplates!(node.data.path) : undefined}
            onCreateFromTemplate={ctx.onCreateFromTemplate ? (template) => ctx.onCreateFromTemplate!(node.data.path, template) : undefined}
          />
        )}

        {/* Notion's ···: the item's menu (rename, move, delete), which a
            right-click also opens */}
        {hasMenu && !isEditing && (
          <span className={`lens-tree-actions flex-shrink-0${isFolder ? '' : ' ml-auto'}`}>
            <button
              type="button"
              aria-label={`More actions for ${node.data.name}`}
              title="Rename, move, delete…"
              className="lens-tree-action max-md:p-2 max-md:-my-1.5"
              onClick={(e) => {
                e.stopPropagation();
                const at = e.currentTarget.getBoundingClientRect();
                e.currentTarget.closest('.lens-tree-row')?.dispatchEvent(new MouseEvent('contextmenu', {
                  bubbles: true,
                  cancelable: true,
                  clientX: at.left,
                  clientY: at.bottom + 4,
                }));
              }}
              dangerouslySetInnerHTML={{ __html: MORE_SVG }}
            />
          </span>
        )}
      </div>
    </div>
  );

  // Wrap with context menu if callbacks are provided
  if (ctx.onRequestDelete || ctx.onRequestRename) {
    return (
      <FileTreeContextMenu
        onRename={handleRename}
        onDelete={ctx.onRequestDelete ? handleDelete : undefined}
        onMove={handleMove}
        isFolder={isFolder}
        isSharedFolderRoot={isSharedFolderRoot}
      >
        {content}
      </FileTreeContextMenu>
    );
  }

  return content;
}
