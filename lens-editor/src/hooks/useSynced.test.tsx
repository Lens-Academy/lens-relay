import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSynced } from './useSynced';

// Mock provider with controllable state and event emission
interface MockProvider {
  synced: boolean;
  listeners: Map<string, Set<(...args: unknown[]) => void>>;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  off: (event: string, handler: (...args: unknown[]) => void) => void;
  emit: (event: string) => void;
}

function createMockProvider(initialSynced = false): MockProvider {
  const provider: MockProvider = {
    synced: initialSynced,
    listeners: new Map(),
    on(event: string, handler: (...args: unknown[]) => void) {
      if (!this.listeners.has(event)) {
        this.listeners.set(event, new Set());
      }
      this.listeners.get(event)!.add(handler);
    },
    off(event: string, handler: (...args: unknown[]) => void) {
      this.listeners.get(event)?.delete(handler);
    },
    emit(event: string) {
      this.listeners.get(event)?.forEach((h) => h());
    },
  };
  return provider;
}

// Mock @y-sweet/react
let mockProvider: MockProvider;

vi.mock('@y-sweet/react', () => ({
  useYjsProvider: () => mockProvider,
}));

describe('useSynced', () => {
  beforeEach(() => {
    mockProvider = createMockProvider();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns false initially when provider is not synced', () => {
    const { result } = renderHook(() => useSynced());

    expect(result.current).toBe(false);
  });

  it('returns true immediately when provider is already synced', () => {
    mockProvider = createMockProvider(true);

    const { result } = renderHook(() => useSynced());

    expect(result.current).toBe(true);
  });

  it('transitions to true when synced event fires', () => {
    const { result } = renderHook(() => useSynced());

    expect(result.current).toBe(false);

    act(() => {
      mockProvider.emit('synced');
    });

    expect(result.current).toBe(true);
  });

  it('registers event listener on mount', () => {
    renderHook(() => useSynced());

    // Verify listener was registered
    expect(mockProvider.listeners.has('synced')).toBe(true);
    expect(mockProvider.listeners.get('synced')?.size).toBe(1);
  });

  it('unregisters event listener on unmount', () => {
    const { unmount } = renderHook(() => useSynced());

    // Verify listener exists
    expect(mockProvider.listeners.get('synced')?.size).toBe(1);

    unmount();

    // Verify listener was removed
    expect(mockProvider.listeners.get('synced')?.size).toBe(0);
  });

  it('does not react to synced events after unmount', () => {
    const { result, unmount } = renderHook(() => useSynced());

    expect(result.current).toBe(false);

    unmount();

    // This should not throw or cause any issues
    mockProvider.emit('synced');

    // Result is still false (no state update after unmount)
    expect(result.current).toBe(false);
  });

  it('stays true once synced (idempotent)', () => {
    const { result } = renderHook(() => useSynced());

    act(() => {
      mockProvider.emit('synced');
    });
    expect(result.current).toBe(true);

    // Emit again - should still be true
    act(() => {
      mockProvider.emit('synced');
    });
    expect(result.current).toBe(true);
  });
});
