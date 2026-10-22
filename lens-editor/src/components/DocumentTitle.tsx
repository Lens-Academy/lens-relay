import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { useYDoc } from '../lib/ydoc-provider';
import { useNavigation } from '../contexts/NavigationContext';
import { findPathByUuid } from '../lib/uuid-to-path';
import { getOriginalPath, getFolderNameFromPath } from '../lib/multi-folder-utils';
import { movePath, moveErrorMessage } from '../lib/relay-api';
import { getPlatformUrl } from '../lib/platform-url';
import { extractFrontmatter } from '../lib/frontmatter';
import { shortUuid } from '../lib/url-utils';
import { RELAY_ID } from '../App';
import { useDocTabTitle, docDisplayName } from '../hooks/useDocTabTitle';

interface DocumentTitleProps {
  currentDocId: string;
}

export function DocumentTitle({ currentDocId }: DocumentTitleProps) {
  const { metadata, folderNames, justCreatedRef } = useNavigation();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const cancelledRef = useRef(false);

  // Extract UUID from compound doc ID (RELAY_ID-UUID)
  const uuid = currentDocId.slice(RELAY_ID.length + 1);

  // Find the prefixed path for this UUID in merged metadata
  const path = findPathByUuid(uuid, metadata);

  const displayName = docDisplayName(path);

  const [value, setValue] = useState(displayName);
  const [renameError, setRenameError] = useState<string | null>(null);

  // Update value when the document name changes externally (e.g., renamed from sidebar)
  useEffect(() => {
    setValue(displayName);
    setRenameError(null);
  }, [displayName]);

  useDocTabTitle(currentDocId);

  // The title wraps (real file names run to 160 characters): the textarea
  // grows to its text, again whenever its width changes.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const fit = () => {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [value]);

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
      <div className="flex items-start gap-2">
        <textarea
          ref={inputRef}
          rows={1}
          value={value}
          // A file name is one line: a pasted line break becomes a space.
          onChange={(e) => { setValue(e.target.value.replace(/[\r\n]+/g, ' ')); setRenameError(null); }}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          aria-label="Document name"
          className="lens-doc-title flex-1 min-w-0 resize-none overflow-hidden bg-transparent
                     border-none outline-none placeholder-gray-400 caret-gray-900 [overflow-wrap:anywhere]"
          placeholder="Untitled"
          spellCheck={false}
        />
        {(eduEditorUrl || platformUrl) && (
          <div className="flex-shrink-0 flex flex-col items-end gap-0.5 pt-1">
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
