import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useNavigation } from '../../contexts/NavigationContext';
import { fuzzyMatch } from '../../lib/fuzzy-match';
import { getFolderNameFromPath } from '../../lib/multi-folder-utils';
import { RELAY_ID } from '../../App';
import { openDocInNewTab } from '../../lib/url-utils';

interface QuickSwitcherProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recentFiles: string[];
  onSelect: (docId: string) => void;
}

interface FileEntry {
  path: string;
  name: string;
  folder: string;
  id: string;
}

/**
 * Render a file name with fuzzy match highlights.
 * Ranges are [start, end) pairs from fuzzyMatch.
 */
function HighlightedName({ name, ranges }: { name: string; ranges: [number, number][] }) {
  if (ranges.length === 0) {
    return <>{name}</>;
  }

  const parts: React.ReactNode[] = [];
  let cursor = 0;

  for (const [start, end] of ranges) {
    if (cursor < start) {
      parts.push(name.slice(cursor, start));
    }
    parts.push(
      <mark key={start} className="bg-yellow-200 text-inherit rounded-sm">
        {name.slice(start, end)}
      </mark>
    );
    cursor = end;
  }

  if (cursor < name.length) {
    parts.push(name.slice(cursor));
  }

  return <>{parts}</>;
}

/**
 * Extract file name without extension from a metadata path.
 * e.g., "/Lens/Introduction.md" -> "Introduction"
 */
function extractFileName(path: string): string {
  const segments = path.split('/');
  const last = segments[segments.length - 1];
  // Strip .md extension
  return last.replace(/\.md$/, '');
}

export function QuickSwitcher({ open, onOpenChange, recentFiles, onSelect }: QuickSwitcherProps) {
  const { metadata, folderNames } = useNavigation();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Build a flat list of non-folder file entries from metadata
  const fileEntries = useMemo(() => {
    const entries: FileEntry[] = [];
    for (const [path, meta] of Object.entries(metadata)) {
      if (meta.type === 'folder') continue;
      const name = extractFileName(path);
      const folder = getFolderNameFromPath(path, folderNames) ?? '';
      entries.push({ path, name, folder, id: meta.id });
    }
    return entries;
  }, [metadata, folderNames]);

  // Build a lookup from doc ID to FileEntry
  const idToEntry = useMemo(() => {
    const map = new Map<string, FileEntry>();
    for (const entry of fileEntries) {
      map.set(entry.id, entry);
    }
    return map;
  }, [fileEntries]);

  // Compute results based on query
  const results = useMemo(() => {
    if (query.trim() === '') {
      return null; // null signals "show recent files" mode
    }

    const scored: { entry: FileEntry; score: number; ranges: [number, number][] }[] = [];
    for (const entry of fileEntries) {
      const result = fuzzyMatch(query, entry.name);
      if (result.match) {
        scored.push({ entry, score: result.score, ranges: result.ranges });
      }
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }, [query, fileEntries]);

  // Resolve recent files to entries (filter out nonexistent)
  const recentEntries = useMemo(() => {
    if (results !== null) return []; // Not in recent mode
    const entries: FileEntry[] = [];
    for (const id of recentFiles) {
      const entry = idToEntry.get(id);
      if (entry) {
        entries.push(entry);
      }
    }
    return entries;
  }, [recentFiles, idToEntry, results]);

  // The displayed items list
  const displayItems = useMemo(() => {
    if (results !== null) {
      return results.map(r => ({
        entry: r.entry,
        ranges: r.ranges,
      }));
    }
    return recentEntries.map(entry => ({
      entry,
      ranges: [] as [number, number][],
    }));
  }, [results, recentEntries]);

  // Reset query and selection when dialog opens
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
    }
  }, [open]);

  // Clamp selection index when results change
  useEffect(() => {
    setSelectedIndex(prev => {
      if (displayItems.length === 0) return 0;
      return Math.min(prev, displayItems.length - 1);
    });
  }, [displayItems.length]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const selected = listRef.current.querySelector('[data-selected="true"]');
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const handleSelect = useCallback((docId: string) => {
    onSelect(docId);
    onOpenChange(false);
  }, [onSelect, onOpenChange]);

  const handleOpenNewTab = useCallback((docId: string) => {
    openDocInNewTab(RELAY_ID, docId, metadata);
    onOpenChange(false);
  }, [metadata, onOpenChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (displayItems.length === 0) return;

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        setSelectedIndex(prev => (prev + 1) % displayItems.length);
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        setSelectedIndex(prev => (prev - 1 + displayItems.length) % displayItems.length);
        break;
      }
      case 'Enter': {
        e.preventDefault();
        const item = displayItems[selectedIndex];
        if (item) {
          if (e.ctrlKey || e.metaKey) {
            handleOpenNewTab(item.entry.id);
          } else {
            handleSelect(item.entry.id);
          }
        }
        break;
      }
    }
  }, [displayItems, selectedIndex, handleSelect, handleOpenNewTab]);

  const isRecentMode = results === null;
  const hasItems = displayItems.length > 0;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content
          className="fixed top-[20%] left-1/2 -translate-x-1/2 w-full max-w-[600px] bg-white rounded-lg shadow-xl overflow-hidden"
          aria-describedby={undefined}
          onKeyDown={handleKeyDown}
        >
          <Dialog.Title className="sr-only">Quick Switcher</Dialog.Title>
          <div className="p-3 border-b border-gray-200">
            <input
              ref={inputRef}
              type="text"
              placeholder="Type to search..."
              value={query}
              onChange={e => {
                setQuery(e.target.value);
                setSelectedIndex(0);
              }}
              className="w-full text-base outline-none bg-transparent"
              autoFocus
            />
          </div>
          <div ref={listRef} className="max-h-[400px] overflow-y-auto" role="listbox">
            {isRecentMode && hasItems && (
              <div className="px-3 py-1.5 text-xs text-gray-500 font-medium uppercase tracking-wide">
                Recent
              </div>
            )}
            {isRecentMode && !hasItems && (
              <div className="px-3 py-6 text-center text-sm text-gray-400">
                No recent files
              </div>
            )}
            {!isRecentMode && !hasItems && (
              <div className="px-3 py-6 text-center text-sm text-gray-400">
                No matching files
              </div>
            )}
            {displayItems.map((item, index) => {
              const isSelected = index === selectedIndex;
              return (
                <div
                  key={item.entry.id}
                  role="option"
                  aria-selected={isSelected}
                  data-selected={isSelected}
                  className={`flex items-center gap-3 px-3 py-2 cursor-pointer ${
                    isSelected ? 'bg-blue-50' : 'hover:bg-gray-50'
                  }`}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => handleSelect(item.entry.id)}
                  onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
                  onAuxClick={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      handleOpenNewTab(item.entry.id);
                    }
                  }}
                >
                  <span className="text-sm font-medium text-gray-900 truncate min-w-0 flex-1">
                    <HighlightedName name={item.entry.name} ranges={item.ranges} />
                  </span>
                  {item.entry.folder && (
                    <span className="text-xs text-gray-400 truncate flex-shrink-0">
                      {item.entry.folder}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
