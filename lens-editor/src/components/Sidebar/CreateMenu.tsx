import { useState, useRef, useEffect, useCallback } from 'react';
import type { TemplateOption } from '../../lib/templates';

interface CreateMenuProps {
  folderName: string;
  onCreateDocument?: () => void;
  onCreateHtmlDocument?: () => void;
  onCreateFolder?: () => void;
  /** Templates offered under "New from template"; read when the menu opens. */
  getTemplates?: () => TemplateOption[];
  onCreateFromTemplate?: (template: TemplateOption) => void;
}

export function CreateMenu({
  folderName,
  onCreateDocument,
  onCreateHtmlDocument,
  onCreateFolder,
  getTemplates,
  onCreateFromTemplate,
}: CreateMenuProps) {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const handleClose = useCallback(() => {
    setOpen(false);
    setTemplatesOpen(false);
  }, []);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        handleClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open, handleClose]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, handleClose]);

  return (
    <div ref={menuRef} className={`lens-tree-actions ml-auto flex-shrink-0 relative${open ? " is-open" : ""}`}>
      <button
        aria-label={`Create in ${folderName}`}
        onClick={(e) => {
          e.stopPropagation();
          if (open) {
            handleClose();
          } else {
            setTemplates(onCreateFromTemplate && getTemplates ? getTemplates() : []);
            setOpen(true);
          }
        }}
        className="lens-tree-action max-md:p-2 max-md:-my-1.5"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
        </svg>
      </button>

      {open && (
        <div className="lens-popover absolute right-0 top-full mt-1 p-1 min-w-[140px] max-w-[260px] z-50">
          {onCreateDocument && (
            <button
              className="lens-create-item"
              onClick={(e) => {
                e.stopPropagation();
                onCreateDocument();
                handleClose();
              }}
            >
              New File
            </button>
          )}
          {onCreateFromTemplate && templates.length > 0 && (
            <>
              <button
                aria-expanded={templatesOpen}
                className="lens-create-item flex items-center justify-between gap-2 whitespace-nowrap"
                onClick={(e) => {
                  e.stopPropagation();
                  setTemplatesOpen(!templatesOpen);
                }}
              >
                New from template
                <svg
                  className={`w-3 h-3 text-gray-400 flex-shrink-0 ${templatesOpen ? 'rotate-90' : ''}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </button>
              {templatesOpen && templates.map(template => (
                <button
                  key={template.path}
                  title={template.path}
                  className="lens-create-item pl-6 truncate"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCreateFromTemplate(template);
                    handleClose();
                  }}
                >
                  {template.name}
                </button>
              ))}
            </>
          )}
          {onCreateHtmlDocument && (
            <button
              className="lens-create-item"
              onClick={(e) => {
                e.stopPropagation();
                onCreateHtmlDocument();
                handleClose();
              }}
            >
              New HTML File
            </button>
          )}
          {onCreateFolder && (
            <button
              className="lens-create-item"
              onClick={(e) => {
                e.stopPropagation();
                onCreateFolder();
                handleClose();
              }}
            >
              New Folder
            </button>
          )}
        </div>
      )}
    </div>
  );
}
