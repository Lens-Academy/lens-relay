import { useState, useEffect, useCallback, useRef } from 'react';
import type { TreeApi, NodeApi } from 'react-arborist';
import type { TreeNode } from '../../lib/tree-utils';

const ROW_HEIGHT = 28; // Must match FileTree's rowHeight prop
const INDENT_SIZE = 16; // Must match FileTree's indent prop
const MAX_STICKY_DEPTH = 5;

interface StickyNode {
  id: string;
  name: string;
  level: number;
  isOpen: boolean;
  /** Vertical offset in px from top of overlay */
  top: number;
}

interface StickyScrollOverlayProps {
  treeApi: TreeApi<TreeNode> | undefined;
}

/**
 * Collect ancestor folder chain for a given node.
 * If the node itself is an open folder, include it.
 * Returns ancestors from shallowest to deepest, capped at MAX_STICKY_DEPTH.
 */
function getAncestorFolders(node: NodeApi<TreeNode>): NodeApi<TreeNode>[] {
  const ancestors: NodeApi<TreeNode>[] = [];
  let current: NodeApi<TreeNode> | null = node;

  if (current.isInternal && current.isOpen) {
    ancestors.unshift(current);
    current = current.parent;
  } else {
    current = current.parent;
  }

  while (current && current.level >= 0) {
    ancestors.unshift(current);
    current = current.parent;
  }

  return ancestors.slice(0, MAX_STICKY_DEPTH);
}

/**
 * Find the last visible row index that belongs to a node's subtree.
 * Searches forward through visibleNodes from startIndex.
 */
function findLastDescendantIndex(
  visibleNodes: NodeApi<TreeNode>[],
  ancestorLevel: number,
  startIndex: number,
): number {
  let lastIndex = startIndex;
  for (let i = startIndex + 1; i < visibleNodes.length; i++) {
    if (visibleNodes[i].level <= ancestorLevel) break;
    lastIndex = i;
  }
  return lastIndex;
}

