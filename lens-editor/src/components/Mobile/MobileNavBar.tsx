import { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useMobile } from '../../contexts/MobileContext';
import { useAuth } from '../../contexts/AuthContext';
import { EDU_FOLDER_ID } from '../../lib/constants';

interface MobileNavBarProps {
  onOpenQuickSwitcher: () => void;
}

const NON_DOC_ROUTES = /^\/(review|promote|add-video|add-article|edu\/|section-editor\/)/;

function isDocRoute(pathname: string): boolean {
  return pathname !== '/' && !NON_DOC_ROUTES.test(pathname);
}

/**
 * Obsidian-style bottom navigation bar, mobile only. Rendered as a normal
 * flex child at the bottom of the app column (not fixed) so it never overlaps
 * content. Hidden while the editor keyboard toolbar is showing.
 */
export function MobileNavBar({ onOpenQuickSwitcher }: MobileNavBarProps) {
  const { toggleDrawer, activeDrawer, closeDrawer, editorFocused, docPanelsAvailable, discussionAvailable } = useMobile();
  const { canEdit, folderUuid, isAllFolders } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  // Close the overflow menu on navigation (state adjustment during render)
  const [menuPathname, setMenuPathname] = useState(location.pathname);
  if (menuPathname !== location.pathname) {
    setMenuPathname(location.pathname);
    setMenuOpen(false);
  }

  // Escape closes the overflow menu (event-driven, matches OverflowMenu)
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  // Comments/outline drawers live in EditorArea — only offer them when it's
  // mounted (image/blob/html doc routes render other views without drawers)
  const showPanelButtons = isDocRoute(location.pathname) && docPanelsAvailable;
  const canUseEdu = canEdit && (isAllFolders || folderUuid === EDU_FOLDER_ID);

  // While the editor keyboard is up, MobileEditToolbar replaces this bar
  if (editorFocused) return null;

  const menuItems: { label: string; action: () => void }[] = [
    ...(showPanelButtons && discussionAvailable
      ? [{ label: 'Discussion', action: () => toggleDrawer('discussion') }]
      : []),
    ...(canEdit ? [{ label: 'Review suggestions', action: () => navigate('/review') }] : []),
    ...(canUseEdu ? [
      { label: 'Promote to production', action: () => navigate('/promote') },
      { label: 'Add video', action: () => navigate('/add-video') },
      { label: 'Add article', action: () => navigate('/add-article') },
    ] : []),
  ];

  const btnClass = 'flex-1 flex items-center justify-center h-12 text-gray-500 active:text-gray-800 active:bg-gray-100';
  const activeBtnClass = 'flex-1 flex items-center justify-center h-12 text-blue-600 active:bg-gray-100';

  return (
    <nav
      id="mobile-nav-bar"
      className="flex-shrink-0 flex items-stretch bg-[#f6f6f6] border-t border-gray-200"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      aria-label="Mobile navigation"
    >
      {/* Left sidebar (file tree) */}
      <button className={activeDrawer === 'left' ? activeBtnClass : btnClass} title="Open file tree" aria-label="Open file tree" onClick={() => toggleDrawer('left')}>
        <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="18" x2="20" y2="18" />
        </svg>
      </button>
      {/* Quick switcher */}
      <button className={btnClass} title="Quick switcher" aria-label="Quick switcher" onClick={() => { closeDrawer(); onOpenQuickSwitcher(); }}>
        <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </button>
      {showPanelButtons && (
        <>
          {/* Comments sheet */}
          <button className={activeDrawer === 'comments' ? activeBtnClass : btnClass} title="Comments" aria-label="Comments" onClick={() => toggleDrawer('comments')}>
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </button>
          {/* Right panel: outline + backlinks */}
          <button className={activeDrawer === 'right' ? activeBtnClass : btnClass} title="Outline and backlinks" aria-label="Outline and backlinks" onClick={() => toggleDrawer('right')}>
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" />
            </svg>
          </button>
        </>
      )}
      {menuItems.length > 0 && (
        <button className={btnClass} title="More options" aria-label="More options" onClick={() => setMenuOpen(o => !o)}>
          <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
          </svg>
        </button>
      )}
      {menuOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setMenuOpen(false)}
            onKeyDown={(e) => { if (e.key === 'Escape') setMenuOpen(false); }}
          />
          <div className="fixed bottom-14 right-2 z-50 min-w-[220px] bg-white rounded-lg shadow-xl border border-gray-200 py-1"
               style={{ marginBottom: 'env(safe-area-inset-bottom)' }}>
            {menuItems.map(item => (
              <button
                key={item.label}
                className="w-full text-left px-4 py-3 text-sm text-gray-700 active:bg-gray-100"
                onClick={() => { setMenuOpen(false); item.action(); }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </>
      )}
    </nav>
  );
}
