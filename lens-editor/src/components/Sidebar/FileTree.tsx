import { Tree, type NodeApi } from 'react-arborist';
import { FileTreeNode } from './FileTreeNode';
import type { TreeNode } from '../../lib/tree-utils';

interface FileTreeProps {
  data: TreeNode[];
  onSelect?: (docId: string) => void;
  onMove?: (dragNodes: NodeApi<TreeNode>[], parentNode: NodeApi<TreeNode> | null) => void;
  openAll?: boolean;
}

export function FileTree({ data, onSelect, onMove, openAll }: FileTreeProps) {
  return (
    <Tree<TreeNode>
      data={data}
      openByDefault={true}
      indent={16}
      rowHeight={28}
      width="100%"
      height={600}
      overscanCount={5}
      disableDrag={(data: TreeNode) => !data || data.isFolder}
      disableDrop={({ parentNode, dragNodes }) => {
        // Reject drops on leaf nodes (files); allow folders and synthetic root
        if (!parentNode.isInternal) return true;
        // No-op: dropping onto current parent
        const dragNode = dragNodes[0];
        if (dragNode && dragNode.parent?.id === parentNode.id) return true;
        return false;
      }}
      onMove={({ dragNodes, parentNode }) => onMove?.(dragNodes, parentNode)}
      disableMultiSelection
      onSelect={(nodes) => {
        if (nodes.length === 1 && !nodes[0].data.isFolder && nodes[0].data.docId) {
          onSelect?.(nodes[0].data.docId);
        }
      }}
    >
      {FileTreeNode}
    </Tree>
  );
}
