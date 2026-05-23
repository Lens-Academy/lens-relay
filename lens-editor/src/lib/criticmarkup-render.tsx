import { Fragment, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import { parse, parseThreads, type CriticMarkupRange } from './criticmarkup-parser';

/**
 * Inline-mode react-markdown wrapper. Strips paragraph wrapping so we can
 * place the result inline alongside other criticmarkup spans without breaking
 * the source flow.
 */
function InlineMarkdown({ source }: { source: string }) {
  if (!source) return null;
  return (
    <ReactMarkdown
      remarkPlugins={[remarkBreaks]}
      components={{
        p: ({ children }) => <>{children}</>,
      }}
    >
      {source}
    </ReactMarkdown>
  );
}

/**
 * Block-mode react-markdown wrapper used for "outer" text segments where
 * paragraph and list semantics matter.
 */
function BlockMarkdown({ source }: { source: string }) {
  if (!source) return null;
  return (
    <ReactMarkdown remarkPlugins={[remarkBreaks]}>{source}</ReactMarkdown>
  );
}

interface CriticMarkupSpanProps {
  range: CriticMarkupRange;
  /** The thread's display number, e.g. 1, 2, 3 — only meaningful for comment
   *  ranges that are the first comment in their thread. */
  badgeNumber?: number;
  /** True for the first comment in a thread (anchor); false for replies (which
   *  are hidden in the inline view since they live in the sidebar). */
  isFirstInThread?: boolean;
  /** Absolute Y.Text position of this range. When present, used in place of
   *  the local `range.from` when invoking `onClickRange` so callers receive
   *  positions consistent with the document-wide thread list. */
  absoluteFrom?: number;
  /**
   * When provided, called with the range's source position so callers (e.g.
   * the comments sidebar) can react to a click. Optional.
   */
  onClickRange?: (range: CriticMarkupRange) => void;
}

/**
 * Render a single criticmarkup range as styled inline content. Inner text is
 * still passed through markdown so simple inline formatting (**bold**, etc.)
 * inside an addition/substitution survives.
 */
function CriticMarkupSpan({
  range,
  badgeNumber,
  isFirstInThread,
  absoluteFrom,
  onClickRange,
}: CriticMarkupSpanProps) {
  // For comment ranges, the parent provides the range's absolute Y.Text
  // position (via the badge map). We rewrite the range we hand to
  // onClickRange so callers — most notably the EduEditor sidebar — can
  // match against absolute positions without the renderer or any
  // intermediate component doing position math (which is fragile when
  // intermediate components clean the source via parseFields, etc.).
  const handleClick = onClickRange
    ? () => {
        if (range.type === 'comment' && absoluteFrom != null) {
          const delta = absoluteFrom - range.from;
          onClickRange({
            ...range,
            from: absoluteFrom,
            to: range.to + delta,
            contentFrom: range.contentFrom + delta,
            contentTo: range.contentTo + delta,
          });
        } else {
          onClickRange(range);
        }
      }
    : undefined;
  const author = range.metadata?.author;
  const title = author ? `${range.type} by ${author}` : range.type;

  switch (range.type) {
    case 'addition':
      return (
        <ins
          className="cm-addition bg-green-100 text-green-900 no-underline px-0.5 rounded"
          title={title}
          onClick={handleClick}
          data-cm-from={range.from}
          data-cm-to={range.to}
        >
          <InlineMarkdown source={range.content} />
        </ins>
      );
    case 'deletion':
      return (
        <del
          className="cm-deletion bg-red-100 text-red-900 line-through px-0.5 rounded"
          title={title}
          onClick={handleClick}
          data-cm-from={range.from}
          data-cm-to={range.to}
        >
          <InlineMarkdown source={range.content} />
        </del>
      );
    case 'substitution':
      return (
        <span
          className="cm-substitution"
          title={title}
          onClick={handleClick}
          data-cm-from={range.from}
          data-cm-to={range.to}
        >
          <del className="bg-red-100 text-red-900 line-through px-0.5 rounded">
            <InlineMarkdown source={range.oldContent ?? ''} />
          </del>
          <ins className="bg-green-100 text-green-900 no-underline px-0.5 rounded ml-0.5">
            <InlineMarkdown source={range.newContent ?? ''} />
          </ins>
        </span>
      );
    case 'highlight':
      return (
        <mark
          className="cm-highlight bg-yellow-100 text-yellow-900 px-0.5 rounded"
          title={title}
          onClick={handleClick}
          data-cm-from={range.from}
          data-cm-to={range.to}
        >
          <InlineMarkdown source={range.content} />
        </mark>
      );
    case 'comment': {
      // Replies (non-first comments in their thread) are not rendered inline —
      // they live in the sidebar so the prose isn't cluttered with duplicate
      // markers for the same thread.
      if (isFirstInThread === false) {
        return null;
      }
      const label = badgeNumber != null ? String(badgeNumber) : '\u{1F4AC}';
      return (
        <span
          className="cm-comment-anchor inline-flex items-center justify-center align-baseline mx-0.5 px-1.5 min-w-4.5 h-4.5 rounded-full bg-blue-100 text-blue-700 text-[10px] font-semibold cursor-pointer select-none hover:bg-blue-200"
          title={author ? `Comment by ${author}` : 'Comment'}
          onClick={handleClick}
          data-cm-from={range.from}
          data-cm-to={range.to}
          data-cm-absolute-from={absoluteFrom}
          data-cm-comment-number={badgeNumber}
        >
          {label}
        </span>
      );
    }
    default:
      return <Fragment>{range.content}</Fragment>;
  }
}

export interface CommentBadgeInfo {
  badgeNumber: number;
  isFirstInThread: boolean;
  /** Absolute Y.Text position of this comment range, copied from the global
   *  badge map so callers can match against `thread.comments[i].from` even
   *  when the renderer parses a section-local string whose positions are
   *  decoupled from the source (e.g. content fields cleaned by parseFields). */
  absoluteFrom: number;
}

interface RenderOpts {
  onClickRange?: (range: CriticMarkupRange) => void;
  /**
   * Pre-computed badge info keyed by LOCAL `range.from` (i.e. position in
   * the `source` string passed to this function). Authored by the caller so
   * numbering can stay consistent with a document-wide thread list — the
   * caller computes thread numbers from the full Y.Text, then translates the
   * map's keys to local source positions for each section. When omitted,
   * comments fall back to a generic 💬 marker.
   */
  commentBadgeMap?: Map<number, CommentBadgeInfo>;
}

/**
 * Build a document-wide badge map keyed by ABSOLUTE Y.Text positions. Used by
 * ContentPanel to compute one numbering for the whole document, then
 * translate per-section.
 */
export function buildGlobalCommentBadgeMap(
  documentText: string
): Map<number, CommentBadgeInfo> {
  const map = new Map<number, CommentBadgeInfo>();
  const ranges = parse(documentText);
  const threads = parseThreads(ranges);
  for (let ti = 0; ti < threads.length; ti++) {
    const thread = threads[ti];
    for (let ci = 0; ci < thread.comments.length; ci++) {
      const absoluteFrom = thread.comments[ci].from;
      map.set(absoluteFrom, {
        badgeNumber: ti + 1,
        isFirstInThread: ci === 0,
        absoluteFrom,
      });
    }
  }
  return map;
}

/**
 * Translate a slice of a global badge map (keyed by absolute positions) into
 * a local badge map (keyed by positions relative to `localStart`). Entries
 * outside [localStart, localStart + localLength) are dropped.
 */
export function sliceCommentBadgeMap(
  globalMap: Map<number, CommentBadgeInfo>,
  localStart: number,
  localLength: number
): Map<number, CommentBadgeInfo> {
  const out = new Map<number, CommentBadgeInfo>();
  const localEnd = localStart + localLength;
  for (const [absFrom, info] of globalMap) {
    if (absFrom >= localStart && absFrom < localEnd) {
      out.set(absFrom - localStart, info);
    }
  }
  return out;
}

/**
 * Render a markdown source string with criticmarkup ranges visualized inline.
 * Plain segments around the criticmarkup ranges are rendered inline so
 * criticmarkup in the middle of a sentence does not split the sentence into
 * separate paragraphs.
 *
 * Limitation: a criticmarkup range that spans multiple block boundaries
 * (rare in practice) will not preserve flow across the boundary. Authors
 * should keep individual criticmarkup spans inline where possible.
 */
export function renderMarkdownWithCriticMarkup(
  source: string,
  opts: RenderOpts = {}
): ReactNode {
  const ranges = [...parse(source)].sort((a, b) => a.from - b.from);
  if (ranges.length === 0) {
    return <BlockMarkdown source={source} />;
  }

  const badgeMap = opts.commentBadgeMap;

  const nodes: ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  for (const range of ranges) {
    const badge = badgeMap?.get(range.from);
    // Skip non-first comments entirely — including their source slice — so
    // they don't leave residual whitespace gaps in the rendered prose. Replies
    // are visible only in the sidebar.
    if (range.type === 'comment' && badge && !badge.isFirstInThread) {
      cursor = range.to;
      continue;
    }
    if (range.from > cursor) {
      const plain = source.slice(cursor, range.from);
      nodes.push(<InlineMarkdown key={`p-${key++}`} source={plain} />);
    }
    nodes.push(
      <CriticMarkupSpan
        key={`r-${key++}`}
        range={range}
        badgeNumber={badge?.badgeNumber}
        isFirstInThread={badge?.isFirstInThread}
        absoluteFrom={badge?.absoluteFrom}
        onClickRange={opts.onClickRange}
      />
    );
    cursor = range.to;
  }
  if (cursor < source.length) {
    const plain = source.slice(cursor);
    nodes.push(<InlineMarkdown key={`p-${key++}`} source={plain} />);
  }

  return <>{nodes}</>;
}

/**
 * Render a heading source string with criticmarkup. Inline-only — never
 * emits block elements. Used by HeadingRenderer where the host element
 * (h1–h6 from the renderer) already supplies the block context.
 */
export function renderHeadingWithCriticMarkup(
  source: string,
  opts: RenderOpts = {}
): ReactNode {
  const ranges = [...parse(source)].sort((a, b) => a.from - b.from);
  if (ranges.length === 0) {
    return <InlineMarkdown source={source} />;
  }

  const badgeMap = opts.commentBadgeMap;

  const nodes: ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  for (const range of ranges) {
    const badge = badgeMap?.get(range.from);
    if (range.type === 'comment' && badge && !badge.isFirstInThread) {
      cursor = range.to;
      continue;
    }
    if (range.from > cursor) {
      nodes.push(<InlineMarkdown key={`p-${key++}`} source={source.slice(cursor, range.from)} />);
    }
    nodes.push(
      <CriticMarkupSpan
        key={`r-${key++}`}
        range={range}
        badgeNumber={badge?.badgeNumber}
        isFirstInThread={badge?.isFirstInThread}
        absoluteFrom={badge?.absoluteFrom}
        onClickRange={opts.onClickRange}
      />
    );
    cursor = range.to;
  }
  if (cursor < source.length) {
    nodes.push(<InlineMarkdown key={`p-${key++}`} source={source.slice(cursor)} />);
  }

  return <>{nodes}</>;
}
