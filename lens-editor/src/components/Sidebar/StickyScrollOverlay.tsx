import { useEffect, useRef, useCallback, type MutableRefObject } from 'react';
import type { TreeApi, NodeApi } from 'react-arborist';
import type { TreeNode } from '../../lib/tree-utils';
import { useFileTreeContext } from './FileTreeContext';
import type { TemplateOption } from '../../lib/templates';
import { CHEVRON_SVG, FOLDER_ICON_SVG, TREE_ROW_HEIGHT, treeItemPadding } from './treeLayout';

const ROW_HEIGHT = TREE_ROW_HEIGHT;
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
  path: string;
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
  // Only show sticky headers for folders whose rows have scrolled above the viewport top.
  // Without this filter, a folder at rowIndex=0 (scrollTop=0) renders a duplicate sticky
  // row at y=0 that covers the real row and hides its + button.
  const baseAncestors = getAncestorFolders(topNode).filter(
    ancestor => (ancestor.rowIndex ?? 0) * ROW_HEIGHT < scrollTop
  );

  let ancestors = baseAncestors;
  const overlayHeight = baseAncestors.length * ROW_HEIGHT;
  const edgeScrollPos = scrollTop + overlayHeight;
  const edgeIndex = Math.floor(edgeScrollPos / ROW_HEIGHT);

  if (edgeIndex < visibleNodes.length && edgeIndex !== topIndex) {
    const edgeAncestors = getAncestorFolders(visibleNodes[edgeIndex]);
    const merged = [...baseAncestors];

    for (let i = 0; i < Math.max(merged.length, edgeAncestors.length) && i < MAX_STICKY_DEPTH; i++) {
      if (i >= edgeAncestors.length) break;

      const edgeAnc = edgeAncestors[i];

      // Same ancestor at this depth — keep it
      if (i < merged.length && merged[i].id === edgeAnc.id) continue;

      // Different ancestor (sibling replacement) or deeper ancestor (new level).
      // Only add/replace if its header has scrolled past the overlay edge.
      const headerPos = (edgeAnc.rowIndex ?? 0) * ROW_HEIGHT;
      if (headerPos >= edgeScrollPos) break;

      // Replace from this depth onward with edge ancestors
      merged.length = i;
      for (let j = i; j < edgeAncestors.length && j < MAX_STICKY_DEPTH; j++) {
        const deeperPos = (edgeAncestors[j].rowIndex ?? 0) * ROW_HEIGHT;
        if (deeperPos >= edgeScrollPos) break;
        merged.push(edgeAncestors[j]);
      }
      break;
    }

    ancestors = merged;
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
      path: ancestor.data.path,
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
  item: HTMLDivElement;
  icon: HTMLSpanElement;
  sectionChevron: HTMLSpanElement;
  nameSpan: HTMLSpanElement;
  createWrapper: HTMLDivElement;
  createButton: HTMLButtonElement;
  createMenu: HTMLDivElement;
  newFileButton: HTMLButtonElement;
  templatesButton: HTMLButtonElement;
  templatesList: HTMLDivElement;
  newFolderButton: HTMLButtonElement;
}

interface CreateCallbacks {
  onCreateDocument?: (folderPath: string) => void;
  onCreateFolder?: (folderPath: string) => void;
  getTemplates?: (folderPath: string) => TemplateOption[];
  onCreateFromTemplate?: (folderPath: string, template: TemplateOption) => void;
}

function createMenuItem(label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.className = 'lens-create-item';
  return button;
}

/**
 * A sticky folder header, built like a FileTreeNode row (the lens-tree-*
 * classes in index.css): the folder's icon (open, since its rows are below),
 * the name, and the create button. A shared folder is a section label.
 */
