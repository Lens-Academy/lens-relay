import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import {
  renderMarkdownWithCriticMarkup,
  renderHeadingWithCriticMarkup,
  buildGlobalCommentBadgeMap,
  sliceCommentBadgeMap,
} from './criticmarkup-render';

describe('renderMarkdownWithCriticMarkup', () => {
  it('renders plain markdown unchanged when no criticmarkup is present', () => {
    const { container } = render(<>{renderMarkdownWithCriticMarkup('Hello **world**.')}</>);
    expect(container.textContent).toContain('Hello');
    expect(container.textContent).toContain('world');
    expect(container.querySelector('strong')).not.toBeNull();
  });

  it('wraps additions in an <ins> with the cm-addition class', () => {
    const { container } = render(<>{renderMarkdownWithCriticMarkup('Before {++added++} after.')}</>);
    const ins = container.querySelector('ins.cm-addition');
    expect(ins).not.toBeNull();
    expect(ins?.textContent).toContain('added');
  });

  it('keeps inline additions in the same paragraph flow', () => {
    const { container } = render(<>{renderMarkdownWithCriticMarkup('Before {++added++} after.')}</>);

    expect(container.querySelector('p')).toBeNull();
    expect(container.innerHTML).toMatch(/^Before\s*<ins[\s\S]*<\/ins>\s*after\.$/);
  });

  it('wraps deletions in a <del> with the cm-deletion class', () => {
    const { container } = render(<>{renderMarkdownWithCriticMarkup('Before {--removed--} after.')}</>);
    const del = container.querySelector('del.cm-deletion');
    expect(del).not.toBeNull();
    expect(del?.textContent).toContain('removed');
  });

  it('renders comments as a discreet anchor marker, not inline content', () => {
    const text = 'Body. {>>a comment<<}';
    const { container } = render(<>{renderMarkdownWithCriticMarkup(text)}</>);
    const anchor = container.querySelector('.cm-comment-anchor');
    expect(anchor).not.toBeNull();
    // The anchor renders an emoji marker, not the comment text.
    expect(container.textContent).not.toContain('a comment');
  });

  it('emits substitution as old struck-through and new inserted', () => {
    const { container } = render(<>{renderMarkdownWithCriticMarkup('Try {~~old~>new~~} value.')}</>);
    expect(container.querySelector('.cm-substitution')).not.toBeNull();
    expect(container.querySelector('.cm-substitution del')?.textContent).toContain('old');
    expect(container.querySelector('.cm-substitution ins')?.textContent).toContain('new');
  });

  it('passes onClickRange through to criticmarkup spans', () => {
    let clickedFrom: number | null = null;
    const { container } = render(
      <>
        {renderMarkdownWithCriticMarkup('Hi {++added++} there.', {
          onClickRange: (range) => {
            clickedFrom = range.from;
          },
        })}
      </>
    );
    const ins = container.querySelector('ins.cm-addition') as HTMLElement;
    ins.click();
    expect(clickedFrom).not.toBeNull();
  });
});

describe('renderHeadingWithCriticMarkup', () => {
  it('does not emit block elements (paragraphs)', () => {
    const { container } = render(<>{renderHeadingWithCriticMarkup('Section title')}</>);
    expect(container.querySelector('p')).toBeNull();
    expect(container.textContent).toContain('Section title');
  });

  it('renders criticmarkup additions inline inside heading text', () => {
    const { container } = render(<>{renderHeadingWithCriticMarkup('Title {++with addition++}')}</>);
    expect(container.querySelector('ins.cm-addition')).not.toBeNull();
  });
});

describe('buildGlobalCommentBadgeMap', () => {
  it('returns an empty map when there are no comments', () => {
    const map = buildGlobalCommentBadgeMap('Just plain prose, no comments here.');
    expect(map.size).toBe(0);
  });

  it('numbers threads sequentially starting at 1', () => {
    const text =
      'Para. {>>{"author":"a","timestamp":1}@@first<<} more {>>{"author":"a","timestamp":2}@@second<<} end.';
    const map = buildGlobalCommentBadgeMap(text);
    const numbers = Array.from(map.values()).map(v => v.badgeNumber);
    expect(new Set(numbers)).toEqual(new Set([1, 2]));
  });

  it('marks replies (non-first comments in a thread) as not-first', () => {
    const text =
      'Body {>>{"author":"a","timestamp":1}@@root<<}{>>{"author":"b","timestamp":2}@@reply<<} done.';
    const map = buildGlobalCommentBadgeMap(text);
    const entries = Array.from(map.values());
    expect(entries).toHaveLength(2);
    expect(entries.filter(e => e.isFirstInThread)).toHaveLength(1);
    expect(entries.filter(e => !e.isFirstInThread)).toHaveLength(1);
    // Both are part of the same (single) thread → both badge 1.
    expect(entries.every(e => e.badgeNumber === 1)).toBe(true);
  });
});

