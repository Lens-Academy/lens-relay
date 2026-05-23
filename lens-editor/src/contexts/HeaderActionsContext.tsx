import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export interface HeaderCommentsControl {
  isOpen: boolean;
  onToggle: () => void;
  title: string;
}

interface HeaderActionsContextValue {
  commentsControl: HeaderCommentsControl | null;
  setCommentsControl: (control: HeaderCommentsControl | null) => void;
}

const HeaderActionsContext = createContext<HeaderActionsContextValue>({
  commentsControl: null,
  setCommentsControl: () => {},
});

interface HeaderActionsProviderProps {
  children: ReactNode;
  onCommentsControlChange?: (control: HeaderCommentsControl | null) => void;
}

export function HeaderActionsProvider({ children, onCommentsControlChange }: HeaderActionsProviderProps) {
  const [commentsControl, setCommentsControl] = useState<HeaderCommentsControl | null>(null);
  const value = useMemo(
    () => ({ commentsControl, setCommentsControl }),
    [commentsControl]
  );

  useEffect(() => {
    onCommentsControlChange?.(commentsControl);
  }, [commentsControl, onCommentsControlChange]);

  return (
    <HeaderActionsContext.Provider value={value}>
      {children}
    </HeaderActionsContext.Provider>
  );
}

export function useHeaderActions() {
  return useContext(HeaderActionsContext);
}

export function useHeaderCommentsControl(control: HeaderCommentsControl | null) {
  const { setCommentsControl } = useHeaderActions();
  const isOpen = control?.isOpen ?? false;
  const onToggle = control?.onToggle ?? null;
  const title = control?.title ?? '';

  useEffect(() => {
    if (!onToggle) {
      setCommentsControl(null);
      return undefined;
    }

    setCommentsControl({ isOpen, onToggle, title });
    return () => setCommentsControl(null);
  }, [isOpen, onToggle, title, setCommentsControl]);
}
