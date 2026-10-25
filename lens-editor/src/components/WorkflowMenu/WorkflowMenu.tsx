import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { workflowAccess, type WorkflowAccess } from '../../lib/app-routes';
import { setThemeSetting, useTheme, type ThemeSetting } from '../../lib/theme';

interface WorkflowItem {
  label: string;
  description: string;
  path: string;
  icon: 'review' | 'recent' | 'video' | 'article' | 'promote';
  access: keyof WorkflowAccess;
}

const WORKFLOWS: WorkflowItem[] = [
  {
    label: 'Review Suggestions',
    description: 'Accept or reject proposed edits',
    path: '/review',
    access: 'review',
    icon: 'review',
  },
  {
    label: 'Recent Changes',
    description: 'Direct AI edits from the last 7 days',
    path: '/recent',
    access: 'recent',
    icon: 'recent',
  },
  // One importer for everything: it detects YouTube URLs and imports the
  // video's transcript instead of an article, so the separate Add Video page
  // (and its bookmarklet) is gone. The old /add-article address redirects here.
  {
    label: 'Add Source',
    description: 'Import an article or video into Lens Edu',
    path: '/add-source',
    access: 'addSource',
    icon: 'article',
  },
  {
    label: 'Promote to Production',
    description: 'Publish selected files to production',
    path: '/promote',
    access: 'promote',
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

  if (icon === 'recent') {
    return (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
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

/** Notion's appearance choices */
const THEME_CHOICES: { value: ThemeSetting; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'Use system setting' },
];

function ThemeIcon({ value }: { value: ThemeSetting }) {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {value === 'light' && (
        <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </>
      )}
      {value === 'dark' && <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />}
      {value === 'system' && (
        <>
          <rect x="2" y="4" width="20" height="13" rx="2" />
          <path d="M8 21h8M12 17v4" />
        </>
      )}
    </svg>
  );
}

export function WorkflowMenu() {
  const { setting: themeSetting } = useTheme();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 8 });
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const access = workflowAccess(useAuth());
  const workflows = WORKFLOWS.filter(item => access[item.access]);

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
        className="lens-icon-button"
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
          className="lens-popover fixed z-[1200] p-1"
          style={{ top: position.top, left: position.left, width: 'min(280px, calc(100vw - 16px))' }}
        >
          <div className="space-y-px">
            {workflows.map(item => {
              const active = location.pathname === item.path;
              return (
                <button
                  key={item.path}
                  type="button"
                  role="menuitem"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => selectWorkflow(item.path)}
                  className={`lens-menu-item${active ? ' is-active' : ''}`}
                >
                  <span className="lens-menu-item-icon">
                    <WorkflowIcon icon={item.icon} />
                  </span>
                  <span className="min-w-0">
                    <span className="lens-menu-item-label block text-sm leading-5">{item.label}</span>
                    <span className="lens-menu-item-description">{item.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {/* Notion's Settings › Appearance */}
          <div className="lens-menu-divider" />
          <div className="lens-menu-label px-2 pt-1 pb-1" id="appearance-label">Appearance</div>
          <div role="group" aria-labelledby="appearance-label">
            {THEME_CHOICES.map(choice => (
              <button
                key={choice.value}
                type="button"
                role="menuitemradio"
                aria-checked={themeSetting === choice.value}
                onClick={() => setThemeSetting(choice.value)}
                className="lens-menu-item lens-menu-item-compact"
              >
                <span className="lens-menu-item-icon">
                  <ThemeIcon value={choice.value} />
                </span>
                <span className="flex-1 text-sm leading-5">{choice.label}</span>
                {themeSetting === choice.value && (
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
