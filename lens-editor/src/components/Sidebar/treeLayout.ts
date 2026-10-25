import type { TreeNode } from '../../lib/tree-utils';

/**
 * The file tree's geometry, after Notion's sidebar: 30px items 1px apart, an
 * 8px step per level. Shared by FileTree, its rows and the sticky folder
 * headers, which must line up.
 */
export const TREE_ROW_HEIGHT = 31;
export const TREE_ROW_HEIGHT_MOBILE = 40;
export const TREE_INDENT = 8;

/**
 * Left padding of an item at a tree level. Level 0 is a shared folder, shown
 * as a section label; its contents start in line with the label.
 */
export function treeItemPadding(level: number): number {
  return 8 + Math.max(0, level - 1) * TREE_INDENT;
}

/** A folder's icon is its "00 - Start Here" page's icon, if that has one. */
export function folderIcon(folder: TreeNode, icons?: Map<string, string>): string | undefined {
  const startHere = folder.children?.find((child) => !child.isFolder && /^00 - Start Here\.md$/i.test(child.name));
  return startHere?.docId ? icons?.get(startHere.docId) : undefined;
}

/** Notion's default page icon, for pages without an emoji */
export const PAGE_ICON_SVG = '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">'
  + '<path d="M5.5 2.75h6.1L15 6.15v10.1a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V3.75a1 1 0 0 1 1-1Z" stroke-linejoin="round"/>'
  + '<path d="M11.5 2.9v3.35h3.35M7.25 10h5.5M7.25 12.75h5.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** The default icon of a folder without an emoji */
export const FOLDER_ICON_SVG = '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">'
  + '<path d="M2.75 5.5a1.25 1.25 0 0 1 1.25-1.25h3.6l1.7 1.75h6.7a1.25 1.25 0 0 1 1.25 1.25v7.5a1.25 1.25 0 0 1-1.25 1.25H4a1.25 1.25 0 0 1-1.25-1.25Z" stroke-linejoin="round"/></svg>';

/** Notion's toggle chevron, pointing down (turned to point right while closed) */
export const CHEVRON_SVG = '<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2.75 4.5 3.25 3.25L9.25 4.5"/></svg>';
