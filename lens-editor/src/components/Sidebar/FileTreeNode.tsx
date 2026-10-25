import { useState, useRef, useEffect } from 'react';
import type { NodeRendererProps } from 'react-arborist';
import type { TreeNode } from '../../lib/tree-utils';
import { FileTreeContextMenu, shouldSuppressTreeClick } from './FileTreeContextMenu';
import { useFileTreeContext } from './FileTreeContext';
import { useDragTarget } from './FileTree';
import { CreateMenu } from './CreateMenu';
import { CHEVRON_SVG, FOLDER_ICON_SVG, PAGE_ICON_SVG, folderIcon, treeItemPadding } from './treeLayout';

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

  // Notion's sidebar item (index.css): the page's emoji, or a default icon,
  // in a fixed slot before the name; a folder's turns into a chevron on hover.
  // The shared folders at the top are section labels.
  const emoji = isFolder ? folderIcon(node.data, ctx.pageIcons) : node.data.docId ? ctx.pageIcons?.get(node.data.docId) : undefined;
  const itemClass = `lens-tree-item${isSharedFolderRoot ? ' is-section' : ''}${isActive ? ' is-active' : ''}${isDropTarget ? ' is-drop-target' : ''}`;

  const content = (
    <div
      ref={dragHandle}
      style={{ ...style, paddingLeft: 0 }} // Override react-arborist's padding, we handle it ourselves
      className="lens-tree-row cursor-pointer select-none"
      onClick={(e) => {
        if (isEditing) return;
        // Ghost click after a touch long-press context menu closes — the tap
        // that picked the menu item must not also activate this row
        if (shouldSuppressTreeClick()) {
          e.stopPropagation();
          return;
        }
        if (isFolder) {
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
          <span className={`lens-tree-icon${isFolder ? ' is-folder' : ''}`}>
            {emoji
              ? <span className="lens-tree-glyph">{emoji}</span>
              : <span className="lens-tree-glyph" dangerouslySetInnerHTML={{ __html: isFolder ? FOLDER_ICON_SVG : PAGE_ICON_SVG }} />}
            {isFolder && (
              <span className={`lens-tree-chevron${node.isOpen ? ' is-open' : ''}`} dangerouslySetInnerHTML={{ __html: CHEVRON_SVG }} />
            )}
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
