import { createContext, useContext, type RefObject } from 'react';
import type { PanelImperativeHandle } from 'react-resizable-panels';

interface SidebarContextValue {
  toggleLeftSidebar: () => void;
  leftCollapsed: boolean;
  rightSidebarRef: RefObject<PanelImperativeHandle | null>;
  rightCollapsed: boolean;
  setRightCollapsed: (collapsed: boolean) => void;
  commentMarginRef: RefObject<PanelImperativeHandle | null>;
  commentMarginCollapsed: boolean;
  setCommentMarginCollapsed: (collapsed: boolean) => void;
}

export const SidebarContext = createContext<SidebarContextValue>({
  toggleLeftSidebar: () => {},
  leftCollapsed: false,
  rightSidebarRef: { current: null },
  rightCollapsed: false,
  setRightCollapsed: () => {},
  commentMarginRef: { current: null },
  commentMarginCollapsed: false,
  setCommentMarginCollapsed: () => {},
});

export const useSidebar = () => useContext(SidebarContext);
