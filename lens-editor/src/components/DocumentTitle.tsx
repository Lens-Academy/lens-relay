import { useState, useEffect, useRef, useCallback } from 'react';
import { useYDoc } from '@y-sweet/react';
import { useNavigation } from '../contexts/NavigationContext';
import { findPathByUuid } from '../lib/uuid-to-path';
import { getOriginalPath, getFolderNameFromPath } from '../lib/multi-folder-utils';
import { movePath, moveErrorMessage } from '../lib/relay-api';
import { getPlatformUrl } from '../lib/platform-url';
import { extractFrontmatter } from '../lib/frontmatter';
import { shortUuid } from '../lib/url-utils';
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
  const [renameError, setRenameError] = useState<string | null>(null);

  // Update value when the document name changes externally (e.g., renamed from sidebar)
  useEffect(() => {
    setValue(displayName);
    setRenameError(null);
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
      await movePath(path.slice(1), newPath);
      setRenameError(null);
    } catch (err: any) {
      console.error('Rename failed:', err);
      // Keep the typed name in the input so the user can correct it; the
      // error clears on the next edit or when the document changes.
      setRenameError(moveErrorMessage(err, trimmed));
    }
  }, [value, displayName, path, folderNames]);

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
      setRenameError(null);
      inputRef.current?.blur();
    }
  };

  // Read frontmatter slug from the document's Y.Text (needed for modules and courses)
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

  // Show "Open in Course Editor" for course and module documents
  const isCourseOrModule = originalPath
    ? /^\/?(?:courses|modules)\//i.test(originalPath)
    : false;
  const eduEditorUrl = isCourseOrModule ? `/edu/${shortUuid(uuid)}` : null;

  if (!path) return null;

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => { setValue(e.target.value); setRenameError(null); }}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          className="flex-1 min-w-0 text-3xl font-bold text-gray-900 bg-transparent border-none outline-none
                     placeholder-gray-400 caret-gray-900"
          placeholder="Untitled"
          spellCheck={false}
        />
        {(eduEditorUrl || platformUrl) && (
          <div className="flex-shrink-0 flex flex-col items-end gap-0.5">
            {platformUrl && (
              <a
                href={platformUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-blue-500 hover:text-blue-700 hover:underline whitespace-nowrap"
              >
                Show on Lensacademy.org
              </a>
            )}
            {eduEditorUrl && (
              <a
                href={eduEditorUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-blue-500 hover:text-blue-700 hover:underline whitespace-nowrap"
              >
                Open in Course Editor
              </a>
            )}
          </div>
        )}
      </div>
      {renameError && (
        <p className="mt-1 text-sm text-red-600" role="alert">
          {renameError}
        </p>
      )}
    </div>
  );
}
