import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';

interface WorkflowItem {
  label: string;
  description: string;
  path: string;
  icon: 'review' | 'video' | 'article' | 'promote';
}

const WORKFLOWS: WorkflowItem[] = [
  {
    label: 'Review Suggestions',
    description: 'Accept or reject proposed edits',
    path: '/review',
    icon: 'review',
  },
  {
    label: 'Add Video',
    description: 'Import a video into Lens Edu',
    path: '/add-video',
    icon: 'video',
  },
  {
    label: 'Add Article',
    description: 'Import an article into Lens Edu',
    path: '/add-article',
    icon: 'article',
  },
  {
    label: 'Promote to Production',
    description: 'Publish selected files to production',
    path: '/promote',
    icon: 'promote',
  },
];

function WorkflowIcon({ icon }: { icon: WorkflowItem['icon'] }) {
  if (icon === 'video') {
    return (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="5" width="14" height="14" rx="2" />
        <path d="m17 9 4-2v10l-4-2" />
      </svg>
    );
  }

  if (icon === 'article') {
    return (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6" />
        <path d="M8 13h8" />
        <path d="M8 17h6" />
      </svg>
    );
  }

  if (icon === 'promote') {
    return (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 19V5" />
        <path d="m5 12 7-7 7 7" />
        <path d="M4 19h16" />
      </svg>
    );
  }

  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  );
}

export function WorkflowMenu() {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 8 });
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!open) return;

    const closeOnPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const toggleMenu = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const menuWidth = Math.min(280, window.innerWidth - 16);
      const preferredLeft = rect.right - menuWidth;
      const maxLeft = window.innerWidth - menuWidth - 8;
      setPosition({
        top: rect.bottom + 8,
        left: Math.min(Math.max(8, preferredLeft), maxLeft),
      });
    }
    setOpen(current => !current);
  };

  const selectWorkflow = (path: string) => {
    setOpen(false);
    navigate(path);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={toggleMenu}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Open workflows menu"
        className="flex h-8 w-8 items-center justify-center rounded border border-gray-200 bg-white text-gray-500 shadow-sm transition-colors hover:border-gray-300 hover:bg-gray-50 hover:text-gray-900"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="1.75" />
          <circle cx="12" cy="12" r="1.75" />
          <circle cx="12" cy="19" r="1.75" />
        </svg>
      </button>

      {open && createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-[1200] rounded-md border border-gray-200 bg-white p-1.5 shadow-xl"
          style={{ top: position.top, left: position.left, width: 'min(280px, calc(100vw - 16px))' }}
        >
          <div className="space-y-0.5">
            {WORKFLOWS.map(item => {
              const active = location.pathname === item.path;
              return (
                <button
                  key={item.path}
                  type="button"
                  role="menuitem"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => selectWorkflow(item.path)}
                  className={`flex w-full items-start gap-3 rounded px-2.5 py-2 text-left transition-colors ${
                    active
                      ? 'bg-gray-900 text-white'
                      : 'text-gray-700 hover:bg-gray-100 hover:text-gray-950'
                  }`}
                >
                  <span className={`mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded border ${
                    active ? 'border-white/20 bg-white/10 text-white' : 'border-gray-200 bg-gray-50 text-gray-500'
                  }`}>
                    <WorkflowIcon icon={item.icon} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium leading-5">{item.label}</span>
                    <span className={`block text-xs leading-4 ${active ? 'text-gray-300' : 'text-gray-500'}`}>
                      {item.description}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
