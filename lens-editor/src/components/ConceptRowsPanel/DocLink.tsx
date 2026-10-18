import type { ReactNode } from 'react';
import { useNavigation } from '../../contexts/NavigationContext';
import { isPlainLeftClick, urlForDoc } from '../../lib/url-utils';
import { RELAY_ID } from '../../App';

/**
 * A link to a document (bare uuid): a real `<a href>` to its editor URL, so
 * Ctrl/Cmd-click and middle-click open it in a new tab, while a plain click
 * navigates in the app.
 */
export function DocLink({ docId, className, title, children }: {
  docId: string;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const { metadata, onNavigate } = useNavigation();
  const compoundId = `${RELAY_ID}-${docId}`;
  return (
    <a
      href={urlForDoc(compoundId, metadata)}
      className={className}
      title={title}
      onClick={(e) => {
        if (!isPlainLeftClick(e)) return;
        e.preventDefault();
        onNavigate(compoundId);
      }}
    >
      {children}
    </a>
  );
}
