import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { SNAPSHOT_TTL_MS, __embedDocsTesting } from '../../lib/embed-docs';
import { createElement, type ReactNode } from 'react';
import * as Y from 'yjs';
import { NavigationContext } from '../../contexts/NavigationContext';
import { CONCEPT_ROW_RULES } from '../../lib/concept-rows';
import { SNAPSHOT_REFRESH_MS, useConceptRows, useSnapshots } from './useConceptRows';

afterEach(() => {
  __embedDocsTesting.reset();
  vi.useRealTimers();
});

describe('useSnapshots', () => {
  it('on window focus, reads concept files again once the cached read is stale, not before', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let version = 1;
    const reader = vi.fn(async () => `text v${version}`);
    __embedDocsTesting.setReader(reader);
    const { result } = renderHook(() => useSnapshots(['c1']));
    await waitFor(() => expect(result.current.texts.get('c1')).toBe('text v1'));

    // Back to the window right away: the cached read is still fresh
    version = 2;
    act(() => { window.dispatchEvent(new Event('focus')); });
    await new Promise((r) => setTimeout(r, 20));
    expect(reader).toHaveBeenCalledTimes(1);

    // Later: a focus reads again
    vi.setSystemTime(Date.now() + SNAPSHOT_TTL_MS + 1);
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(result.current.texts.get('c1')).toBe('text v2'));
  });

  it('reads them again on a timer while open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let version = 1;
    __embedDocsTesting.setReader(async () => `text v${version}`);
    const { result } = renderHook(() => useSnapshots(['c1']));
    await waitFor(() => expect(result.current.texts.get('c1')).toBe('text v1'));

    version = 2;
    await act(async () => { await vi.advanceTimersByTimeAsync(SNAPSHOT_REFRESH_MS); });
    await waitFor(() => expect(result.current.texts.get('c1')).toBe('text v2'));
  });

  it('does not refresh while the panel is closed', async () => {
    const reader = vi.fn(async () => 'text');
    __embedDocsTesting.setReader(reader);
    const { result } = renderHook(() => useSnapshots(['c1'], false));
    await waitFor(() => expect(result.current.texts.get('c1')).toBe('text'));
    act(() => { window.dispatchEvent(new Event('focus')); });
    await new Promise((r) => setTimeout(r, 20));
    expect(reader).toHaveBeenCalledTimes(1);
  });
});

describe('useConceptRows', () => {
  it('counts unreadable concept files per target, so a lens is not left "Loading…" by its article\'s', async () => {
    const folder = new Y.Doc();
    const backlinks = folder.getMap<string[]>('backlinks_v0');
    backlinks.set('lens', ['ok']);
    backlinks.set('article', ['broken']);
    const md = (id: string) => ({ id, type: 'markdown' as const, version: 0 });
    const metadata = {
      '/Lens Edu/Concepts/Ok.md': md('ok'),
      '/Lens Edu/Concepts/Broken.md': md('broken'),
      '/Lens Edu/Lenses/L.md': md('lens'),
      '/Lens Edu/articles/a.md': md('article'),
    };
    __embedDocsTesting.setReader(async (id) => {
      if (id.endsWith('broken')) throw new Error('unreadable');
      return '## Relationships\n### [[../Lenses/L]]\n';
    });
    const wrapper = ({ children }: { children: ReactNode }) => createElement(NavigationContext.Provider, {
      value: { metadata, folderDocs: new Map([['Lens Edu', folder]]), folderNames: ['Lens Edu'], errors: new Map(), onNavigate: vi.fn(), justCreatedRef: { current: false } },
    }, children);
    const targets = ['lens', 'article'];
    const { result } = renderHook(() => useConceptRows(CONCEPT_ROW_RULES[2], targets, [], true), { wrapper });
    await waitFor(() => expect(result.current.failed).toBe(1));
    expect(result.current.failedFor('lens')).toBe(0);
    expect(result.current.failedFor('article')).toBe(1);
    expect(result.current.byTarget.get('lens')!.pending - result.current.failedFor('lens')).toBe(0);
  });
});
