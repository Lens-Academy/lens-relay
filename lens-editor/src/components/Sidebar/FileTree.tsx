import { useState, useRef, useCallback, createContext, useContext } from 'react';
import { Tree, type NodeApi } from 'react-arborist';
import { FileTreeNode } from './FileTreeNode';
import type { TreeNode } from '../../lib/tree-utils';

const DragTargetCtx = createContext<string | null>(null);
export const useDragTarget = () => useContext(DragTargetCtx);

interface FileTreeProps {
  data: TreeNode[];
  onSelect?: (docId: string) => void;
  onMove?: (dragNodes: NodeApi<TreeNode>[], parentNode: NodeApi<TreeNode> | null) => void;
  openAll?: boolean;
}

export function FileTree({ data, onSelect, onMove, openAll }: FileTreeProps) {
  const [dragTarget, setDragTarget] = useState<string | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout>>();

  const clearDragTarget = useCallback(() => {
    clearTimeout(clearTimer.current);
    setDragTarget(null);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (tooltipRef.current) {
      tooltipRef.current.style.left = `${e.clientX + 12}px`;
      tooltipRef.current.style.top = `${e.clientY - 8}px`;
    }
  }, []);

  return (
    <div onDragEnd={clearDragTarget} onDrop={clearDragTarget} onDragOver={handleDragOver}>
      {dragTarget && (
        <div
          ref={tooltipRef}
          className="fixed z-50 px-2 py-1 text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded shadow-sm pointer-events-none whitespace-nowrap"
        >
          Move to: {dragTarget}
        </div>
      )}
      <DragTargetCtx.Provider value={dragTarget}>
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

          // Update drag target indicator
          const path = parentNode.data?.path;
          if (path) {
            clearTimeout(clearTimer.current);
            setDragTarget(path);
            clearTimer.current = setTimeout(() => setDragTarget(null), 500);
          }

          return false;
        }}
        onMove={({ dragNodes, parentNode }) => {
          clearDragTarget();
          onMove?.(dragNodes, parentNode);
        }}
        disableMultiSelection
        onSelect={(nodes) => {
          if (nodes.length === 1 && !nodes[0].data.isFolder && nodes[0].data.docId) {
            onSelect?.(nodes[0].data.docId);
          }
        }}
      >
        {FileTreeNode}
      </Tree>
      </DragTargetCtx.Provider>
    </div>
  );
}
