import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { EditorView } from '@codemirror/view';
import {
  useHeadings,
  scrollToHeading,
  normalizeHeadingLevels,
  useHeadingInView,
} from './useHeadings';
import type { NormalizedHeading } from './useHeadings';

interface TableOfContentsProps {
  view: EditorView | null;
  stateVersion?: number;  // Incremented on doc changes - triggers re-extraction
}

/** A dash's length by heading level, as Notion's: longer for higher levels */
const DASH_WIDTHS = [18, 13, 9];

/** The headings to pick from, indented by level, the one being read in blue */
function OutlineList({ headings, active, onPick }: {
  headings: NormalizedHeading[];
  active: number;
  onPick: (heading: NormalizedHeading) => void;
}) {
  return (
    <ul className="lens-outline-list">
      {headings.map((heading, index) => (
        // --i staggers the items as the page outline opens (index.css)
        <li key={`${heading.from}-${index}`} style={{ '--i': Math.min(index, 12) } as CSSProperties}>
          <button
            type="button"
            className={`lens-outline-item${index === active ? ' is-active' : ''}`}
            style={{ paddingLeft: 8 + (heading.displayLevel - 1) * 12 }}
            aria-current={index === active ? 'location' : undefined}
            title={heading.text}
            onClick={() => onPick(heading)}
          >
            {heading.text}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The page's headings as a list: the phone's outline drawer */
export function TableOfContents({ view, stateVersion }: TableOfContentsProps) {
  // stateVersion triggers re-render, not directly used in computation
  void stateVersion;

  const headings = normalizeHeadingLevels(useHeadings(view));
  const active = useHeadingInView(view, headings);

  if (!view) {
    return <div className="toc-panel lens-outline-empty">No document open</div>;
  }

  if (headings.length === 0) {
    return <div className="toc-panel lens-outline-empty">No headings in document</div>;
  }

  return (
    <nav className="toc-panel" aria-label="Table of contents">
      <div className="lens-outline-label">Contents</div>
      <OutlineList headings={headings} active={active} onPick={(heading) => scrollToHeading(view, heading)} />
    </nav>
  );
}

/**
 * Notion's table of contents on the page: a dash per heading at the right
 * edge, the section being read darker; over them, the headings to go to.
 * Not shown for fewer than two headings, nor where the page is too narrow
 * for it beside the text (index.css).
 */
export function PageOutline({ view, stateVersion }: TableOfContentsProps) {
  void stateVersion;

  const headings = normalizeHeadingLevels(useHeadings(view));
  const active = useHeadingInView(view, headings);
  const [open, setOpen] = useState(false);
  const closeTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  if (!view || headings.length < 2) return null;

  const show = () => {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  // A moment's grace, so the pointer can cross from the dashes to the list
  const hideSoon = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 150);
  };

  return (
    <nav
      className={`lens-outline${open ? ' is-open' : ''}`}
      aria-label="Table of contents"
      onMouseEnter={show}
      onMouseLeave={hideSoon}
      onFocus={show}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false);
      }}
    >
      <button
        type="button"
        className="lens-outline-dashes"
        aria-label="Show the table of contents"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {headings.map((heading, index) => (
          <span
            key={`${heading.from}-${index}`}
            className={`lens-outline-dash${index === active ? ' is-active' : ''}`}
            style={{ width: DASH_WIDTHS[Math.min(heading.displayLevel, DASH_WIDTHS.length) - 1] }}
          />
        ))}
      </button>
      {/* Always there, so it can fade and slide in and out (index.css);
          hidden, it takes no pointer, focus or screen reader */}
      <div className={`lens-outline-panel${open ? ' is-open' : ''}`}>
        <OutlineList
          headings={headings}
          active={active}
          onPick={(heading) => {
            setOpen(false);
            scrollToHeading(view, heading);
          }}
        />
      </div>
    </nav>
  );
}
