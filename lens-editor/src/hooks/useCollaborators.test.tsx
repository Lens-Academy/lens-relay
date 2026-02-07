import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCollaborators } from './useCollaborators';

// Mock @y-sweet/react at module level
vi.mock('@y-sweet/react', () => ({
  useYjsProvider: vi.fn(),
  usePresence: vi.fn(),
}));

import { useYjsProvider, usePresence } from '@y-sweet/react';

// Type the mocks
const mockUseYjsProvider = useYjsProvider as ReturnType<typeof vi.fn>;
const mockUsePresence = usePresence as ReturnType<typeof vi.fn>;

describe('useCollaborators', () => {
  const selfClientId = 1;

  function createMockProvider(localState: unknown = null) {
    return {
      awareness: {
        clientID: selfClientId,
        getLocalState: () => localState,
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns default self when no user info in awareness', () => {
    mockUseYjsProvider.mockReturnValue(createMockProvider(null));
    mockUsePresence.mockReturnValue(new Map());

    const { result } = renderHook(() => useCollaborators());

    expect(result.current.self).toEqual({ name: 'You', color: '#6B7280' });
  });

  it('returns self user info from local awareness state', () => {
    const localState = { user: { name: 'Alice', color: '#FF0000' } };
    mockUseYjsProvider.mockReturnValue(createMockProvider(localState));
    mockUsePresence.mockReturnValue(new Map());

    const { result } = renderHook(() => useCollaborators());

    expect(result.current.self).toEqual({ name: 'Alice', color: '#FF0000' });
  });

  it('returns default self when localState exists but has no user', () => {
    const localState = { cursor: { anchor: 10, head: 10 } };
    mockUseYjsProvider.mockReturnValue(createMockProvider(localState));
    mockUsePresence.mockReturnValue(new Map());

    const { result } = renderHook(() => useCollaborators());

    expect(result.current.self).toEqual({ name: 'You', color: '#6B7280' });
  });

  it('returns empty others when no other clients are present', () => {
    mockUseYjsProvider.mockReturnValue(createMockProvider(null));
    mockUsePresence.mockReturnValue(new Map());

    const { result } = renderHook(() => useCollaborators());

    expect(result.current.others).toEqual([]);
  });

  it('returns other clients excluding self', () => {
    const localState = { user: { name: 'Alice', color: '#FF0000' } };
    mockUseYjsProvider.mockReturnValue(createMockProvider(localState));

    // Presence map includes self and one other
    const presenceMap = new Map([
      [selfClientId, { user: { name: 'Alice', color: '#FF0000' } }],
      [2, { user: { name: 'Bob', color: '#00FF00' } }],
    ]);
    mockUsePresence.mockReturnValue(presenceMap);

    const { result } = renderHook(() => useCollaborators());

    expect(result.current.others).toHaveLength(1);
    expect(result.current.others[0]).toEqual({
      clientId: 2,
      name: 'Bob',
      color: '#00FF00',
    });
  });

  it('handles multiple other clients', () => {
    mockUseYjsProvider.mockReturnValue(createMockProvider(null));

    const presenceMap = new Map([
      [selfClientId, { user: { name: 'Alice', color: '#FF0000' } }],
      [2, { user: { name: 'Bob', color: '#00FF00' } }],
      [3, { user: { name: 'Charlie', color: '#0000FF' } }],
    ]);
    mockUsePresence.mockReturnValue(presenceMap);

    const { result } = renderHook(() => useCollaborators());

    expect(result.current.others).toHaveLength(2);
    expect(result.current.others.map((o) => o.name)).toContain('Bob');
    expect(result.current.others.map((o) => o.name)).toContain('Charlie');
  });

  it('uses Anonymous and default color for clients without user info', () => {
    mockUseYjsProvider.mockReturnValue(createMockProvider(null));

    const presenceMap = new Map([
      [2, {}], // No user info
    ]);
    mockUsePresence.mockReturnValue(presenceMap);

    const { result } = renderHook(() => useCollaborators());

    expect(result.current.others).toHaveLength(1);
    expect(result.current.others[0]).toEqual({
      clientId: 2,
      name: 'Anonymous',
      color: '#6B7280',
    });
  });

  it('uses Anonymous for client with partial user info (missing name)', () => {
    mockUseYjsProvider.mockReturnValue(createMockProvider(null));

    const presenceMap = new Map([
      [2, { user: { color: '#AABBCC' } }], // Has color but no name
    ]);
    mockUsePresence.mockReturnValue(presenceMap);

    const { result } = renderHook(() => useCollaborators());

    expect(result.current.others[0].name).toBe('Anonymous');
    expect(result.current.others[0].color).toBe('#AABBCC');
  });

  it('uses default color for client with partial user info (missing color)', () => {
    mockUseYjsProvider.mockReturnValue(createMockProvider(null));

    const presenceMap = new Map([
      [2, { user: { name: 'NoColor' } }], // Has name but no color
    ]);
    mockUsePresence.mockReturnValue(presenceMap);

    const { result } = renderHook(() => useCollaborators());

    expect(result.current.others[0].name).toBe('NoColor');
    expect(result.current.others[0].color).toBe('#6B7280');
  });

  it('calculates totalCount as others.length + 1', () => {
    mockUseYjsProvider.mockReturnValue(createMockProvider(null));
    mockUsePresence.mockReturnValue(new Map());

    const { result } = renderHook(() => useCollaborators());

    // Just self
    expect(result.current.totalCount).toBe(1);
  });

  it('calculates totalCount correctly with other clients', () => {
    mockUseYjsProvider.mockReturnValue(createMockProvider(null));

    const presenceMap = new Map([
      [selfClientId, {}],
      [2, { user: { name: 'Bob', color: '#00FF00' } }],
      [3, { user: { name: 'Charlie', color: '#0000FF' } }],
    ]);
    mockUsePresence.mockReturnValue(presenceMap);

    const { result } = renderHook(() => useCollaborators());

    // Self + 2 others = 3
    expect(result.current.totalCount).toBe(3);
  });
});
