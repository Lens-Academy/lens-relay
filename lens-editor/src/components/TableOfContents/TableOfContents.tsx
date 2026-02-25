import { useState, useRef, useEffect, useCallback } from 'react';
import { EditorView } from '@codemirror/view';
import {
  useHeadings,
  scrollToHeading,
  normalizeHeadingLevels,
  useActiveHeading,
} from './useHeadings';
import type { NormalizedHeading } from './useHeadings';

interface TableOfContentsProps {
  view: EditorView | null;
  stateVersion?: number;  // Incremented on doc changes - triggers re-extraction
}

const INDENT_SIZE = 12;

/** Style presets per normalized display level */
const LEVEL_STYLES: Record<number, string> = {
  1: 'text-[13px] font-semibold text-gray-900',
  2: 'text-[12.5px] font-medium text-gray-800',
  3: 'text-[12px] font-normal text-gray-700',
  4: 'text-[11.5px] font-normal text-gray-500',
};
const LEVEL_STYLE_DEFAULT = 'text-[11px] font-normal text-gray-400';

function getLevelStyle(displayLevel: number): string {
  return LEVEL_STYLES[displayLevel] ?? LEVEL_STYLE_DEFAULT;
}

export function TableOfContents({ view, stateVersion }: TableOfContentsProps) {
  // stateVersion triggers re-render, not directly used in computation
  void stateVersion;

  const headings = useHeadings(view);
  const normalized = normalizeHeadingLevels(headings);
  const activeIndex = useActiveHeading(view, headings);
  const activeRef = useRef<HTMLLIElement | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());

  const toggleCollapse = useCallback((from: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(from)) {
        next.delete(from);
      } else {
        next.add(from);
      }
      return next;
    });
  }, []);

  // Auto-scroll the active heading into view within the TOC panel
  useEffect(() => {
    if (activeRef.current) {
      activeRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [activeIndex]);

  const handleClick = useCallback(
    (heading: NormalizedHeading) => {
      if (view) {
        scrollToHeading(view, heading);
      }
    },
    [view],
  );

  // Compute visibility and hasChildren
  const visibleIndices: number[] = [];
  const hasChildren = new Set<number>();

  // First pass: determine which headings have children
  for (let i = 0; i < normalized.length; i++) {
    if (i + 1 < normalized.length && normalized[i + 1].displayLevel > normalized[i].displayLevel) {
      hasChildren.add(i);
    }
  }

  // Second pass: compute visibility using hideBelow threshold
  {
    let hideBelow = Infinity;
    for (let i = 0; i < normalized.length; i++) {
      const level = normalized[i].displayLevel;
      if (level <= hideBelow) {
        // This item is visible — reset threshold
        hideBelow = Infinity;
        visibleIndices.push(i);
        // If this visible item is collapsed, hide everything deeper
        if (collapsed.has(normalized[i].from)) {
          hideBelow = level;
        }
      }
      // else: level > hideBelow → hidden, skip
    }
  }

  if (!view) {
    return (
      <div className="toc-panel p-3 text-sm text-gray-500">
        No document open
      </div>
    );
  }

  if (normalized.length === 0) {
    return (
      <div className="toc-panel p-3 text-sm text-gray-500">
        No headings in document
      </div>
    );
  }

  return (
    <div className="toc-panel">
      <h3 className="px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider border-b border-gray-200">
        Table of Contents
      </h3>
      <ul className="py-2">
        {visibleIndices.map((index) => {
          const heading = normalized[index];
          const isActive = index === activeIndex;
          const isParent = hasChildren.has(index);
          const isCollapsed = collapsed.has(heading.from);
          const guideCount = heading.displayLevel - 1;

          // Build vertical guide line spans
          const guides = [];
          for (let g = 0; g < guideCount; g++) {
            guides.push(
              <span
                key={g}
                className="flex-shrink-0 relative"
                style={{ width: INDENT_SIZE }}
              >
                <span className="absolute left-[5px] top-0 bottom-0 w-px bg-gray-200" />
              </span>
            );
          }

          return (
            <li
              key={`${heading.from}-${index}`}
              ref={isActive ? activeRef : null}
              className={[
                'flex items-center py-1.5 pr-3 border-l-2 cursor-pointer transition-all duration-150',
                isActive
                  ? 'border-l-indigo-500 bg-indigo-50/60 text-gray-900 font-semibold'
                  : `border-l-transparent hover:border-l-gray-300 hover:bg-gray-50 ${getLevelStyle(heading.displayLevel)}`,
              ].join(' ')}
              title={heading.text}
              onClick={() => handleClick(heading)}
            >
              {guides}
              {isParent ? (
                <svg
                  className={`w-3.5 h-3.5 text-gray-400 transition-transform duration-150 flex-shrink-0 ${isCollapsed ? '' : 'rotate-90'}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleCollapse(heading.from);
                  }}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 5l7 7-7 7"
                  />
                </svg>
              ) : (
                <span className="w-3.5 flex-shrink-0" />
              )}
              <span className="truncate ml-1">{heading.text}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
