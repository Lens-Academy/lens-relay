import { describe, it, expect, vi } from 'vitest';
import {
  resolveAnchorYFromView,
  resolveAnchorYFromSectionViews,
  resolveAnchorYFromDOM,
  type SectionViewEntry,
} from './anchor-resolver';

function makeView(coordsByPos: Map<number, { top: number; bottom: number }>) {
  return {
    coordsAtPos: (pos: number) => coordsByPos.get(pos) ?? null,
    scrollDOM: { getBoundingClientRect: () => ({ top: 0 }) } as Element,
  } as const;
}

describe('resolveAnchorYFromView', () => {
  it('returns the top y from coordsAtPos', () => {
    const view = makeView(new Map([[42, { top: 123, bottom: 145 }]]));
    expect(resolveAnchorYFromView(view as any, 42)).toBe(123);
  });

  it('returns null when coordsAtPos returns null', () => {
    const view = makeView(new Map());
    expect(resolveAnchorYFromView(view as any, 42)).toBeNull();
  });
});

describe('resolveAnchorYFromSectionViews', () => {
  it('finds the right section and translates to local position', () => {
    const viewA = makeView(new Map([[5, { top: 100, bottom: 120 }]]));
    const viewB = makeView(new Map([[3, { top: 250, bottom: 270 }]]));
    const entries: SectionViewEntry[] = [
      { view: viewA as any, yTextFrom: 0,  yTextTo: 50 },
      { view: viewB as any, yTextFrom: 50, yTextTo: 100 },
    ];
    // Offset 53 falls in viewB; local pos = 53 - 50 = 3.
    expect(resolveAnchorYFromSectionViews(entries, 53)).toBe(250);
    // Offset 5 falls in viewA; local pos = 5.
    expect(resolveAnchorYFromSectionViews(entries, 5)).toBe(100);
  });

  it('returns null when no section owns the offset', () => {
    const viewA = makeView(new Map());
    const entries: SectionViewEntry[] = [
      { view: viewA as any, yTextFrom: 0, yTextTo: 50 },
    ];
    expect(resolveAnchorYFromSectionViews(entries, 999)).toBeNull();
  });
});

describe('resolveAnchorYFromDOM', () => {
  it('returns the top y of a cm-comment-badge match', () => {
    const root = document.createElement('div');
    const badge = document.createElement('span');
    badge.className = 'cm-comment-badge';
    badge.dataset.threadFrom = '42';
    badge.getBoundingClientRect = () => ({
      top: 100, bottom: 120, left: 0, right: 0, width: 0, height: 20, x: 0, y: 100, toJSON: () => ({}),
    });
    root.appendChild(badge);
    expect(resolveAnchorYFromDOM(root, 42)).toBe(100);
  });

  it('falls back to .cm-comment-anchor when no cm-comment-badge matches', () => {
    const root = document.createElement('div');
    const anchor = document.createElement('span');
    anchor.className = 'cm-comment-anchor';
    anchor.dataset.cmAbsoluteFrom = '99';
    anchor.getBoundingClientRect = () => ({
      top: 250, bottom: 270, left: 0, right: 0, width: 0, height: 20, x: 0, y: 250, toJSON: () => ({}),
    });
    root.appendChild(anchor);
    expect(resolveAnchorYFromDOM(root, 99)).toBe(250);
  });

  it('returns null when no matching element exists', () => {
    const root = document.createElement('div');
    expect(resolveAnchorYFromDOM(root, 12345)).toBeNull();
  });

  it('prefers cm-comment-badge over cm-comment-anchor when both exist', () => {
    const root = document.createElement('div');
    const badge = document.createElement('span');
    badge.className = 'cm-comment-badge';
    badge.dataset.threadFrom = '7';
    badge.getBoundingClientRect = () => ({
      top: 50, bottom: 70, left: 0, right: 0, width: 0, height: 20, x: 0, y: 50, toJSON: () => ({}),
    });
    const anchor = document.createElement('span');
    anchor.className = 'cm-comment-anchor';
    anchor.dataset.cmAbsoluteFrom = '7';
    anchor.getBoundingClientRect = () => ({
      top: 200, bottom: 220, left: 0, right: 0, width: 0, height: 20, x: 0, y: 200, toJSON: () => ({}),
    });
    root.appendChild(badge);
    root.appendChild(anchor);
    expect(resolveAnchorYFromDOM(root, 7)).toBe(50);
  });
});
