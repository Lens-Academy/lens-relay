import { describe, it, expect } from 'vitest';
import { isQuickSwitcherKey } from './quick-switcher-key';

const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { cancelable: true, ...init });

describe('isQuickSwitcherKey', () => {
  it('accepts Ctrl/Cmd+K and Ctrl/Cmd+O', () => {
    expect(isQuickSwitcherKey(key({ key: 'k', ctrlKey: true }))).toBe(true);
    expect(isQuickSwitcherKey(key({ key: 'k', metaKey: true }))).toBe(true);
    expect(isQuickSwitcherKey(key({ key: 'o', ctrlKey: true }))).toBe(true);
    expect(isQuickSwitcherKey(key({ key: 'O', metaKey: true }))).toBe(true);
  });

  it('ignores the plain letters and other shortcuts', () => {
    expect(isQuickSwitcherKey(key({ key: 'k' }))).toBe(false);
    expect(isQuickSwitcherKey(key({ key: 'p', ctrlKey: true }))).toBe(false);
  });

  it('leaves Cmd+Shift+K (delete line) and Alt combinations to the editor', () => {
    // Mac reports e.key 'k' for Cmd+Shift+K
    expect(isQuickSwitcherKey(key({ key: 'k', metaKey: true, shiftKey: true }))).toBe(false);
    expect(isQuickSwitcherKey(key({ key: 'K', ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isQuickSwitcherKey(key({ key: 'k', ctrlKey: true, altKey: true }))).toBe(false);
  });

  it('ignores a key the editor already handled', () => {
    const e = key({ key: 'k', ctrlKey: true });
    e.preventDefault();
    expect(isQuickSwitcherKey(e)).toBe(false);
  });
});
