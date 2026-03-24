import { useEffect, useRef, useCallback } from 'react';
import type { TreeApi, NodeApi } from 'react-arborist';
import type { TreeNode } from '../../lib/tree-utils';

const ROW_HEIGHT = 28; // Must match FileTree's rowHeight prop
const INDENT_SIZE = 16; // Must match FileTree's indent prop
const MAX_STICKY_DEPTH = 5;

interface StickyScrollOverlayProps {
  treeApi: TreeApi<TreeNode> | undefined;
}

// ── Computation (unchanged from React version) ──────────────────────

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

interface ComputedHeader {
  id: string;
  name: string;
  level: number;
  isOpen: boolean;
  top: number;
}

function computeStickyHeaders(
  visibleNodes: NodeApi<TreeNode>[],
  scrollTop: number,
): ComputedHeader[] {
  const topIndex = Math.floor(scrollTop / ROW_HEIGHT);

  if (topIndex < 0 || topIndex >= visibleNodes.length) return [];

  const topNode = visibleNodes[topIndex];
  const baseAncestors = getAncestorFolders(topNode);

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
        if (headerPos < edgeScrollPos) {
          extended.push(candidate);
        }
      }
      ancestors = extended;
    }
  }

  if (ancestors.length === 0) return [];

  const result: ComputedHeader[] = [];

  for (let i = 0; i < ancestors.length; i++) {
    const ancestor = ancestors[i];
    const slotTop = i * ROW_HEIGHT;
    const searchStart = Math.max(topIndex, ancestor.rowIndex ?? 0);
    const lastDescIdx = findLastDescendantIndex(visibleNodes, ancestor.level, searchStart);
    const lastDescViewportBottom = (lastDescIdx + 1) * ROW_HEIGHT - scrollTop;
    const top = Math.min(slotTop, lastDescViewportBottom - ROW_HEIGHT);

    result.push({
      id: ancestor.id,
      name: ancestor.data.name,
      level: ancestor.level,
      isOpen: ancestor.isOpen,
      top,
    });
  }

  return result;
}

// ── View holder for a single pre-allocated header row ───────────────

interface RowHolder {
  root: HTMLDivElement;
  indentGuides: HTMLSpanElement[];
  chevron: SVGSVGElement;
  folderIcon: SVGSVGElement;
  nameSpan: HTMLSpanElement;
}

