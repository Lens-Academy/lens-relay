import { useState, useRef, useCallback, useEffect, useMemo, createContext, useContext } from 'react';
import { Tree, TreeApi, type NodeApi } from 'react-arborist';
import { FileTreeNode } from './FileTreeNode';
import type { TreeNode } from '../../lib/tree-utils';

const DragTargetCtx = createContext<string | null>(null);
export const useDragTarget = () => useContext(DragTargetCtx);

/** Walk tree to find ancestor folder node IDs for a given docId. */
function getAncestorFolderIds(nodes: TreeNode[], targetDocId: string): string[] {
  const ids: string[] = [];
  const walk = (node: TreeNode, ancestors: string[]): boolean => {
    if (!node.isFolder && node.docId === targetDocId) {
      ids.push(...ancestors);
      return true;
    }
    if (node.children) {
      for (const child of node.children) {
        if (walk(child, [...ancestors, node.id])) return true;
      }
    }
    return false;
  };
  for (const node of nodes) walk(node, []);
  return ids;
}

interface FileTreeProps {
  data: TreeNode[];
  onSelect?: (docId: string) => void;
  onMove?: (dragNodes: NodeApi<TreeNode>[], parentNode: NodeApi<TreeNode> | null) => void;
  openAll?: boolean;
  activeDocId?: string;
}

export function FileTree({ data, onSelect, onMove, openAll, activeDocId }: FileTreeProps) {
  const [dragTarget, setDragTarget] = useState<string | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<TreeApi<TreeNode>>();
  const clearTimer = useRef<ReturnType<typeof setTimeout>>();

  // Dynamic height: measure container to feed react-arborist's required pixel height
  const containerRef = useRef<HTMLDivElement>(null);
  const [treeHeight, setTreeHeight] = useState(600);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setTreeHeight(entry.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Compute initial open state: top-level folders + ancestors of active doc
  // (Only used on first mount to avoid a flash of collapsed state)
  const initialOpenState = useMemo(() => {
    if (openAll) return undefined; // let openByDefault handle it
    const state: Record<string, boolean> = {};
    for (const node of data) {
      if (node.isFolder) state[node.id] = true;
    }
    if (activeDocId) {
      for (const id of getAncestorFolderIds(data, activeDocId)) {
        state[id] = true;
      }
    }
    return state;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally empty — only for first mount

  // Keep top-level folders expanded as data changes (node IDs may change
  // from synthetic to real as metadata streams in)
  useEffect(() => {
    if (!treeRef.current || openAll) return;
    for (const node of data) {
      if (node.isFolder) {
        treeRef.current.open(node.id);
      }
    }
  }, [data, openAll]);

  // Auto-reveal: when activeDocId changes, open ancestor folders
  useEffect(() => {
    if (!activeDocId || !treeRef.current || openAll) return;
    const ancestorIds = getAncestorFolderIds(data, activeDocId);
    for (const id of ancestorIds) {
      treeRef.current.open(id);
    }
  }, [activeDocId, data, openAll]);

  const clearDragTarget = useCallback(() => {
    clearTimeout(clearTimer.current);
    setDragTarget(null);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (tooltipRef.current) {
      tooltipRef.current.style.left = `${e.clientX + 12}px`;
      tooltipRef.current.style.top = `${e.clientY - 8}px`;
    }
    // Auto-scroll tree when dragging near top/bottom edges
    const scrollEl = treeRef.current?.listEl?.current;
    if (scrollEl) {
      const rect = scrollEl.getBoundingClientRect();
      const threshold = 40;
      const speed = 8;
      if (e.clientY < rect.top + threshold) {
        scrollEl.scrollTop -= speed;
      } else if (e.clientY > rect.bottom - threshold) {
        scrollEl.scrollTop += speed;
      }
    }
  }, []);

  return (
    <div className="h-full" ref={containerRef} onDragEnd={clearDragTarget} onDrop={clearDragTarget} onDragOver={handleDragOver}>
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
        ref={treeRef}
        data={data}
        openByDefault={!!openAll}
        initialOpenState={initialOpenState}
        indent={16}
        rowHeight={28}
        width="100%"
        height={treeHeight}
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
