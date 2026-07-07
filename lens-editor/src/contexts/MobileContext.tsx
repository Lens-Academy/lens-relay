import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useIsMobile } from '../hooks/useIsMobile';

/**
 * Mobile overlay surfaces. Only one can be open at a time (Obsidian-style):
 * - 'left'       — file tree / search drawer
 * - 'right'      — table of contents + backlinks drawer
 * - 'comments'   — comments bottom sheet
 * - 'discussion' — Discord discussion drawer
 */
export type MobileDrawerId = 'left' | 'right' | 'comments' | 'discussion';

interface MobileContextValue {
  isMobile: boolean;
  activeDrawer: MobileDrawerId | null;
  openDrawer: (id: MobileDrawerId) => void;
  closeDrawer: () => void;
  toggleDrawer: (id: MobileDrawerId) => void;
  /** True while the CodeMirror editor has focus (on-screen keyboard likely open). */
  editorFocused: boolean;
  setEditorFocused: (focused: boolean) => void;
  /** True while EditorArea (host of the comments/right/discussion drawers) is mounted. */
  docPanelsAvailable: boolean;
  setDocPanelsAvailable: (available: boolean) => void;
  /** True when the current doc has a Discord discussion panel. */
  discussionAvailable: boolean;
  setDiscussionAvailable: (available: boolean) => void;
}

const MobileContext = createContext<MobileContextValue>({
  isMobile: false,
  activeDrawer: null,
  openDrawer: () => {},
  closeDrawer: () => {},
  toggleDrawer: () => {},
  editorFocused: false,
  setEditorFocused: () => {},
  docPanelsAvailable: false,
  setDocPanelsAvailable: () => {},
  discussionAvailable: false,
  setDiscussionAvailable: () => {},
});

export function MobileProvider({ children }: { children: ReactNode }) {
  const isMobile = useIsMobile();
  const location = useLocation();
  const [activeDrawer, setActiveDrawer] = useState<MobileDrawerId | null>(null);
  const [editorFocused, setEditorFocused] = useState(false);
  const [docPanelsAvailable, setDocPanelsAvailable] = useState(false);
  const [discussionAvailable, setDiscussionAvailable] = useState(false);
  // Mirror for use in history/popstate handlers without stale closures
  const activeDrawerRef = useRef<MobileDrawerId | null>(null);

  // Close any open drawer when crossing the breakpoint (rotation, resize).
  // State adjustment during render, per React's "adjusting state when props
  // change" pattern. (The orphaned history entry is absorbed by the popstate
  // handler below; the ref is synced in an effect since refs must not be
  // written during render.)
  if (!isMobile && activeDrawer !== null) {
    setActiveDrawer(null);
  }
  useEffect(() => {
    if (!isMobile) activeDrawerRef.current = null;
  }, [isMobile]);

  // Opening a drawer pushes one history entry so the Android back
  // button/gesture dismisses the drawer instead of leaving the page.
  const openDrawer = useCallback((id: MobileDrawerId) => {
    if (activeDrawerRef.current === null) {
      window.history.pushState({ mobileDrawer: true }, '');
    }
    activeDrawerRef.current = id;
    setActiveDrawer(id);
  }, []);

  const closeDrawer = useCallback(() => {
    if (activeDrawerRef.current === null) return;
    activeDrawerRef.current = null;
    setActiveDrawer(null);
    if (window.history.state?.mobileDrawer) {
      window.history.back();
    }
  }, []);

  const toggleDrawer = useCallback((id: MobileDrawerId) => {
    if (activeDrawerRef.current === id) closeDrawer();
    else openDrawer(id);
  }, [openDrawer, closeDrawer]);

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      if (activeDrawerRef.current !== null) {
        // Back pressed while a drawer was open — the entry is already popped,
        // just close the drawer.
        activeDrawerRef.current = null;
        setActiveDrawer(null);
      } else if (e.state?.mobileDrawer) {
        // Landed on an orphaned drawer entry (drawer was dismissed by
        // navigation or rotation) — skip over it.
        window.history.back();
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Route changes dismiss the drawer silently (no history.back — the router
  // has already pushed a new entry; the orphaned drawer entry is absorbed by
  // the popstate handler above).
  useEffect(() => {
    if (activeDrawerRef.current !== null) {
      activeDrawerRef.current = null;
      setActiveDrawer(null);
    }
  }, [location.pathname]);

  const value = useMemo(
    () => ({
      isMobile, activeDrawer, openDrawer, closeDrawer, toggleDrawer,
      editorFocused, setEditorFocused, docPanelsAvailable, setDocPanelsAvailable,
      discussionAvailable, setDiscussionAvailable,
    }),
    [isMobile, activeDrawer, openDrawer, closeDrawer, toggleDrawer, editorFocused, docPanelsAvailable, discussionAvailable],
  );

  return <MobileContext.Provider value={value}>{children}</MobileContext.Provider>;
}

export function useMobile(): MobileContextValue {
  return useContext(MobileContext);
}