describe('sliceCommentBadgeMap', () => {
  it('translates absolute keys to local positions and drops out-of-range entries', () => {
    const global = new Map([
      [10, { badgeNumber: 1, isFirstInThread: true, absoluteFrom: 10 }],
      [50, { badgeNumber: 2, isFirstInThread: true, absoluteFrom: 50 }],
      [80, { badgeNumber: 3, isFirstInThread: true, absoluteFrom: 80 }],
    ]);
    const local = sliceCommentBadgeMap(global, 40, 30); // window: [40, 70)
    expect(local.size).toBe(1);
    // 50 - 40 = 10
    expect(local.get(10)?.badgeNumber).toBe(2);
    // absoluteFrom is preserved through the slice
    expect(local.get(10)?.absoluteFrom).toBe(50);
  });
});

describe('renderMarkdownWithCriticMarkup with badge map', () => {
  it('shows the badge number from the map instead of the emoji', () => {
    const { container } = render(
      <>
        {renderMarkdownWithCriticMarkup('Hi {>>my note<<} there.', {
          commentBadgeMap: new Map([
            [3, { badgeNumber: 7, isFirstInThread: true, absoluteFrom: 103 }],
          ]),
        })}
      </>
    );
    const anchor = container.querySelector('.cm-comment-anchor');
    expect(anchor?.textContent).toBe('7');
    expect(anchor?.getAttribute('data-cm-comment-number')).toBe('7');
  });

  it('hides reply comments (non-first in thread) entirely from the prose', () => {
    const text = 'Body {>>root<<}{>>reply<<} done.';
    const { container } = render(
      <>
        {renderMarkdownWithCriticMarkup(text, {
          commentBadgeMap: new Map([
            [5, { badgeNumber: 1, isFirstInThread: true, absoluteFrom: 105 }],
            [15, { badgeNumber: 1, isFirstInThread: false, absoluteFrom: 115 }],
          ]),
        })}
      </>
    );
    const anchors = container.querySelectorAll('.cm-comment-anchor');
    // Exactly one anchor visible (the root); the reply is hidden.
    expect(anchors.length).toBe(1);
  });

  it('fires onClickRange with absolute positions for comment ranges', () => {
    let received: { from: number; to: number; type: string } | null = null;
    const { container } = render(
      <>
        {renderMarkdownWithCriticMarkup('Hi {>>note<<} there.', {
          commentBadgeMap: new Map([
            // Local key: 3 (`{>>` starts at index 3 of 'Hi {>>note<<} there.').
            // Absolute Y.Text position the doc-level parse would have seen: 1003.
            [3, { badgeNumber: 1, isFirstInThread: true, absoluteFrom: 1003 }],
          ]),
          onClickRange: (range) => {
            received = { from: range.from, to: range.to, type: range.type };
          },
        })}
      </>
    );
    const anchor = container.querySelector('.cm-comment-anchor') as HTMLElement;
    anchor.click();
    expect(received).not.toBeNull();
    expect(received!.type).toBe('comment');
    // The renderer parses local positions (range.from = 3) but uses
    // absoluteFrom from the badge map when bubbling the click. Sidebar
    // matches on this absolute value.
    expect(received!.from).toBe(1003);
    // `to` is rewritten by the same delta so range width is preserved.
    expect(received!.to - received!.from).toBe('{>>note<<}'.length);
  });

  it('falls back to range.from when no badge info is supplied (non-comment range)', () => {
    let received: { from: number; type: string } | null = null;
    const { container } = render(
      <>
        {renderMarkdownWithCriticMarkup('Try {++added++} thanks.', {
          onClickRange: (range) => {
            received = { from: range.from, type: range.type };
          },
        })}
      </>
    );
    const ins = container.querySelector('ins.cm-addition') as HTMLElement;
    ins.click();
    expect(received?.type).toBe('addition');
    // Local position: '{++' starts at index 4.
    expect(received?.from).toBe(4);
  });
});