function createRowElement(slot: number): RowHolder {
  const root = document.createElement('div');
  root.style.position = 'absolute';
  root.style.left = '0';
  root.style.right = '0';
  root.style.height = `${ROW_HEIGHT}px`;
  root.style.display = 'none';
  root.style.alignItems = 'center';
  root.style.paddingRight = '8px';
  root.style.paddingTop = '2px';
  root.style.paddingBottom = '2px';
  root.style.cursor = 'pointer';
  root.style.userSelect = 'none';
  root.style.backgroundColor = '#f6f6f6';
  root.style.pointerEvents = 'auto';
  root.style.zIndex = String(MAX_STICKY_DEPTH - slot);

  root.addEventListener('mouseenter', () => { root.style.backgroundColor = '#f3f4f6'; });
  root.addEventListener('mouseleave', () => { root.style.backgroundColor = '#f6f6f6'; });

  // Pre-allocate indent guides (max depth, hide extras)
  const indentGuides: HTMLSpanElement[] = [];
  for (let i = 0; i < MAX_STICKY_DEPTH; i++) {
    const guide = document.createElement('span');
    guide.style.flexShrink = '0';
    guide.style.position = 'relative';
    guide.style.width = `${INDENT_SIZE}px`;
    guide.style.display = 'none';

    const line = document.createElement('span');
    line.style.position = 'absolute';
    line.style.left = '7px';
    line.style.top = '0';
    line.style.bottom = '0';
    line.style.width = '1px';
    line.style.backgroundColor = '#e5e7eb'; // gray-200

    guide.appendChild(line);
    root.appendChild(guide);
    indentGuides.push(guide);
  }

  // Chevron SVG (no transition — imperative updates must snap, not animate)
  const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chevron.setAttribute('viewBox', '0 0 24 24');
  chevron.setAttribute('fill', 'none');
  chevron.setAttribute('stroke', 'currentColor');
  chevron.style.width = '16px';
  chevron.style.height = '16px';
  chevron.style.color = '#6b7280'; // gray-500
  chevron.style.flexShrink = '0';
  chevron.style.marginLeft = '4px';
  const chevronPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  chevronPath.setAttribute('stroke-linecap', 'round');
  chevronPath.setAttribute('stroke-linejoin', 'round');
  chevronPath.setAttribute('stroke-width', '2');
  chevronPath.setAttribute('d', 'M9 5l7 7-7 7');
  chevron.appendChild(chevronPath);
  root.appendChild(chevron);

  // Folder icon SVG
  const folderIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  folderIcon.setAttribute('viewBox', '0 0 24 24');
  folderIcon.setAttribute('fill', 'none');
  folderIcon.setAttribute('stroke', 'currentColor');
  folderIcon.style.width = '16px';
  folderIcon.style.height = '16px';
  folderIcon.style.color = '#6b7280'; // gray-500
  folderIcon.style.flexShrink = '0';
  folderIcon.style.marginLeft = '2px';
  const folderPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  folderPath.setAttribute('stroke-linecap', 'round');
  folderPath.setAttribute('stroke-linejoin', 'round');
  folderPath.setAttribute('stroke-width', '2');
  folderPath.setAttribute('d', 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z');
  folderIcon.appendChild(folderPath);
  root.appendChild(folderIcon);

  // Name span
  const nameSpan = document.createElement('span');
  nameSpan.style.overflow = 'hidden';
  nameSpan.style.textOverflow = 'ellipsis';
  nameSpan.style.whiteSpace = 'nowrap';
  nameSpan.style.fontSize = '14px';
  nameSpan.style.lineHeight = '20px';
  nameSpan.style.color = '#374151'; // gray-700
  nameSpan.style.marginLeft = '4px';
  root.appendChild(nameSpan);

  return { root, indentGuides, chevron, folderIcon, nameSpan };
}

// ── React component (thin shell — all scroll work is imperative) ────

export function StickyScrollOverlay({ treeApi }: StickyScrollOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<RowHolder[]>([]);
  const prevIdsRef = useRef<string[]>([]);
  const rafRef = useRef<number>(0);

  // Build the pre-allocated row pool once on mount
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const rows: RowHolder[] = [];
    for (let i = 0; i < MAX_STICKY_DEPTH; i++) {
      const holder = createRowElement(i);
      container.appendChild(holder.root);
      rows.push(holder);
    }
    rowsRef.current = rows;

    return () => {
      // Cleanup: remove all pre-allocated elements
      for (const row of rows) {
        row.root.remove();
      }
      rowsRef.current = [];
    };
  }, []);

  // The imperative update function — called from rAF, never triggers React render
  const updateDOM = useCallback(() => {
    if (!treeApi) return;
    const scrollEl = treeApi.listEl.current;
    if (!scrollEl) return;
    const container = containerRef.current;
    if (!container) return;
    const rows = rowsRef.current;
    if (rows.length === 0) return;

    // Recalculate scrollbar inset (scrollbar may appear/disappear on expand/collapse)
    container.style.right = `${scrollEl.offsetWidth - scrollEl.clientWidth}px`;

    const visibleNodes = treeApi.visibleNodes;
    const scrollTop = scrollEl.scrollTop;
    const headers = visibleNodes.length > 0
      ? computeStickyHeaders(visibleNodes, scrollTop)
      : [];

    // Fast path: if same set of ancestor IDs, only update positions
    const currentIds = headers.map(h => h.id);
    const prevIds = prevIdsRef.current;
    const sameIds = currentIds.length === prevIds.length &&
      currentIds.every((id, i) => id === prevIds[i]);

    if (sameIds && headers.length > 0) {
      // Position + chevron update (common case during smooth scroll)
      let maxBottom = 0;
      for (let i = 0; i < headers.length; i++) {
        rows[i].root.style.transform = `translateY(${headers[i].top}px)`;
        rows[i].chevron.style.transform = headers[i].isOpen ? 'rotate(90deg)' : '';
        maxBottom = Math.max(maxBottom, headers[i].top + ROW_HEIGHT);
      }
      container.style.height = `${Math.max(0, maxBottom)}px`;
      return;
    }

    // Slow path: full update (ancestor set changed)
    prevIdsRef.current = currentIds;

    let maxBottom = 0;
    for (let i = 0; i < MAX_STICKY_DEPTH; i++) {
      const row = rows[i];
      if (i < headers.length) {
        const h = headers[i];
        row.root.style.transform = `translateY(${h.top}px)`;
        row.root.style.display = 'flex';
        row.root.dataset.nodeId = h.id;

        // Update indent guides
        for (let g = 0; g < MAX_STICKY_DEPTH; g++) {
          row.indentGuides[g].style.display = g < h.level ? 'block' : 'none';
        }

        // Chevron rotation (no transition — snaps immediately)
        row.chevron.style.transform = h.isOpen ? 'rotate(90deg)' : '';

        // Name
        row.nameSpan.textContent = h.name;

        maxBottom = Math.max(maxBottom, h.top + ROW_HEIGHT);
      } else {
        row.root.style.display = 'none';
      }
    }

    container.style.height = `${Math.max(0, maxBottom)}px`;
  }, [treeApi]);

  // Attach scroll listener + measure scrollbar
  useEffect(() => {
    if (!treeApi) return;
    const scrollEl = treeApi.listEl.current;
    if (!scrollEl) return;
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(updateDOM);
    };

    // Initial render
    updateDOM();

    scrollEl.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      scrollEl.removeEventListener('scroll', handleScroll);
      cancelAnimationFrame(rafRef.current);
    };
  }, [treeApi, updateDOM]);

  // Recompute on tree structure changes (expand/collapse).
  // The parent re-renders on tree mutations, which re-renders this component
  // with the same props, triggering this effect. This is acceptable since
  // tree mutations are infrequent (not during scroll).
  useEffect(() => {
    updateDOM();
  }, [treeApi?.visibleNodes.length, updateDOM]);

  // Click handler via event delegation
  const handleClick = useCallback((e: React.MouseEvent) => {
    if (!treeApi) return;
    const target = (e.target as HTMLElement).closest('[data-node-id]') as HTMLElement | null;
    if (!target) return;
    const nodeId = target.dataset.nodeId;
    if (!nodeId) return;

    const node = treeApi.get(nodeId);
    if (!node) return;
    node.toggle();
    treeApi.scrollTo(nodeId, 'smart');
    // Recompute immediately after toggle
    requestAnimationFrame(() => updateDOM());
  }, [treeApi, updateDOM]);

  // Always render container (never null) — pre-allocated elements live here
  return (
    <div
      ref={containerRef}
      onClick={handleClick}
      style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, pointerEvents: 'none', overflow: 'hidden', height: 0 }}
    />
  );
}
