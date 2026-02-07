import type { FileMetadata } from '../hooks/useFolderMetadata';

export interface TreeNode {
  id: string;
  name: string;
  path: string;
  children?: TreeNode[];
  isFolder: boolean;
  docId?: string;
}

/**
 * Build a tree structure from flat path-based metadata.
 * Sorts: folders first, then alphabetical within each level.
 * Creates intermediate folder nodes for paths with missing parent folders.
 */
export function buildTreeFromPaths(metadata: Record<string, FileMetadata>): TreeNode[] {
  const root: TreeNode[] = [];
  const folderMap = new Map<string, TreeNode>();

  /**
   * Ensure all ancestor folders exist in folderMap.
   * Creates synthetic folder nodes for intermediate paths not in metadata.
   */
  const ensureAncestors = (path: string) => {
    const parts = path.split('/').filter(Boolean); // Remove empty strings
    let currentPath = '';

    // Process all parts except the last one (which is the file/folder itself)
    for (let i = 0; i < parts.length - 1; i++) {
      currentPath = currentPath + '/' + parts[i];

      if (!folderMap.has(currentPath)) {
        // Create synthetic folder node
        const folderNode: TreeNode = {
          id: `synthetic-${currentPath}`,
          name: parts[i],
          path: currentPath,
          isFolder: true,
          children: [],
        };
        folderMap.set(currentPath, folderNode);

        // Add to parent or root
        const parentParts = currentPath.split('/').filter(Boolean);
        parentParts.pop();
        const parentPath = parentParts.length > 0 ? '/' + parentParts.join('/') : '';

        if (parentPath && folderMap.has(parentPath)) {
          folderMap.get(parentPath)!.children!.push(folderNode);
        } else {
          root.push(folderNode);
        }
      }
    }
  };

  // Sort paths to ensure parent folders are processed before children
  // Also sort folders first, then alphabetically
  const sortedPaths = Object.keys(metadata).sort((a, b) => {
    const aIsFolder = metadata[a].type === 'folder';
    const bIsFolder = metadata[b].type === 'folder';

    // Folders before files at same level
    if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;

    // Then alphabetically (case-insensitive)
    return a.toLowerCase().localeCompare(b.toLowerCase());
  });

  for (const path of sortedPaths) {
    // Ensure all parent folders exist before processing this path
    ensureAncestors(path);

    const meta = metadata[path];
    const parts = path.split('/');
    const name = parts.pop()!;
    const parentPath = parts.join('/');
    const isFolder = meta.type === 'folder';

    const node: TreeNode = {
      id: meta.id,
      name,
      path,
      isFolder,
      docId: isFolder ? undefined : meta.id,
    };

    if (isFolder) {
      node.children = [];
      folderMap.set(path, node);
    }

    // Find parent and add to it, or add to root
    if (parentPath && folderMap.has(parentPath)) {
      folderMap.get(parentPath)!.children!.push(node);
    } else {
      root.push(node);
    }
  }

  // Sort children of each folder (folders first, then alphabetical)
  const sortChildren = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    for (const node of nodes) {
      if (node.children) {
        sortChildren(node.children);
      }
    }
  };

  sortChildren(root);

  return root;
}

/**
 * Filter tree nodes by search term.
 * Keeps folders if any descendant matches.
 * Clones nodes to avoid mutation of original tree.
 */
export function filterTree(nodes: TreeNode[], term: string): TreeNode[] {
  if (!term.trim()) return nodes;

  const lowerTerm = term.toLowerCase();
  const result: TreeNode[] = [];

  for (const node of nodes) {
    const nameMatches = node.name.toLowerCase().includes(lowerTerm);

    if (node.isFolder && node.children) {
      // Recursively filter children
      const filteredChildren = filterTree(node.children, term);

      if (filteredChildren.length > 0 || nameMatches) {
        // Clone the folder node with filtered children
        result.push({
          ...node,
          children: filteredChildren,
        });
      }
    } else if (nameMatches) {
      // Clone the file node
      result.push({ ...node });
    }
  }

  return result;
}

/**
 * Collect all folder IDs that contain matching descendants.
 * Used to auto-expand folders during search.
 */
export function getFolderIdsWithMatches(nodes: TreeNode[], term: string): Set<string> {
  const ids = new Set<string>();
  if (!term.trim()) return ids;

  const lowerTerm = term.toLowerCase();

  const checkNode = (node: TreeNode): boolean => {
    const nameMatches = node.name.toLowerCase().includes(lowerTerm);

    if (node.isFolder && node.children) {
      const hasMatchingDescendant = node.children.some(checkNode);
      if (hasMatchingDescendant) {
        ids.add(node.id);
      }
      return nameMatches || hasMatchingDescendant;
    }

    return nameMatches;
  };

  nodes.forEach(checkNode);
  return ids;
}
