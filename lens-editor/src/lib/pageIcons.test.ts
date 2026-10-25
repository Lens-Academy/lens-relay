import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import * as Y from 'yjs';
import type { FolderMetadata } from '../hooks/useFolderMetadata';
import { breadcrumbIcons, recordPageIcon, usePageIcons } from './pageIcons';

describe('page icons', () => {
  it('gathers the icons recorded in each folder, and follows changes', () => {
    const lens = new Y.Doc();
    const edu = new Y.Doc();
    recordPageIcon(lens, 'a', '🎯');
    const folders = new Map([['Lens', lens], ['Lens Edu', edu]]);
    const { result } = renderHook(() => usePageIcons(folders));
    expect([...result.current]).toEqual([['a', '🎯']]);

    act(() => recordPageIcon(edu, 'b', '📚'));
    expect(result.current.get('b')).toBe('📚');
    act(() => recordPageIcon(lens, 'a', null));
    expect(result.current.has('a')).toBe(false);
  });

  it('settles when given a new Map of the same folders on every render', () => {
    const lens = new Y.Doc();
    let renders = 0;
    renderHook(() => {
      renders++;
      return usePageIcons(new Map([['Lens', lens]]));
    });
    expect(renders).toBeLessThan(5);
  });

  it("gives a breadcrumb each folder's \"00 - Start Here\" icon, then the page's", () => {
    const metadata: FolderMetadata = {
      '/Lens': { id: 'root', type: 'folder', version: 0 },
      '/Lens/01-Strategy': { id: 'folder', type: 'folder', version: 0 },
      '/Lens/01-Strategy/00 - Start Here.md': { id: 'start', type: 'markdown', version: 0 },
      '/Lens/01-Strategy/OKRs.md': { id: 'page', type: 'markdown', version: 0 },
    };
    const icons = new Map([['start', '🧭'], ['page', '🎯']]);
    expect(breadcrumbIcons('/Lens/01-Strategy/OKRs.md', metadata, icons)).toEqual([undefined, '🧭', '🎯']);
  });
});
