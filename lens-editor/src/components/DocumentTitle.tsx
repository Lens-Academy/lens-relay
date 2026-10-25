import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { useYDoc } from '../lib/ydoc-provider';
import { useNavigation } from '../contexts/NavigationContext';
import { findPathByUuid } from '../lib/uuid-to-path';
import { getOriginalPath, getFolderNameFromPath } from '../lib/multi-folder-utils';
import { movePath, moveErrorMessage } from '../lib/relay-api';
import { getPlatformUrl } from '../lib/platform-url';
import { extractFrontmatter, frontmatterFieldChange } from '../lib/frontmatter';
import { shortUuid } from '../lib/url-utils';
import { RELAY_ID } from '../App';
import { useDocTabTitle, docDisplayName } from '../hooks/useDocTabTitle';
import { useAuth } from '../contexts/AuthContext';
import { EmojiPicker } from './EmojiPicker/EmojiPicker';
import { recordPageIcon } from '../lib/pageIcons';

interface DocumentTitleProps {
  currentDocId: string;
}

export function DocumentTitle({ currentDocId }: DocumentTitleProps) {
  const { metadata, folderNames, justCreatedRef, folderDocs } = useNavigation();
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

  // Auto-focus and select when document was just created via instant-create.
  // The title is in the editor's top widget (EditorArea), which can join the
  // page a moment after this mounts: wait for it, up to 3 seconds.
  useEffect(() => {
    if (justCreatedRef.current && inputRef.current) {
      justCreatedRef.current = false;
      const focusWhenShown = (tries: number) => {
        const el = inputRef.current;
        if (!el) return;
        if (!el.isConnected && tries < 30) {
          setTimeout(() => focusWhenShown(tries + 1), 100);
          return;
        }
        el.focus();
        el.select();
      };
      setTimeout(() => focusWhenShown(0), 100);
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

  // Read frontmatter slug (needed for modules and courses) and the page icon
  // from the document's Y.Text
  const ydoc = useYDoc();
  const [frontmatterSlug, setFrontmatterSlug] = useState<string | undefined>();
  // undefined until the page has text to read (it's still loading)
  const [icon, setIcon] = useState<string | null | undefined>();

  useEffect(() => {
    const ytext = ydoc.getText('contents');

    function parse() {
      const fm = extractFrontmatter(ytext.toString());
      const slug = fm?.slug;
      setFrontmatterSlug(typeof slug === 'string' && slug.trim() ? slug.trim() : undefined);
      if (ytext.length > 0) setIcon(typeof fm?.icon === 'string' && fm.icon.trim() ? fm.icon.trim() : null);
    }

    parse();
    ytext.observe(parse);
    return () => { ytext.unobserve(parse); };
  }, [ydoc]);

  // The page icon is the frontmatter's `icon:`, set from Notion's "Add icon"
  // picker by people who can edit the page
  const { canEdit } = useAuth();
  // Keep the sidebar's icon index (lib/pageIcons.ts) in step with the page
  const iconFolderDoc = path ? folderDocs.get(getFolderNameFromPath(path, folderNames) ?? '') : undefined;
  useEffect(() => {
    if (iconFolderDoc && canEdit && icon !== undefined) recordPageIcon(iconFolderDoc, uuid, icon);
  }, [iconFolderDoc, canEdit, uuid, icon]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const closePicker = useCallback(() => setPickerOpen(false), []);
  const saveIcon = (emoji: string | null) => {
    const ytext = ydoc.getText('contents');
    const change = frontmatterFieldChange(ytext.toString(), 'icon', emoji);
    if (change) {
      ydoc.transact(() => {
        if (change.to > change.from) ytext.delete(change.from, change.to - change.from);
        if (change.insert) ytext.insert(change.from, change.insert);
      });
    }
    setPickerOpen(false);
  };

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
    // Notion's page header without a cover (spacing in index.css): the page
    // icon, or the row where "Add icon" shows while the pointer is over the
    // header, then the title
    <div className="lens-page-header flex flex-col">
      <div className="relative">
        {icon ? (
          <button
            type="button"
            className="lens-page-icon"
            onClick={canEdit ? () => setPickerOpen(true) : undefined}
            disabled={!canEdit}
            aria-label="Page icon"
          >
            {icon}
          </button>
        ) : (
          <div className="lens-page-controls">
            {canEdit && (
              <button type="button" className="lens-page-control" onClick={() => setPickerOpen(true)}>
                <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                  <circle cx="10" cy="10" r="7.25" />
                  <path d="M7.2 12.1c.7.9 1.7 1.4 2.8 1.4s2.1-.5 2.8-1.4" strokeLinecap="round" />
                  <circle cx="7.6" cy="8.4" r=".9" fill="currentColor" stroke="none" />
                  <circle cx="12.4" cy="8.4" r=".9" fill="currentColor" stroke="none" />
                </svg>
                Add icon
              </button>
            )}
          </div>
        )}
        {pickerOpen && (
          // Above the editor's cursor layer, which this is inside
          <div className="absolute left-0 top-full z-[200] mt-1">
            <EmojiPicker onPick={saveIcon} onRemove={icon ? () => saveIcon(null) : undefined} onClose={closePicker} />
          </div>
        )}
      </div>
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
          <div className="flex-shrink-0 flex flex-col items-end gap-0.5 pt-2">
            {platformUrl && (
              <a
                href={platformUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="lens-page-link"
              >
                Show on Lensacademy.org
              </a>
            )}
            {eduEditorUrl && (
              <a
                href={eduEditorUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="lens-page-link"
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