function createRowElement(
  slot: number,
  callbacksRef: MutableRefObject<CreateCallbacks>,
  openMenuRef: MutableRefObject<HTMLDivElement | null>,
): RowHolder {
  const root = document.createElement('div');
  root.className = 'lens-tree-row lens-tree-sticky';
  root.style.position = 'absolute';
  root.style.left = '0';
  root.style.right = '0';
  root.style.height = `${ROW_HEIGHT}px`;
  root.style.display = 'none';
  root.style.cursor = 'pointer';
  root.style.userSelect = 'none';
  root.style.pointerEvents = 'auto';
  root.style.zIndex = String(MAX_STICKY_DEPTH - slot);

  const item = document.createElement('div');
  item.className = 'lens-tree-item';
  root.appendChild(item);

  // No transitions: imperative updates must snap, not animate
  const icon = document.createElement('span');
  icon.className = 'lens-tree-icon is-folder lens-tree-snap';
  icon.innerHTML = FOLDER_ICON_SVG;
  item.appendChild(icon);

  // Name span
  const nameSpan = document.createElement('span');
  nameSpan.className = 'lens-tree-name truncate';
  item.appendChild(nameSpan);

  const sectionChevron = document.createElement('span');
  sectionChevron.className = 'lens-tree-section-chevron lens-tree-snap';
  sectionChevron.innerHTML = CHEVRON_SVG;
  item.appendChild(sectionChevron);

  const createWrapper = document.createElement('div');
  createWrapper.className = 'lens-tree-actions';
  createWrapper.style.marginLeft = 'auto';
  createWrapper.style.flexShrink = '0';
  createWrapper.style.display = 'none';

  const createButton = document.createElement('button');
  createButton.type = 'button';
  createButton.className = 'lens-tree-action';
  createButton.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const path = root.dataset.nodePath;
    if (!path) return;

    const existing = openMenuRef.current;
    if (existing && existing !== createMenu) {
      existing.style.display = 'none';
      delete existing.dataset.nodePath;
    }

    if (createMenu.style.display === 'block') {
      createMenu.style.display = 'none';
      delete createMenu.dataset.nodePath;
      openMenuRef.current = null;
      return;
    }

    const { getTemplates, onCreateFromTemplate } = callbacksRef.current;
    const templates = onCreateFromTemplate && getTemplates ? getTemplates(path) : [];
    templatesButton.style.display = templates.length > 0 ? 'flex' : 'none';
    templatesButton.setAttribute('aria-expanded', 'false');
    templatesChevron.style.transform = '';
    templatesList.style.display = 'none';
    templatesList.replaceChildren(...templates.map((template) => {
      const item = createMenuItem(template.name);
      item.title = template.path;
      item.style.paddingLeft = '24px';
      item.style.overflow = 'hidden';
      item.style.textOverflow = 'ellipsis';
      item.style.whiteSpace = 'nowrap';
      item.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const folderPath = createMenu.dataset.nodePath;
        if (folderPath) callbacksRef.current.onCreateFromTemplate?.(folderPath, template);
        createMenu.style.display = 'none';
        delete createMenu.dataset.nodePath;
        openMenuRef.current = null;
      });
      return item;
    }));

    const rect = createButton.getBoundingClientRect();
    createMenu.dataset.nodePath = path;
    createMenu.style.left = `${Math.max(0, rect.right - 140)}px`;
    createMenu.style.top = `${rect.bottom + 4}px`;
    createMenu.style.display = 'block';
    openMenuRef.current = createMenu;
  });

  const plusIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  plusIcon.setAttribute('viewBox', '0 0 24 24');
  plusIcon.setAttribute('fill', 'none');
  plusIcon.setAttribute('stroke', 'currentColor');
  plusIcon.setAttribute('stroke-width', '2');
  plusIcon.style.width = '14px';
  plusIcon.style.height = '14px';
  const plusPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  plusPath.setAttribute('stroke-linecap', 'round');
  plusPath.setAttribute('stroke-linejoin', 'round');
  plusPath.setAttribute('d', 'M12 4v16m8-8H4');
  plusIcon.appendChild(plusPath);
  createButton.appendChild(plusIcon);
  createWrapper.appendChild(createButton);
  item.appendChild(createWrapper);

  const createMenu = document.createElement('div');
  createMenu.className = 'lens-popover';
  createMenu.style.position = 'fixed';
  createMenu.style.display = 'none';
  createMenu.style.minWidth = '140px';
  createMenu.style.maxWidth = '260px';
  createMenu.style.padding = '4px';
  createMenu.style.zIndex = '50';
  createMenu.addEventListener('click', e => e.stopPropagation());
  createMenu.addEventListener('mousedown', e => e.stopPropagation());

  const newFileButton = createMenuItem('New File');
  newFileButton.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const path = createMenu.dataset.nodePath;
    if (path) callbacksRef.current.onCreateDocument?.(path);
    createMenu.style.display = 'none';
    delete createMenu.dataset.nodePath;
    openMenuRef.current = null;
  });
  createMenu.appendChild(newFileButton);

  const templatesButton = createMenuItem('New from template');
  templatesButton.style.alignItems = 'center';
  templatesButton.style.justifyContent = 'space-between';
  templatesButton.style.gap = '8px';
  templatesButton.style.whiteSpace = 'nowrap';
  templatesButton.style.display = 'none';
  const templatesChevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  templatesChevron.setAttribute('viewBox', '0 0 24 24');
  templatesChevron.setAttribute('fill', 'none');
  templatesChevron.setAttribute('stroke', 'currentColor');
  templatesChevron.setAttribute('stroke-width', '2');
  templatesChevron.style.width = '12px';
  templatesChevron.style.height = '12px';
  templatesChevron.style.flexShrink = '0';
  templatesChevron.style.color = 'var(--lens-text-tertiary)';
  const templatesChevronPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  templatesChevronPath.setAttribute('stroke-linecap', 'round');
  templatesChevronPath.setAttribute('stroke-linejoin', 'round');
  templatesChevronPath.setAttribute('d', 'M9 5l7 7-7 7');
  templatesChevron.appendChild(templatesChevronPath);
  templatesButton.appendChild(templatesChevron);
  const templatesList = document.createElement('div');
  templatesList.style.display = 'none';
  templatesButton.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const expand = templatesList.style.display === 'none';
    templatesList.style.display = expand ? 'block' : 'none';
    templatesChevron.style.transform = expand ? 'rotate(90deg)' : '';
    templatesButton.setAttribute('aria-expanded', String(expand));
  });
  createMenu.appendChild(templatesButton);
  createMenu.appendChild(templatesList);

  const newFolderButton = createMenuItem('New Folder');
  newFolderButton.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const path = createMenu.dataset.nodePath;
    if (path) callbacksRef.current.onCreateFolder?.(path);
    createMenu.style.display = 'none';
    delete createMenu.dataset.nodePath;
    openMenuRef.current = null;
  });
  createMenu.appendChild(newFolderButton);
  document.body.appendChild(createMenu);

  return { root, item, icon, sectionChevron, nameSpan, createWrapper, createButton, createMenu, newFileButton, templatesButton, templatesList, newFolderButton };
}

