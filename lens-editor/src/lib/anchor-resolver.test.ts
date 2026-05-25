import { describe, it, expect } from 'vitest';
import type { EditorView } from '@codemirror/view';
import {
  resolveAnchorYFromView,
  resolveAnchorYFromSectionViews,
  resolveAnchorYFromDOM,
  type SectionViewEntry,
} from './anchor-resolver';

function makeView(coordsByPos: Map<number, { top: number; bottom: number }>): EditorView {
  return {
    coordsAtPos: (pos: number) => coordsByPos.get(pos) ?? null,
    scrollDOM: { getBoundingClientRect: () => ({ top: 0 }) } as Element,
  } as unknown as EditorView;
}

describe('resolveAnchorYFromView', () => {
  it('returns the top y from coordsAtPos', () => {
    const view = makeView(new Map([[42, { top: 123, bottom: 145 }]]));
    expect(resolveAnchorYFromView(view, 42)).toBe(123);
  });

  it('returns null when coordsAtPos returns null', () => {
    const view = makeView(new Map());
    expect(resolveAnchorYFromView(view, 42)).toBeNull();
  });
});

describe('resolveAnchorYFromSectionViews', () => {
  it('finds the right section and translates to local position', () => {
    const viewA = makeView(new Map([[5, { top: 100, bottom: 120 }]]));
    const viewB = makeView(new Map([[3, { top: 250, bottom: 270 }]]));
    const entries: SectionViewEntry[] = [
      { view: viewA, yTextFrom: 0,  yTextTo: 50 },
      { view: viewB, yTextFrom: 50, yTextTo: 100 },
    ];
    // Offset 53 falls in viewB; local pos = 53 - 50 = 3.
    expect(resolveAnchorYFromSectionViews(entries, 53)).toBe(250);
    // Offset 5 falls in viewA; local pos = 5.
    expect(resolveAnchorYFromSectionViews(entries, 5)).toBe(100);
  });

  it('returns null when no section owns the offset', () => {
    const viewA = makeView(new Map());
    const entries: SectionViewEntry[] = [
      { view: viewA, yTextFrom: 0, yTextTo: 50 },
    ];
    expect(resolveAnchorYFromSectionViews(entries, 999)).toBeNull();
  });
});

function makeMarker(offset: number, top: number, className: string): HTMLElement {
  const el = document.createElement('span');
  el.className = className;
  el.dataset.commentFrom = String(offset);
  el.getBoundingClientRect = () => ({
    top, bottom: top + 20, left: 0, right: 0, width: 0, height: 20, x: 0, y: top, toJSON: () => ({}),
  });
  return el;
}

describe('resolveAnchorYFromDOM', () => {
  it('returns the top y of an edit-mode badge match', () => {
    const root = document.createElement('div');
    root.appendChild(makeMarker(42, 100, 'cm-comment-badge'));
    expect(resolveAnchorYFromDOM(root, 42)).toBe(100);
  });

  it('returns the top y of a read-mode anchor match', () => {
    const root = document.createElement('div');
    root.appendChild(makeMarker(99, 250, 'cm-comment-anchor'));
    expect(resolveAnchorYFromDOM(root, 99)).toBe(250);
  });

  it('returns null when no matching element exists', () => {
    const root = document.createElement('div');
    expect(resolveAnchorYFromDOM(root, 12345)).toBeNull();
  });

  it('returns the first DOM-order match when both flavors exist for the same offset', () => {
    const root = document.createElement('div');
    root.appendChild(makeMarker(7, 50, 'cm-comment-badge'));
    root.appendChild(makeMarker(7, 200, 'cm-comment-anchor'));
    expect(resolveAnchorYFromDOM(root, 7)).toBe(50);
  });
});
