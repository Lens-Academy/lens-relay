import { useState, useEffect, useRef, useCallback } from 'react';
import { useYDoc } from '@y-sweet/react';
import { useNavigation } from '../contexts/NavigationContext';
import { findPathByUuid } from '../lib/uuid-to-path';
import { getOriginalPath, getFolderNameFromPath } from '../lib/multi-folder-utils';
import { moveDocument } from '../lib/relay-api';
import { getPlatformUrl } from '../lib/platform-url';
import { extractFrontmatter } from '../lib/frontmatter';
import { RELAY_ID } from '../App';

interface DocumentTitleProps {
  currentDocId: string;
}

export function DocumentTitle({ currentDocId }: DocumentTitleProps) {
  const { metadata, folderNames, justCreatedRef } = useNavigation();
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);

  // Extract UUID from compound doc ID (RELAY_ID-UUID)
  const uuid = currentDocId.slice(RELAY_ID.length + 1);

  // Find the prefixed path for this UUID in merged metadata
  const path = findPathByUuid(uuid, metadata);

  // Extract display name (filename without .md extension)
  const displayName = path
    ? path.split('/').pop()?.replace(/\.md$/, '') ?? ''
    : '';

  const [value, setValue] = useState(displayName);

  // Update value when the document name changes externally (e.g., renamed from sidebar)
  useEffect(() => {
    setValue(displayName);
  }, [displayName]);

  // Update browser tab title to reflect current document
  useEffect(() => {
    document.title = displayName ? `${displayName} - Editor` : 'Editor';
    return () => { document.title = 'Editor'; };
  }, [displayName]);

  // Auto-focus and select when document was just created via instant-create
  useEffect(() => {
    if (justCreatedRef.current && inputRef.current) {
      justCreatedRef.current = false;
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.select();
        }
      }, 100);
    }
  }, [justCreatedRef, displayName]);

  const handleSubmit = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === displayName || !path) return;

    const folderName = getFolderNameFromPath(path, folderNames);
    if (!folderName) return;
    const originalPath = getOriginalPath(path, folderName);
    const parts = originalPath.split('/');
    const filename = trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
    parts[parts.length - 1] = filename;
    const newPath = parts.join('/');
    try {
      await moveDocument(uuid, newPath);
    } catch (err: any) {
      console.error('Rename failed:', err);
    }
  }, [value, displayName, path, uuid, folderNames]);

  const handleBlur = () => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    handleSubmit();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      // Let blur handle the submit to avoid double-firing
      inputRef.current?.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelledRef.current = true;
      setValue(displayName);
      inputRef.current?.blur();
    }
  };

  // Read frontmatter slug from the document's Y.Text (needed for modules)
  const ydoc = useYDoc();
  const [frontmatterSlug, setFrontmatterSlug] = useState<string | undefined>();

  useEffect(() => {
    const ytext = ydoc.getText('contents');

    function parse() {
      const fm = extractFrontmatter(ytext.toString());
      const slug = fm?.slug;
      setFrontmatterSlug(typeof slug === 'string' && slug.trim() ? slug.trim() : undefined);
    }

    parse();
    ytext.observe(parse);
    return () => { ytext.unobserve(parse); };
  }, [ydoc]);

  // Derive platform URL from the original (unprefixed) path
  const folderName = path ? getFolderNameFromPath(path, folderNames) : null;
  const originalPath = path && folderName ? getOriginalPath(path, folderName) : null;
  const platformUrl = originalPath ? getPlatformUrl(originalPath, frontmatterSlug) : null;

  if (!path) return null;

  return (
    <div className="flex items-center gap-2">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        className="flex-1 min-w-0 text-3xl font-bold text-gray-900 bg-transparent border-none outline-none
                   placeholder-gray-400 caret-gray-900"
        placeholder="Untitled"
        spellCheck={false}
      />
      {platformUrl && (
        <a
          href={platformUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="View on Lens Platform"
          className="flex-shrink-0 text-gray-400 hover:text-gray-600 transition-colors"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </a>
      )}
    </div>
  );
}
