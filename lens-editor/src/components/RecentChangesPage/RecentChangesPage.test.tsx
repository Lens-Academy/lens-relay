/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ActivityEvent, FileActivity } from '../../hooks/useRecentChanges';

const now = Date.now();

function event(id: string, ts: number, actor = 'ai:fable-5:luc'): ActivityEvent {
  return {
    id, ts, actor, author: "Luc's AI", mode: 'direct', kind: 'insert', old: '', new: 'x',
    old_truncated: false, new_truncated: false, ctx_before: '', ctx_after: '', pos: 0,
    client: 1, clock_from: 0, clock_to: 1, anchor: null,
  };
}

function file(docId: string, events: ActivityEvent[], excerptCount = 0): FileActivity {
  return {
    path: `/${docId}.md`,
    doc_id: `relay-${docId}`,
    folder_id: 'f1',
    events,
    excerpts: Array.from({ length: excerptCount }, (_, i) => ({
      pos: i * 100, line: i + 1, skipped_before: 0, skipped_after: 0,
      segments: [
        { kind: 'text' as const, text: `ctx ${i} ` },
        { kind: 'insert' as const, text: `ins ${i}`, event_id: events[0].id },
      ],
    })),
  };
}

const state = { data: [] as FileActivity[], fetchedAt: now };
vi.mock('../../hooks/useRecentChanges', () => ({
  useRecentChanges: () => ({ data: state.data, fetchedAt: state.fetchedAt, loading: false, error: null, truncated: false, refresh: vi.fn() }),
}));

const { RecentChangesPage } = await import('./RecentChangesPage');
const { fileSectionRenders } = await import('./renderCounts');

function renderPage() {
  return render(
    <MemoryRouter>
      <RecentChangesPage folderIds={['f1']} folders={[{ id: 'f1', name: 'Lens' }]} />
    </MemoryRouter>,
  );
}

describe('RecentChangesPage', () => {
  it('caps rendered excerpts per file with a "Show more" button', () => {
    state.data = [file('a', [event('a1', now - 1000)], 40)];
    renderPage();
    expect(screen.getAllByText(/^ins \d+$/)).toHaveLength(25);
    fireEvent.click(screen.getByText('Show 15 more'));
    expect(screen.getAllByText(/^ins \d+$/)).toHaveLength(40);
  });

  it('keeps files whose visible set is unchanged out of re-renders when a filter moves', async () => {
    // Narrowing 24h → 5m drops A's older event but leaves B's visible set
    // identical, so B's section must not render again.
    state.data = [
      file('a', [event('a1', now - 1000), event('a2', now - 3 * 3600_000)]),
      file('b', [event('b1', now - 2000)]),
    ];
    fileSectionRenders.clear();
    renderPage();
    fireEvent.click(screen.getByText('Expand all'));
    expect(screen.getAllByText('Added')).toHaveLength(3);
    const bBefore = fileSectionRenders.get('relay-b')!;
    expect(bBefore).toBeGreaterThan(0);

    await act(async () => {
      fireEvent.click(screen.getByText('5m'));
    });
    expect(screen.getAllByText('Added')).toHaveLength(2);
    expect(fileSectionRenders.get('relay-b')).toBe(bBefore);
    expect(fileSectionRenders.get('relay-a')).toBeGreaterThan(1);
  });
});