// ── React component (thin shell — all scroll work is imperative) ────

export function StickyScrollOverlay({ treeApi }: StickyScrollOverlayProps) {
  const { onCreateDocument, onCreateFolder, getTemplates, onCreateFromTemplate } = useFileTreeContext();
  const containerRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<RowHolder[]>([]);
  const prevIdsRef = useRef<string[]>([]);
  const rafRef = useRef<number>(0);
  const callbacksRef = useRef<CreateCallbacks>({});
  const openMenuRef = useRef<HTMLDivElement | null>(null);
  callbacksRef.current = { onCreateDocument, onCreateFolder, getTemplates, onCreateFromTemplate };

  // Build the pre-allocated row pool once on mount
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const rows: RowHolder[] = [];
    for (let i = 0; i < MAX_STICKY_DEPTH; i++) {
      const holder = createRowElement(i, callbacksRef, openMenuRef);
      container.appendChild(holder.root);
      rows.push(holder);
    }
    rowsRef.current = rows;

    return () => {
      // Cleanup: remove all pre-allocated elements
      for (const row of rows) {
        row.root.remove();
        row.createMenu.remove();
      }
      rowsRef.current = [];
    };
  }, []);

  useEffect(() => {
    const closeMenu = (event: MouseEvent) => {
      const menu = openMenuRef.current;
      if (!menu) return;
      const target = event.target as Node;
      if (menu.contains(target) || rowsRef.current.some(row => row.createWrapper.contains(target))) return;
      menu.style.display = 'none';
      delete menu.dataset.nodePath;
      openMenuRef.current = null;
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !openMenuRef.current) return;
      openMenuRef.current.style.display = 'none';
      delete openMenuRef.current.dataset.nodePath;
      openMenuRef.current = null;
    };
    document.addEventListener('mousedown', closeMenu);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeMenu);
      document.removeEventListener('keydown', closeOnEscape);
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
        rows[i].icon.classList.toggle('is-open', headers[i].isOpen);
        rows[i].sectionChevron.classList.toggle('is-open', headers[i].isOpen);
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
        row.root.dataset.nodePath = h.path;

        // Indent, or a section label for a shared folder
        const section = h.level === 0;
        row.item.style.paddingLeft = `${treeItemPadding(h.level)}px`;
        row.item.classList.toggle('is-section', section);
        row.icon.style.display = section ? 'none' : '';
        row.sectionChevron.style.display = section ? '' : 'none';

        // Open or closed (no transition — snaps immediately)
        row.icon.classList.toggle('is-open', h.isOpen);
        row.sectionChevron.classList.toggle('is-open', h.isOpen);

        // Name
        row.nameSpan.textContent = h.name;
        row.createButton.setAttribute('aria-label', `Create in ${h.name}`);
        row.createWrapper.style.display = callbacksRef.current.onCreateDocument || callbacksRef.current.onCreateFolder ? 'block' : 'none';
        row.newFileButton.style.display = callbacksRef.current.onCreateDocument ? 'block' : 'none';
        row.newFolderButton.style.display = callbacksRef.current.onCreateFolder ? 'block' : 'none';

        maxBottom = Math.max(maxBottom, h.top + ROW_HEIGHT);
      } else {
        row.root.style.display = 'none';
        row.createMenu.style.display = 'none';
        delete row.createMenu.dataset.nodePath;
        if (openMenuRef.current === row.createMenu) openMenuRef.current = null;
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
