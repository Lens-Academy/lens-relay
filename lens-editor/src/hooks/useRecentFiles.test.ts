import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRecentFiles } from './useRecentFiles';

const STORAGE_KEY = 'lens-recent-files';

describe('useRecentFiles', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns empty array when no recent files', () => {
    const { result } = renderHook(() => useRecentFiles());
    expect(result.current.recentFiles).toEqual([]);
  });

  it('adds a file to recent list', () => {
    const { result } = renderHook(() => useRecentFiles());
    act(() => result.current.pushRecent('doc-1'));
    expect(result.current.recentFiles).toEqual(['doc-1']);
  });

  it('moves existing file to front on re-push', () => {
    const { result } = renderHook(() => useRecentFiles());
    act(() => result.current.pushRecent('doc-1'));
    act(() => result.current.pushRecent('doc-2'));
    act(() => result.current.pushRecent('doc-1'));
    expect(result.current.recentFiles).toEqual(['doc-1', 'doc-2']);
  });

  it('trims to maxItems', () => {
    const { result } = renderHook(() => useRecentFiles(3));
    act(() => result.current.pushRecent('a'));
    act(() => result.current.pushRecent('b'));
    act(() => result.current.pushRecent('c'));
    act(() => result.current.pushRecent('d'));
    expect(result.current.recentFiles).toEqual(['d', 'c', 'b']);
  });

  it('persists to localStorage', () => {
    const { result } = renderHook(() => useRecentFiles());
    act(() => result.current.pushRecent('doc-1'));
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored).toEqual(['doc-1']);
  });

  it('reads from localStorage on mount', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['x', 'y']));
    const { result } = renderHook(() => useRecentFiles());
    expect(result.current.recentFiles).toEqual(['x', 'y']);
  });

  it('handles corrupted localStorage gracefully', () => {
    localStorage.setItem(STORAGE_KEY, 'not-json!!!');
    const { result } = renderHook(() => useRecentFiles());
    expect(result.current.recentFiles).toEqual([]);
  });
});
