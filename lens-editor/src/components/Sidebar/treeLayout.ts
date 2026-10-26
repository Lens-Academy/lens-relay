/**
 * The file tree's geometry, after Notion's sidebar: 30px items 1px apart, a
 * 16px step per level, so what is inside a folder stands clearly under it.
 * Shared by FileTree, its rows and the sticky folder headers, which must
 * line up.
 */
export const TREE_ROW_HEIGHT = 31;
export const TREE_ROW_HEIGHT_MOBILE = 40;
export const TREE_INDENT = 16;

/**
 * Left padding of an item at a tree level. Level 0 is a shared folder, shown
 * as a section label; its contents start in line with the label.
 */
export function treeItemPadding(level: number): number {
  return 8 + Math.max(0, level - 1) * TREE_INDENT;
}

/**
 * Where an item's guide lines run: one per folder it is inside (below the
 * section labels), down the middle of that folder's icon, so what a folder
 * holds hangs from it. In px from the row's left edge (the item is inset 8px).
 */
export function treeGuides(level: number): number[] {
  return Array.from({ length: Math.max(0, level - 1) }, (_, i) => 8 + treeItemPadding(i + 1) + 11);
}

/** Notion's "more" icon: three dots */
export const MORE_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.25"/><circle cx="8" cy="8" r="1.25"/><circle cx="12.5" cy="8" r="1.25"/></svg>';

/** A page's icon: Notion's document glyph */
export const PAGE_ICON_SVG = '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">'
  + '<path d="M5.5 2.75h6.1L15 6.15v10.1a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V3.75a1 1 0 0 1 1-1Z" stroke-linejoin="round"/>'
  + '<path d="M11.5 2.9v3.35h3.35M7.25 10h5.5M7.25 12.75h5.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * A folder's icon: the back with its tab, and the front flap, which tilts
 * open while the folder is open (the lens-folder-* rules in index.css)
 */
export const FOLDER_ICON_SVG = '<svg class="lens-folder" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M2.75 16.25V5.5A1.25 1.25 0 0 1 4 4.25h3.6l1.7 1.75h6.7a1.25 1.25 0 0 1 1.25 1.25v1"/>'
  + '<path class="lens-folder-flap" d="M2.75 8.25h14.5v6.75a1.25 1.25 0 0 1-1.25 1.25H4a1.25 1.25 0 0 1-1.25-1.25Z"/></svg>';

/** Notion's toggle chevron, pointing down (turned to point right while closed) */
export const CHEVRON_SVG = '<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2.75 4.5 3.25 3.25L9.25 4.5"/></svg>';
