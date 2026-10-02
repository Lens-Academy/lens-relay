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
    <div ref={menuRef} className="ml-auto flex-shrink-0 relative">
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
        className="p-0.5 max-md:p-2 max-md:-my-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-200 rounded"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 bg-white rounded shadow-lg border border-gray-200 py-1 min-w-[140px] max-w-[260px] z-50">
          {onCreateDocument && (
            <button
              className="w-full text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
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
                className="w-full flex items-center justify-between gap-2 text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 whitespace-nowrap"
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
                  className="w-full text-left pl-6 pr-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 truncate"
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
              className="w-full text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
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
              className="w-full text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
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