export function StickyScrollOverlay({ treeApi }: StickyScrollOverlayProps) {
  const [stickyNodes, setStickyNodes] = useState<StickyNode[]>([]);
  const [scrollbarWidth, setScrollbarWidth] = useState(0);
  const rafRef = useRef<number>(0);

  const computeSticky = useCallback(() => {
    if (!treeApi) return;
    const scrollEl = treeApi.listEl.current;
    if (!scrollEl) return;

    const visibleNodes = treeApi.visibleNodes;
    if (visibleNodes.length === 0) {
      setStickyNodes([]);
      return;
    }

    const scrollTop = scrollEl.scrollTop;
    const topIndex = Math.floor(scrollTop / ROW_HEIGHT);

    if (topIndex < 0 || topIndex >= visibleNodes.length) {
      setStickyNodes([]);
      return;
    }

    // Step 1: Base ancestors from the raw scroll top (floor-based for stability).
    // Using floor keeps the ancestor list stable across the full row height,
    // giving push-up animation time to slide headers out smoothly.
    const topNode = visibleNodes[topIndex];
    const baseAncestors = getAncestorFolders(topNode);

    // Step 2: Check the overlay edge for incoming nested folders.
    // A nested folder should become sticky as soon as its header scrolls
    // behind the existing overlay, not when it reaches the raw scroll top.
    let ancestors = baseAncestors;
    const overlayHeight = baseAncestors.length * ROW_HEIGHT;
    const edgeScrollPos = scrollTop + overlayHeight;
    const edgeIndex = Math.floor(edgeScrollPos / ROW_HEIGHT);

    if (edgeIndex < visibleNodes.length && edgeIndex !== topIndex) {
      const edgeAncestors = getAncestorFolders(visibleNodes[edgeIndex]);
      if (edgeAncestors.length > baseAncestors.length) {
        const extended = [...baseAncestors];
        for (let i = baseAncestors.length; i < edgeAncestors.length && i < MAX_STICKY_DEPTH; i++) {
          const candidate = edgeAncestors[i];
          const headerPos = (candidate.rowIndex ?? 0) * ROW_HEIGHT;
          // Only add if the folder's header has scrolled past the overlay edge
          if (headerPos < edgeScrollPos) {
            extended.push(candidate);
          }
        }
        ancestors = extended;
      }
    }

    if (ancestors.length === 0) {
      setStickyNodes([]);
      return;
    }

    // Step 3: Compute viewport-based positions for each ancestor.
    // Each header sits at its slot (i * ROW_HEIGHT) but gets pushed up when
    // its section's last descendant approaches. The header tracks the last
    // descendant's viewport position, sliding continuously past y=0 and
    // eventually off-screen.
    const result: StickyNode[] = [];

    for (let i = 0; i < ancestors.length; i++) {
      const ancestor = ancestors[i];
      const slotTop = i * ROW_HEIGHT;

      // Search from the ancestor's own position or topIndex, whichever is later.
      // This is important for "incoming" headers whose subtree starts below topIndex.
      const searchStart = Math.max(topIndex, ancestor.rowIndex ?? 0);
      const lastDescIdx = findLastDescendantIndex(visibleNodes, ancestor.level, searchStart);
      const lastDescViewportBottom = (lastDescIdx + 1) * ROW_HEIGHT - scrollTop;

      // Header stays at slot until section end approaches, then slides up
      const top = Math.min(slotTop, lastDescViewportBottom - ROW_HEIGHT);

      result.push({
        id: ancestor.id,
        name: ancestor.data.name,
        level: ancestor.level,
        isOpen: ancestor.isOpen,
        top,
      });
    }

    setStickyNodes(result);
  }, [treeApi]);

  // Attach scroll listener to react-arborist's internal scroll container
  useEffect(() => {
    if (!treeApi) return;
    const scrollEl = treeApi.listEl.current;
    if (!scrollEl) return;

    const handleScroll = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(computeSticky);
    };

    // Measure scrollbar width (varies by OS/browser)
    setScrollbarWidth(scrollEl.offsetWidth - scrollEl.clientWidth);

    computeSticky();

    scrollEl.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      scrollEl.removeEventListener('scroll', handleScroll);
      cancelAnimationFrame(rafRef.current);
    };
  }, [treeApi, computeSticky]);

  // Recompute when tree structure changes (expand/collapse)
  useEffect(() => {
    computeSticky();
  }, [treeApi?.visibleNodes.length, computeSticky]);

  const handleClick = useCallback((nodeId: string) => {
    if (!treeApi) return;
    const node = treeApi.get(nodeId);
    if (!node) return;
    node.toggle();
    treeApi.scrollTo(nodeId, 'smart');
    requestAnimationFrame(computeSticky);
  }, [treeApi, computeSticky]);

  if (stickyNodes.length === 0) return null;

  // Container height tracks the bottommost visible edge of all headers.
  // This shrinks smoothly as headers slide out instead of jumping by ROW_HEIGHT.
  const containerHeight = Math.max(0, ...stickyNodes.map(n => n.top + ROW_HEIGHT));

  return (
    <div
      className="absolute top-0 left-0 z-10 pointer-events-none overflow-hidden"
      style={{ height: containerHeight, right: scrollbarWidth }}
    >
      {stickyNodes.map((node, i) => (
        <div
          key={node.id}
          className={`absolute left-0 right-0 flex items-center py-0.5 pr-2 cursor-pointer select-none
                     bg-[#f6f6f6] hover:bg-gray-100 pointer-events-auto
                     `}
          style={{
            top: node.top,
            height: ROW_HEIGHT,
            zIndex: MAX_STICKY_DEPTH - i,
          }}
          onClick={() => handleClick(node.id)}
        >
          {/* Indentation guides */}
          {Array.from({ length: node.level }, (_, i) => (
            <span
              key={i}
              className="flex-shrink-0 relative"
              style={{ width: INDENT_SIZE }}
            >
              <span className="absolute left-[7px] top-0 bottom-0 w-px bg-gray-200" />
            </span>
          ))}

          {/* Chevron */}
          <svg
            className={`w-4 h-4 text-gray-500 transition-transform flex-shrink-0 ml-1
                        ${node.isOpen ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>

          {/* Folder icon */}
          <svg
            className="w-4 h-4 text-gray-500 flex-shrink-0 ml-0.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>

          {/* Name */}
          <span className="truncate text-sm text-gray-700 ml-1">
            {node.name}
          </span>
        </div>
      ))}
    </div>
  );
}
