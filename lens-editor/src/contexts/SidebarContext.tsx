import { createContext, useContext, type RefObject } from 'react';
import type { PanelImperativeHandle, GroupImperativeHandle } from 'react-resizable-panels';
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
  desiredCollapsedRef: RefObject<Record<string, boolean>>;
  editorAreaGroupRef: RefObject<GroupImperativeHandle | null>;
  /** Apply desiredCollapsedRef to the editor-area layout via setLayout() */
  applyEditorAreaLayout: () => void;
  toggleCommentMargin: () => void;
  headerStage: HeaderStage;
  commentMarginRef: RefObject<PanelImperativeHandle | null>;
  commentMarginCollapsed: boolean;
  setCommentMarginCollapsed: (collapsed: boolean) => void;
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
  desiredCollapsedRef: { current: {} },
  editorAreaGroupRef: { current: null },
  applyEditorAreaLayout: () => {},
  toggleCommentMargin: () => {},
  headerStage: 'full',
  commentMarginRef: { current: null },
  commentMarginCollapsed: false,
  setCommentMarginCollapsed: () => {},
});

export const useSidebar = () => useContext(SidebarContext);
