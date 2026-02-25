import { createContext, useContext, type RefObject } from 'react';
import type { PanelImperativeHandle } from 'react-resizable-panels';
import type { HeaderStage } from '../hooks/useHeaderBreakpoints';

interface SidebarContextValue {
  toggleLeftSidebar: () => void;
  leftCollapsed: boolean;
  sidebarRef: RefObject<PanelImperativeHandle | null>;
  rightSidebarRef: RefObject<PanelImperativeHandle | null>;
  rightCollapsed: boolean;
  setRightCollapsed: (collapsed: boolean) => void;
  discussionRef: RefObject<PanelImperativeHandle | null>;
  discussionCollapsed: boolean;
  setDiscussionCollapsed: (collapsed: boolean) => void;
  toggleDiscussion: () => void;
  headerStage: HeaderStage;
}

export const SidebarContext = createContext<SidebarContextValue>({
  toggleLeftSidebar: () => {},
  leftCollapsed: false,
  sidebarRef: { current: null },
  rightSidebarRef: { current: null },
  rightCollapsed: false,
  setRightCollapsed: () => {},
  discussionRef: { current: null },
  discussionCollapsed: true,
  setDiscussionCollapsed: () => {},
  toggleDiscussion: () => {},
  headerStage: 'full',
});

export const useSidebar = () => useContext(SidebarContext);
