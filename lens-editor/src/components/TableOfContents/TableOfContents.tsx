import { EditorView } from '@codemirror/view';
import { useHeadings, scrollToHeading } from './useHeadings';

interface TableOfContentsProps {
  view: EditorView | null;
  stateVersion?: number;  // Incremented on doc changes - triggers re-extraction
}

export function TableOfContents({ view, stateVersion }: TableOfContentsProps) {
  // Extract headings - re-runs when stateVersion changes (parent re-renders us)
  // stateVersion is used to trigger re-render, not directly used in computation
  void stateVersion;
  const headings = useHeadings(view);

  // Handle heading click
  const handleClick = (heading: typeof headings[0]) => {
    if (view) {
      scrollToHeading(view, heading);
    }
  };

  // Compute indent based on heading level (pixels)
  const getIndent = (level: number) => (level - 1) * 12;

  if (!view) {
    return (
      <div className="toc-panel p-3 text-sm text-gray-500">
        No document open
      </div>
    );
  }

  if (headings.length === 0) {
    return (
      <div className="toc-panel p-3 text-sm text-gray-500">
        No headings in document
      </div>
    );
  }

  return (
    <div className="toc-panel">
      <h3 className="px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider border-b border-gray-200">
        Table of Contents
      </h3>
      <ul className="py-2">
        {headings.map((heading, index) => (
          <li
            key={`${heading.from}-${index}`}
            style={{ paddingLeft: `${getIndent(heading.level) + 12}px` }}
            onClick={() => handleClick(heading)}
            className="py-1 pr-3 text-sm text-gray-700 hover:bg-gray-100 hover:text-gray-900 cursor-pointer truncate"
            title={heading.text}
          >
            {heading.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
