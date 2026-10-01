import { act, renderHook } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { useSyncMarker } from './useSyncMarker';

const synced = [
  '---',
  'title: "Chapter 1"',
  'synced_from:',
  '  source: "google-doc"',
  '  url: "https://docs.google.com/document/d/abc/edit"',
  '---',
  '',
  'Body',
].join('\n');

describe('useSyncMarker', () => {
  it('reads the marker, keeps it stable while typing, and drops it when removed', () => {
    const doc = new Y.Doc();
    const text = doc.getText('contents');
    text.insert(0, synced);

    const { result } = renderHook(() => useSyncMarker(doc));
    const first = result.current;
    expect(first).toEqual({ source: 'google-doc', url: 'https://docs.google.com/document/d/abc/edit' });

    act(() => text.insert(text.length, ' more'));
    expect(result.current).toBe(first);

    act(() => {
      text.delete(0, text.length);
      text.insert(0, '---\ntitle: "Plain"\n---\n\nBody');
    });
    expect(result.current).toBeNull();
  });

  it('ignores files without a complete marker', () => {
    const doc = new Y.Doc();
    doc.getText('contents').insert(0, '---\nsynced_from: "google-doc"\n---\n');
    expect(renderHook(() => useSyncMarker(doc)).result.current).toBeNull();
    expect(renderHook(() => useSyncMarker(null)).result.current).toBeNull();
  });
});

describe('useSyncMarker when the doc syncs in late', () => {
  it('sees text that arrives between the first render and subscribing', () => {
    const doc = new Y.Doc();
    const { result } = renderHook(() => {
      const marker = useSyncMarker(doc);
      // Layout effects run after render but before the store subscribes (a passive effect).
      useLayoutEffect(() => {
        doc.getText('contents').insert(0, synced);
      }, []);
      return marker;
    });
    expect(result.current).toEqual({ source: 'google-doc', url: 'https://docs.google.com/document/d/abc/edit' });
  });
});
