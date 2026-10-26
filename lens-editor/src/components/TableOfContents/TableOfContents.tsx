import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { EditorView } from '@codemirror/view';
import {
  useHeadings,
  scrollToHeading,
  normalizeHeadingLevels,
  rankHeadingLevels,
  useHeadingInView,
} from './useHeadings';
import type { NormalizedHeading } from './useHeadings';
import { headingKeys, useOutlineHidden } from './useOutlineHidden';

interface TableOfContentsProps {
  view: EditorView | null;
  stateVersion?: number;  // Incremented on doc changes - triggers re-extraction
}

/** A dash's length by heading level, longer for higher levels */
const DASH_WIDTHS = [20, 15, 11, 8];

/** The headings to pick from, indented by level, the one being read in blue */
function OutlineList({ headings, active, onPick, onHide }: {
  headings: NormalizedHeading[];
  active: number;
  onPick: (heading: NormalizedHeading) => void;
  /** Takes a heading out of the list, by a × at its right (Google Docs') */
  onHide?: (index: number) => void;
}) {
  return (
    <ul className="lens-outline-list">
      {headings.map((heading, index) => (
        // --i staggers the items as the page outline opens (index.css)
        <li key={`${heading.from}-${index}`} className="lens-outline-row" style={{ '--i': Math.min(index, 12) } as CSSProperties}>
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
          {onHide && (
            <button
              type="button"
              className="lens-outline-hide"
              aria-label={`Remove ${heading.text} from the outline`}
              title="Remove from outline"
              onClick={() => onHide(index)}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
                <path d="m4.5 4.5 7 7m0-7-7 7" />
              </svg>
            </button>
          )}
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
 * Levels go by heading type (every H3 alike), and a heading can be taken out
 * of it (its ×, kept in this browser by page: useOutlineHidden). Not shown
 * for fewer than two headings, nor where the page is too narrow for it
 * beside the text (index.css).
 */
export function PageOutline({ view, stateVersion, docId = '' }: TableOfContentsProps & {
  /** The page, for the headings taken out of its outline */
  docId?: string;
}) {
  void stateVersion;

  const all = rankHeadingLevels(useHeadings(view));
  const activeInAll = useHeadingInView(view, all);
  const [open, setOpen] = useState(false);
  const closeTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);
  const { hidden, hide, showAll } = useOutlineHidden(docId);

  const keys = headingKeys(all);
  const shownAt = all.map((_, index) => index).filter((index) => !hidden.has(keys[index]));
  const headings = shownAt.map((index) => all[index]);
  // The section being read: the last heading still in the outline at or above it
  let active = 0;
  shownAt.forEach((index, at) => {
    if (index <= activeInAll) active = at;
  });
  const hiddenCount = all.length - headings.length;

  if (!view || all.length < 2 || headings.length === 0) return null;

  // Dashes in whole screen pixels, so at 125% or 150% display scaling every
  // dash of a level is drawn alike, not some a pixel thicker than others
  const ratio = window.devicePixelRatio || 1;
  const snap = (px: number) => Math.max(1, Math.round(px * ratio)) / ratio;

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
        style={{ gap: snap(9) }}
      >
        {headings.map((heading, index) => {
          const level = Math.min(heading.displayLevel, DASH_WIDTHS.length);
          return (
            <span
              key={`${heading.from}-${index}`}
              className={`lens-outline-dash is-level-${Math.min(level, 3)}${index === active ? ' is-active' : ''}`}
              style={{
                width: snap(DASH_WIDTHS[level - 1]),
                height: snap(2),
                // A little more space above each top-level section
                marginTop: index > 0 && level === 1 ? snap(3) : undefined,
              }}
            />
          );
        })}
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
          onHide={headings.length > 1 ? (index) => hide(keys[shownAt[index]]) : undefined}
        />
        {hiddenCount > 0 && (
          <button type="button" className="lens-outline-restore" onClick={showAll}>
            Show {hiddenCount} hidden {hiddenCount === 1 ? 'heading' : 'headings'}
          </button>
        )}
      </div>
    </nav>
  );
}
