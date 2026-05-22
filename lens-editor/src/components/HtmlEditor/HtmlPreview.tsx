import { useEffect, useState } from 'react';
import type * as Y from 'yjs';

interface HtmlPreviewProps {
  ytext: Y.Text;
  debounceMs?: number;
}

export function HtmlPreview({ ytext, debounceMs = 300 }: HtmlPreviewProps) {
  const [content, setContent] = useState(() => ytext.toString());
  const [debounced, setDebounced] = useState(content);

  useEffect(() => {
    const sync = () => setContent(ytext.toString());
    sync();
    ytext.observe(sync);
    return () => ytext.unobserve(sync);
  }, [ytext]);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(content), debounceMs);
    return () => clearTimeout(handle);
  }, [content, debounceMs]);

  return (
    <iframe
      title="HTML preview"
      sandbox="allow-scripts"
      srcDoc={debounced}
      className="w-full h-full border-0 bg-white"
    />
  );
}
