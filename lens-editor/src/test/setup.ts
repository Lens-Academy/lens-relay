import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// Clear mocks between tests
beforeEach(() => {
  vi.clearAllMocks();
});

// Note: happy-dom has limitations with:
// - Real CSS layout calculations
// - Full DOM coordinate APIs (view.coordsAtPos may not work)
// - Some newer Web APIs
// For coordinate-based tests, consider using real browser testing.
